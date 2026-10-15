/**
 * File: scripts/test-reports.js
 * Purpose: Pin down the Analytics & Reports additions — the User registry and the
 * fields its summary table counts by, the Student progress comparison and its
 * pivot of averages, the CSV files, every tab's own filters (and the bar each one
 * renders), who is weak in each weak topic, the Payment Collection report the
 * Payment collection tab shares with its page — and the in-memory list filters
 * the monitoring pages share (with the tutor's Attendance Logs filter bar, rendered).
 *
 * Run:  node scripts/test-reports.js      (needs no database, no keys)
 *
 * config/db is replaced in the require cache before lib/analytics.js loads, so the
 * real code runs against a scripted database, and the SQL it sends can be read.
 */

let failures = 0;
const ok = (label, condition, extra = '') => {
  if (condition) console.log(`  PASS  ${label}${extra ? ' — ' + extra : ''}`);
  else { failures++; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
};

// ---------------------------------------------------------------- scripted database
const calls = [];
let script = { users: [], enrolments: [], progress: [], modules: [], reads: [] };

function runSql(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  calls.push({ sql, params });
  if (/FROM users u LEFT JOIN branches br ON br\.id = COALESCE\(u\.assistant_scope_branch_id, u\.branch_id\)/i.test(sql)) return script.users;
  if (/FROM user_subject_assignments usa JOIN subjects s ON s\.id = usa\.subject_id WHERE usa\.is_archived = 0 ORDER BY s\.name/i.test(sql)) return script.enrolments;
  if (/OUTER APPLY/i.test(sql) && /FROM user_subject_assignments usa/i.test(sql)) return script.progress;
  if (/FROM modules WHERE is_archived = 0 AND subject_id IN/i.test(sql)) return script.modules;
  if (/FROM student_module_reads/i.test(sql)) return script.reads;
  if (/GROUP BY ta\.subject_id, q\.source_module_id, h\.file_original_name, sub\.student_id/i.test(sql)) return script.weakLearners || [];
  if (/COUNT\(DISTINCT sub\.student_id\) AS student_count/i.test(sql)) return script.weakTopics || [];
  return [];
}

const dbPath = require.resolve('../config/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    sql: {}, baseConfig: {},
    getPool: async () => { throw new Error('the test must never open a connection'); },
    query: async (text, params = []) => runSql(text, params),
    withTransaction: async (work) => work({ query: async (text, params = []) => [runSql(text, params)] })
  }
};

const {
  buildAveragePivot, getUserRegistry, getProgressComparison, buildProgressSummary, PROGRESS_STATUS,
  getWeakTopicLearners, getAnalyticsDashboard
} = require('../lib/analytics');
const af = require('../lib/analyticsFilters');
const { csvCell, toCsv, registryCsv, progressCsv } = require('../lib/reportsCsv');
const {
  matchesSearch, withinDates, cleanDate, cleanId
} = require('../lib/listFilters');

const staff = (extra = {}) => ({ role: 'admin', isAdmin: true, isAssistant: false, isTutor: false, isStudent: false, branchId: null, userId: 1, ...extra });
const assistant = () => ({ role: 'admin_assistant', isAdmin: false, isAssistant: true, isTutor: false, isStudent: false, branchId: 2, userId: 5 });
const tutor = () => ({ role: 'tutor', isAdmin: false, isAssistant: false, isTutor: true, isStudent: false, branchId: 1, userId: 9 });
const learner = () => ({ role: 'student', isAdmin: false, isAssistant: false, isTutor: false, isStudent: true, branchId: 1, userId: 11 });

const user = (over) => ({
  id: 1, user_id: 'X-1', role: 'student', status: 'approved', is_archived: 0, first_name: 'maria', middle_name: '', last_name: 'santos',
  email: 'maria@gmail.com', contact_number: '0917', gender: 'Female', year_level: 'Primary Level', grade_level: 'Grade 4',
  subjects_json: null, created_at: new Date('2026-01-05T00:00:00Z'), accepted_at: null, branch_id: 1, branch_name: 'Main Branch', ...over
});

(async () => {
  console.log('\n== a pivot of averages keeps "no change" apart from "nothing" ==');
  const rows = [
    { branch: 'Main', subject: 'ENGLISH', change: 30 }, { branch: 'Main', subject: 'ENGLISH', change: 0 },
    { branch: 'Main', subject: 'FILIPINO', change: -10 }, { branch: 'Fatima', subject: 'ENGLISH', change: 0 }
  ];
  const avg = buildAveragePivot(rows, { rowOf: (r) => r.branch, colOf: (r) => r.subject, measureOf: (r) => r.change });
  const fatima = avg.rows.find((row) => row.label === 'Fatima');
  ok('a real average of 0 is 0', fatima.counts[avg.columns.indexOf('ENGLISH')] === 0);
  ok('a cell nobody fills is null, not 0', fatima.counts[avg.columns.indexOf('FILIPINO')] === null);
  ok('a row total averages everything in the row', avg.rows.find((row) => row.label === 'Main').total === 6.7, String(avg.rows.find((row) => row.label === 'Main').total));
  ok('the grand average is over every learner, not over the cell averages', avg.grand === 5, String(avg.grand));

  console.log('\n== the registry lists everyone the viewer may see ==');
  script.users = [
    user({ id: 1, user_id: 'ADM-1', role: 'admin', first_name: 'system', last_name: 'admin', branch_id: null, branch_name: null, email: 'admin@x' }),
    user({ id: 2, user_id: 'AST-2', role: 'admin_assistant', first_name: 'ana', last_name: 'cruz', branch_id: 2, branch_name: 'Fatima Branch', year_level: '', grade_level: '' }),
    user({ id: 3, user_id: 'TTR-3', role: 'tutor', first_name: 'ben', last_name: 'reyes', subjects_json: '["ENGLISH","FILIPINO"]', year_level: 'Primary School, Junior High School', grade_level: '' }),
    user({ id: 4, user_id: 'STD-4', role: 'student', first_name: 'maria', last_name: 'santos' }),
    user({ id: 5, user_id: 'STD-5', role: 'student', first_name: 'jose', last_name: 'reyes', is_archived: 1, grade_level: 'Grade 8', year_level: 'Junior High Level', branch_id: 2, branch_name: 'Fatima Branch' }),
    user({ id: 6, user_id: 'STD-6', role: 'student', first_name: 'lea', last_name: 'cruz', status: 'pending', grade_level: '', year_level: '' })
  ];
  script.enrolments = [{ student_id: 4, subject_name: 'ENGLISH' }, { student_id: 4, subject_name: 'FILIPINO' }, { student_id: 5, subject_name: 'ENGLISH' }];

  calls.length = 0;
  let registry = await getUserRegistry(staff(), {});
  ok('the main admin sees every role, the admin account too', registry.everyone.length === 6 && registry.everyone[0].role === 'admin');
  ok('it asked for every branch (no branch clause)', !/COALESCE\(u\.assistant_scope_branch_id, u\.branch_id\) = \?/.test(calls[0].sql));
  const maria = registry.rows.find((row) => row.user_id === 'STD-4');
  ok('a learner\'s subjects are the ones they are enrolled in', maria.subjects.join() === 'ENGLISH,FILIPINO');
  ok('a learner\'s level is their grade', maria.level === 'Grade 4');
  const ben = registry.rows.find((row) => row.user_id === 'TTR-3');
  ok('a tutor\'s subjects are the ones they teach', ben.subjects.join() === 'ENGLISH,FILIPINO', ben.subjects.join());
  ok('names are in title case', maria.name === 'Maria Santos' && ben.name === 'Ben Reyes');
  ok('an archived account says so', registry.rows.find((row) => row.user_id === 'STD-5').status === 'Archived');
  ok('a pending one stays pending', registry.rows.find((row) => row.user_id === 'STD-6').status === 'Pending');
  ok('the admin account belongs to no branch', registry.rows[0].branch_name === 'All branches');

  calls.length = 0;
  registry = await getUserRegistry(assistant(), {});
  ok('an assistant is held to their branch in the SQL', /COALESCE\(u\.assistant_scope_branch_id, u\.branch_id\) = \?/.test(calls[0].sql) && calls[0].params.includes(2));
  ok('…and the main admin account is left out of it', /u\.role <> 'admin'/.test(calls[0].sql));

  calls.length = 0;
  registry = await getUserRegistry(staff({ branchId: 2 }), {});
  ok('the main admin narrowing to a branch gets the same clause', calls[0].params.includes(2));

  ok('a tutor gets nothing', (await getUserRegistry(tutor(), {})).rows.length === 0);
  ok('a student gets nothing', (await getUserRegistry(learner(), {})).everyone.length === 0);

  registry = await getUserRegistry(staff(), { search: 'reyes' });
  ok('search finds a name', registry.rows.map((row) => row.user_id).sort().join() === 'STD-5,TTR-3');
  registry = await getUserRegistry(staff(), { search: 'filipino english' });
  ok('search reads the subjects, in any order', registry.rows.map((row) => row.user_id).join() === 'TTR-3,STD-4');
  registry = await getUserRegistry(staff(), { registryRole: 'Student' });
  ok('the role picked narrows the rows (the summary table and the list) …', registry.rows.every((row) => row.role === 'student') && registry.rows.length === 3);
  ok('… but not the headline counts', registry.everyone.length === 6);
  registry = await getUserRegistry(staff(), { registryStatus: 'Archived' });
  ok('the status picked narrows it too', registry.rows.length === 1 && registry.rows[0].user_id === 'STD-5');
  registry = await getUserRegistry(staff(), { registryRole: 'Student', registryStatus: 'Pending' });
  ok('both together', registry.rows.length === 1 && registry.rows[0].user_id === 'STD-6');

  console.log('\n== the fields the summary table counts by ==');
  const everyAccount = (await getUserRegistry(staff(), {})).everyone;
  const account = (code) => everyAccount.find((row) => row.user_id === code);
  ok('a learner\'s year level is the group of their grade', account('STD-4').level_group === 'Primary Level' && account('STD-5').level_group === 'Junior High Level');
  ok('a learner with no grade is "Not set", not lost', account('STD-6').level_group === 'Not set');
  ok('a tutor or an assistant has no year-level group', account('TTR-3').level_group === '' && account('AST-2').level_group === '');
  ok('roles read the way people say them', ['Admin', 'Assistant Admin', 'Tutor', 'Student'].every((label) => everyAccount.some((row) => row.role_label === label)));
  ok('a status is Approved, Pending, Rejected or Archived', everyAccount.every((row) => ['Approved', 'Pending', 'Rejected', 'Archived'].includes(row.status)));
  ok('an assistant admin has no subjects; a learner and a tutor do', account('AST-2').subjects.length === 0 && account('STD-4').subjects.length === 2 && account('TTR-3').subjects.length === 2);

  console.log('\n== a tutor\'s subjects are the ones they still teach ==');
  const everyoneBefore = script.users;
  script.users = [user({ id: 7, user_id: 'TTR-7', role: 'tutor', first_name: 'carla', last_name: 'diaz', subjects_json: '["ENGLISH","MATH"]', extra_json: '{"archived_subjects":["math"]}', grade_level: '' })];
  const carla = (await getUserRegistry(staff(), {})).rows[0];
  ok('a subject the office archived for a tutor is not listed', carla.subjects.join() === 'ENGLISH', carla.subjects.join());
  ok('nor found by a search for it', (await getUserRegistry(staff(), { search: 'math' })).rows.length === 0);
  script.users = everyoneBefore;

  console.log('\n== progress: Pre, module activities and Post side by side ==');
  const row = (over) => ({
    student_id: 11, student_code: 'STD-11', first_name: 'Maria', middle_name: '', last_name: 'Santos', year_level: 'Primary Level', grade_level: 'Grade 4',
    branch_id: 1, branch_name: 'Main Branch', subject_id: 2, subject_name: 'ENGLISH',
    pre_percentage: 40, pre_level: 'Beginner', pre_at: new Date(), post_percentage: 70, post_level: 'Intermediate', post_at: new Date(),
    module_average: 55.55, module_attempts: 2, ...over
  });
  script.progress = [
    row({}),
    row({ student_id: 12, student_code: 'STD-12', post_percentage: 40, post_level: 'Beginner' }),
    row({ student_id: 13, student_code: 'STD-13', post_percentage: 20 }),
    row({ student_id: 14, student_code: 'STD-14', post_percentage: null, post_level: null }),
    row({ student_id: 15, student_code: 'STD-15', pre_percentage: null, pre_level: null, post_percentage: null, post_level: null, module_average: null, module_attempts: 0 })
  ];
  script.modules = [
    { id: 100, subject_id: 2, grade_level: 'Grade 4' }, { id: 101, subject_id: 2, grade_level: 'Grade 4' }, { id: 102, subject_id: 2, grade_level: 'Grade 6' }
  ];
  script.reads = [{ student_id: 11, module_id: 100 }, { student_id: 11, module_id: 102 }];
  calls.length = 0;
  const progress = await getProgressComparison(staff(), { from: '2026-10-01', to: '2026-10-31', subjectId: 2 });
  const byId = (id) => progress.find((entry) => entry.student_id === id);
  ok('the change is Post minus Pre', byId(11).change === 30 && byId(13).change === -20);
  ok('Improved / No change / Declined', byId(11).status === PROGRESS_STATUS.improved && byId(12).status === PROGRESS_STATUS.same && byId(13).status === PROGRESS_STATUS.declined);
  ok('a Pre with no Post is waiting for it', byId(14).status === PROGRESS_STATUS.awaiting && byId(14).change === null);
  ok('no Pre at all is not yet assessed', byId(15).status === PROGRESS_STATUS.none);
  ok('the module average is rounded, and null when none were taken', byId(11).module_average === 55.6 && byId(15).module_average === null, String(byId(11).module_average));
  ok('modules opened are counted against the learner\'s OWN grade (Grade 4 has two, one opened)', byId(11).modules_total === 2 && byId(11).modules_opened === 1, `${byId(11).modules_opened}/${byId(11).modules_total}`);
  ok('a module of another grade does not count, even if opened', byId(11).modules_opened === 1);
  const sent = calls.find((call) => /OUTER APPLY/.test(call.sql));
  ok('the period is bound once for each of the three stages', sent.params.filter((p) => p instanceof Date).length === 6, String(sent.params.filter((p) => p instanceof Date).length));
  ok('the subject filter is bound after them', sent.params[sent.params.length - 1] === 2);
  ok('an admin is not narrowed to a tutor', !/usa\.tutor_id = \?/.test(sent.sql));

  calls.length = 0;
  await getProgressComparison(tutor(), {});
  const tutorSql = calls.find((call) => /OUTER APPLY/.test(call.sql));
  ok('a tutor sees only the subjects THEY teach the learner', /usa\.tutor_id = \?/.test(tutorSql.sql) && tutorSql.params.includes(9));
  ok('…and only their own learners', /mq_scope_student/.test(tutorSql.sql));
  calls.length = 0;
  await getProgressComparison(learner(), {});
  const learnerSql = calls.find((call) => /OUTER APPLY/.test(call.sql));
  ok('a student is held to themselves', /u\.id = \?/.test(learnerSql.sql) && learnerSql.params.includes(11));
  const everyLine = script.progress;
  script.progress = [row({}), row({ student_id: 12, student_code: 'STD-12', first_name: 'Jose', last_name: 'Reyes' })];
  const searched = await getProgressComparison(staff(), { search: 'reyes' });
  ok('the page\'s search narrows the progress table too', searched.length === 1 && searched[0].student_id === 12, searched.map((x) => x.student_code).join());
  ok('…by subject as well', (await getProgressComparison(staff(), { search: 'english' })).length === 2);
  calls.length = 0;
  ok('nobody found is an empty report', (await getProgressComparison(staff(), { search: 'nobody-here' })).length === 0);
  ok('…and the modules are not even asked for', !calls.some((call) => /FROM modules/.test(call.sql)));
  script.progress = everyLine;
  const declined = await getProgressComparison(staff(), { status: 'Declined' });
  ok('the tab\'s status narrows it to that status', declined.length === 1 && declined[0].student_id === 13, declined.map((x) => x.student_code).join());
  ok('…and "all" is every line', (await getProgressComparison(staff(), { status: 'all' })).length === 5);
  script.progress = [];
  ok('nobody enrolled is an empty report, not an error', (await getProgressComparison(staff(), {})).length === 0);

  console.log('\n== the progress figures add up ==');
  const summary = buildProgressSummary(progress);
  ok('learners and lines', summary.learners === 5 && summary.enrolments === 5);
  ok('who improved, stayed and declined', summary.improved === 1 && summary.same === 1 && summary.declined === 1);
  ok('who is waiting, and who has not sat anything', summary.awaiting === 1 && summary.notAssessed === 1);
  ok('the average change is over those with both exams', summary.averageChange === 3.3 && summary.compared === 3, `${summary.averageChange} over ${summary.compared}`);
  ok('the average Pre ignores the learner who has none', summary.averagePre === 40);
  ok('by subject, the stages are averaged separately', summary.bySubject.length === 1 && summary.bySubject[0].post === 43.3, JSON.stringify(summary.bySubject[0]));
  ok('branch by subject is a pivot of average change', summary.branchSubjectChange.rows[0].label === 'Main Branch' && summary.branchSubjectChange.grand === 3.3);
  const none = buildProgressSummary([]);
  ok('an empty report has no averages, not zeros', none.averagePre === null && none.averageChange === null && none.learners === 0);

  console.log('\n== every Analytics tab reads its own filters ==');
  const lists = { methods: ['Cash', 'GCash'], purposes: ['Tuition'] };
  const adminF = af.readAnalyticsFilters({
    weak_search: '  nouns  ', weak_subject: '4', weak_kind: 'pre_assessment', att_from: '2026-10-01', att_to: '2026-13-45',
    att_kind: 'post_assessment', pay_method: 'Cash', pay_purpose: 'Bribes', reg_role: 'Tutor', reg_status: 'Archived',
    reg_branch: 'x', prog_status: 'Improved', trend_subject: "4'--", int_search: 'x'.repeat(150)
  }, { role: 'admin', ...lists });
  ok('a tab reads its own fields, trimmed', adminF.weak.search === 'nouns' && adminF.weak.subjectId === '4');
  ok('…and not another tab\'s (Weak topics has no assessment picker)', adminF.weak.kind === undefined && adminF.attempts.kind === 'post_assessment');
  ok('a date must be a real day', adminF.attempts.from === '2026-10-01' && adminF.attempts.to === '');
  ok('a choice must be one of its options', adminF.payments.method === 'Cash' && adminF.payments.purpose === 'all'
    && adminF.registry.role === 'Tutor' && adminF.registry.status === 'Archived' && adminF.progress.status === 'Improved');
  const swapped = af.readAnalyticsFilters({ reg_status: 'Improved', prog_status: 'Archived' }, { role: 'admin' });
  ok('the registry\'s statuses are not the progress table\'s', swapped.registry.status === 'all' && swapped.progress.status === 'all');
  ok('an id must be a whole number', adminF.registry.branchId === 'all' && adminF.trend.subjectId === 'all');
  ok('a search is cut at 100 characters', adminF.integrity.search.length === 100);
  const assistantF = af.readAnalyticsFilters({ weak_branch: '2', weak_subject: '4' }, { role: 'admin_assistant' });
  ok('an assistant has no branch to pick: one in the address is not read', assistantF.weak.branchId === 'all' && assistantF.weak.subjectId === '4');
  const tutorF = af.readAnalyticsFilters({ perf_branch: '1', perf_search: 'maria' }, { role: 'tutor' });
  ok('…nor has a tutor', tutorF.perf.branchId === 'all' && tutorF.perf.search === 'maria');
  const studentF = af.readAnalyticsFilters({
    weak_search: 'nouns', weak_subject: '4', trend_subject: '4', prog_status: 'Improved', prog_subject: '6', att_kind: 'pre_assessment'
  }, { role: 'student' });
  ok('a student\'s page reads only a student\'s fields', studentF.weak.search === '' && studentF.weak.subjectId === '4'
    && studentF.trend.subjectId === 'all' && studentF.progress.status === 'all' && studentF.progress.subjectId === '6' && studentF.attempts.kind === 'pre_assessment');
  ok('a tab\'s filters, as the address writes them', JSON.stringify(af.paramsOfTab(adminF, 'attempts')) === '[["att_kind","post_assessment"],["att_from","2026-10-01"]]',
    JSON.stringify(af.paramsOfTab(adminF, 'attempts')));
  const carried = af.paramsExcept(adminF, 'weak');
  ok('every other tab\'s, for a form to carry along', carried.every(([name]) => !name.startsWith('weak_')) && carried.some(([name]) => name === 'att_kind'));
  ok('"all" and empty are not filters', JSON.stringify(af.setOnly({ a: 'all', b: '', c: '4', d: undefined })) === '{"c":"4"}');
  const forms = af.tabForms(adminF, 'admin');
  ok('each bar knows its tab on the page and its own fields', forms.weak.panel === 'weak-topics' && forms.weak.fields.join() === 'search,subject,branch'
    && forms.enrolment.fields.join() === 'branch' && forms.payments.fields.join() === 'search,from,to,branch,method,purpose');
  ok('…a tab with nothing to filter for this viewer has no fields', af.tabForms(adminF, 'admin_assistant').enrolment.fields.length === 0
    && af.tabForms(adminF, 'student').trend.fields.length === 0 && af.tabForms(adminF, 'student').attempts.fields.join() === 'subject,kind,from,to');
  ok('…and carries the others, never its own', forms.attempts.others.every(([name]) => !name.startsWith('att_')) && forms.attempts.own.length === 2);
  ok('the Assessment picker lists Pre, Post and Module', forms.attempts.choices.kind.map((choice) => choice[1]).join() === 'Pre-Assessment,Post-Assessment,Module assessment');
  ok('the Status picker is the tab\'s own', forms.progress.choices.status.includes('Improved') && forms.registry.choices.status.includes('Archived') && !forms.registry.choices.status.includes('Improved'));

  console.log('\n== weak topics: who is weak in each ==');
  const answer = (moduleId, handout, id, code, first, last, branch, correct, total) => ({
    subject_id: 2, source_module_id: moduleId, handout_name: handout, student_id: id, student_code: code,
    first_name: first, middle_name: null, last_name: last, branch_name: branch, total, correct
  });
  script.weakTopics = [
    { subject_id: 2, subject_name: 'ENGLISH', source_module_id: 7, module_title: 'Module 1: Nouns', order_number: 1, handout_name: null, total: 6, correct: 2, student_count: 3 },
    { subject_id: 2, subject_name: 'ENGLISH', source_module_id: 8, module_title: 'Module 2: Verbs', order_number: 2, handout_name: 'verbs.pdf', total: 4, correct: 4, student_count: 2 }
  ];
  script.weakLearners = [
    answer(7, null, 12, 'STD-12', 'jose', 'reyes', null, 1, 2),
    answer(7, null, 11, 'STD-11', 'maria', 'santos', 'Main Branch', 0, 2),
    answer(7, null, 13, 'STD-13', 'lea', 'cruz', 'Fatima Branch', 2, 2),
    answer(8, 'verbs.pdf', 11, 'STD-11', 'maria', 'santos', 'Main Branch', 2, 2),
    answer(8, 'verbs.pdf', 12, 'STD-12', 'jose', 'reyes', null, 2, 2)
  ];
  const weakMap = await getWeakTopicLearners(staff(), {});
  const nouns = weakMap.get('2|7|');
  ok('a topic lists the learners below 60% on it, weakest first', nouns && nouns.weak.map((x) => x.student_code).join() === 'STD-11,STD-12', nouns && nouns.weak.map((x) => x.student_code).join());
  ok('…out of everyone who answered it', nouns.answered === 3);
  ok('…each with their own score on it', nouns.weak[1].correct === 1 && nouns.weak[1].total === 2 && nouns.weak[1].percentage === 50);
  ok('…their name in title case, and a branch even when the record has none', nouns.weak[0].name === 'Maria Santos' && nouns.weak[1].branch_name === '—');
  ok('a topic nobody is weak in has an empty list', weakMap.get('2|8|verbs.pdf').weak.length === 0 && weakMap.get('2|8|verbs.pdf').answered === 2);
  calls.length = 0;
  await getWeakTopicLearners(tutor(), { subjectId: '2' });
  let weakSql = calls.find((call) => /sub\.student_id, u\.user_id AS student_code/.test(call.sql));
  ok('a tutor\'s list is their own learners, in their subjects, with the subject picked bound last', /mq_scope_student/.test(weakSql.sql)
    && /mq_scope_subject/.test(weakSql.sql) && weakSql.params[weakSql.params.length - 1] === 2);
  calls.length = 0;
  await getWeakTopicLearners(assistant(), {});
  weakSql = calls.find((call) => /sub\.student_id, u\.user_id AS student_code/.test(call.sql));
  ok('an assistant\'s is their branch\'s', /u\.branch_id = \?/.test(weakSql.sql) && weakSql.params.includes(2));

  console.log('\n== the dashboard: every tab its own filters, the headline figures the whole scope ==');
  const submissionCalls = () => calls.filter((call) => /sub\.is_auto_submitted, sub\.violation_count/.test(call.sql));
  const weakCalls = () => calls.filter((call) => /COUNT\(DISTINCT sub\.student_id\) AS student_count/.test(call.sql));
  const adminUser = { id: 1, role: 'admin' };
  calls.length = 0;
  let dash = await getAnalyticsDashboard(adminUser, af.readAnalyticsFilters({}, { role: 'admin' }));
  ok('with no filter, the attempts are asked for once (the tabs and the figures share them)', submissionCalls().length === 1, String(submissionCalls().length));
  ok('…and the weak topics once', weakCalls().length === 1, String(weakCalls().length));
  ok('each weak topic carries who is weak in it', dash.weakTopics[0].weak_count === 2 && dash.weakTopics[0].weak_learners[0].student_code === 'STD-11' && dash.weakTopics[1].weak_count === 0);
  ok('the headline counts the topics below 60%', dash.kpis.weakTopics === 1 && dash.weakBelow === 60);
  ok('every tab has its own filter bar', Object.keys(dash.forms).length === 11 && dash.forms.weak.fields.join() === 'search,subject,branch');
  calls.length = 0;
  dash = await getAnalyticsDashboard(adminUser, af.readAnalyticsFilters({ att_kind: 'post_assessment', weak_subject: '2', weak_search: 'verbs', weak_branch: '3' }, { role: 'admin' }));
  ok('a tab\'s filter is asked for apart from the headline figures', submissionCalls().length === 2
    && submissionCalls().some((call) => call.params.includes('post_assessment')) && submissionCalls().some((call) => !call.params.includes('post_assessment')));
  ok('Weak topics asks with its own subject and branch; the headline figure without', weakCalls().length === 2
    && weakCalls().some((call) => call.params.join() === '3,2') && weakCalls().some((call) => call.params.length === 0), weakCalls().map((call) => call.params.join('/')).join(' | '));
  ok('…and its search reads the topic', dash.weakTopics.length === 1 && dash.weakTopics[0].module_title === 'Module 2: Verbs');
  ok('…while the headline still counts every weak topic', dash.kpis.weakTopics === 1);
  calls.length = 0;
  dash = await getAnalyticsDashboard({ id: 11, role: 'student', branch_id: 1 }, af.readAnalyticsFilters({ weak_search: 'nouns', weak_subject: '2' }, { role: 'student' }));
  ok('a student\'s page never asks who else is weak', !calls.some((call) => /sub\.student_id, u\.user_id AS student_code/.test(call.sql)) && dash.weakTopics.every((topic) => topic.weak_count === 0));
  ok('…and a search a student is not shown is not applied', dash.weakTopics.length === 2);
  script.weakTopics = [];
  script.weakLearners = [];

  console.log('\n== a tab\'s filter bar, and the Payment Collection report (the views) ==');
  const viewsDir = require('path').join(__dirname, '..', 'views', 'partials');
  const viewUtils = require('../lib/utils');
  const { icon: viewIcon } = require('../lib/icons');
  const barForm = af.tabForms(af.readAnalyticsFilters({ weak_search: '"><script>x()</script>', weak_subject: '4', att_from: '2026-10-01', reg_role: 'Tutor' }, { role: 'admin' }), 'admin').weak;
  const bar = await require('ejs').renderFile(require('path').join(viewsDir, 'analytics-filters.ejs'), {
    icon: viewIcon, form: barForm, action: '/admin/analytics', subjects: [{ id: 4, name: 'ENGLISH' }], placeholder: 'Topic or subject', branches: [{ id: 3, name: 'BAWING' }]
  });
  ok('the bar has its tab\'s fields only, named for the tab', /name="weak_search"/.test(bar) && /name="weak_subject"/.test(bar) && /name="weak_branch"/.test(bar)
    && !/type="date"/.test(bar) && !/name="search"/.test(bar) && !/name="subject_id"/.test(bar));
  ok('…comes back to its tab', /action="\/admin\/analytics#weak-topics"/.test(bar));
  ok('…carries the other tabs\' filters, hidden', /type="hidden" name="att_from" value="2026-10-01"/.test(bar) && /type="hidden" name="reg_role" value="Tutor"/.test(bar) && !/type="hidden" name="weak_/.test(bar));
  ok('…and Clear clears its own only', /href="\/admin\/analytics\?att_from=2026-10-01&amp;reg_role=Tutor#weak-topics">Clear/.test(bar), (bar.match(/href="[^"]*">Clear/) || [''])[0]);
  ok('…with the picked subject selected and a typed search escaped', /<option value="4" selected>ENGLISH/.test(bar) && !bar.includes('<script>x()</script>'));
  const noBar = await require('ejs').renderFile(require('path').join(viewsDir, 'analytics-filters.ejs'), {
    icon: viewIcon, form: af.tabForms(af.readAnalyticsFilters({}, { role: 'tutor' }), 'tutor').enrolment, action: '/tutor/analytics', subjects: [], placeholder: ''
  });
  ok('a tab with no field for this viewer has no bar at all', noBar.trim() === '');
  const report = (extra) => require('ejs').renderFile(require('path').join(viewsDir, 'payment-collection.ejs'), {
    icon: viewIcon, money: viewUtils.money, formatDateTime: viewUtils.formatDateTime, titleCaseName: viewUtils.titleCaseName, basePath: '/admin',
    currentUser: { role: 'admin' }, branches: [{ id: 1, name: 'MAIN' }],
    rows: [{ id: 1, amount: 500, paid_at: new Date('2026-10-14T09:00:00Z'), payment_method: 'Cash', purpose: 'Tuition', student_id: 4, user_id: 'STD-4', first_name: 'maria', last_name: 'santos', branch_name: 'MAIN' }],
    summary: { totalIncome: 500, transactionCount: 1, monthIncome: 500, payingStudents: 1, outstanding: 1000 },
    paymentMethods: [{ value: 'Cash' }, { value: 'GCash' }], paymentPurposes: ['Tuition'], ...extra
  });
  const inTab = await report({
    values: { search: '', from: '', to: '', branchId: '1', method: 'GCash', purpose: 'all' }, action: '/admin/analytics#payments',
    names: { search: 'pay_search', from: 'pay_from', to: 'pay_to', branch: 'pay_branch', method: 'pay_method', purpose: 'pay_purpose' },
    keep: [['reg_role', 'Tutor']], clearHref: '/admin/analytics?reg_role=Tutor#payments', analyticsTab: 'payments', showPrint: false, headingTag: 'h3'
  });
  ok('in Analytics the report\'s fields carry the tab\'s prefix, and keep the other tabs\'', /name="pay_method" data-autosubmit/.test(inTab) && /<option value="GCash" selected>/.test(inTab) && /type="hidden" name="reg_role" value="Tutor"/.test(inTab));
  ok('…with no Print, and its figures and transactions', !/Print/.test(inTab) && /Total collected/.test(inTab) && /<h3>Transactions<\/h3>/.test(inTab) && /Maria/.test(inTab));
  const onPage = await report({
    values: { search: 'ma', from: '', to: '', branchId: 'all', method: 'all', purpose: 'all' }, action: '/admin/income-report',
    names: { search: 'search', from: 'from', to: 'to', branch: 'branch_id', method: 'method', purpose: 'purpose' },
    keep: [], clearHref: '/admin/income-report', analyticsTab: null, showPrint: true, headingTag: 'h2'
  });
  ok('on its own page it keeps its plain names, its Print and no auto-apply', /name="branch_id"/.test(onPage) && /Print/.test(onPage) && !/data-autosubmit/.test(onPage) && /<h2>Transactions<\/h2>/.test(onPage));

  console.log('\n== CSV files are safe to open in a spreadsheet ==');
  ok('a plain cell is left alone', csvCell('Maria') === 'Maria');
  ok('a comma or a quote is quoted', csvCell('Santos, Maria') === '"Santos, Maria"' && csvCell('say "hi"') === '"say ""hi"""');
  ok('a formula is neutralised', csvCell('=HYPERLINK("http://x")').startsWith('"\'=') && csvCell('+1').startsWith("'") && csvCell('@SUM(A1)').startsWith("'") && csvCell('-2+3').startsWith("'"));
  ok('a number stays a number, minus sign and all', csvCell(-12.5) === '-12.5' && csvCell(0) === '0');
  ok('nothing is an empty cell', csvCell(null) === '' && csvCell(undefined) === '');
  const csv = toCsv([{ label: 'A', value: (r) => r.a }, { label: 'B', value: (r) => r.b }], [{ a: 1, b: 'x,y' }]);
  ok('it starts with a byte-order mark and uses CRLF', csv.startsWith('\uFEFF') && csv.includes('\r\n') && csv.endsWith('\r\n'));
  ok('header then rows', csv.split('\r\n')[0].replace('\uFEFF', '') === 'A,B' && csv.split('\r\n')[1] === '1,"x,y"');
  const registryFile = registryCsv((await (async () => { script.users = [user({ id: 4, user_id: 'STD-4', first_name: '=cmd', last_name: 'x' })]; return getUserRegistry(staff(), {}); })()).rows);
  ok('the registry file has its columns', registryFile.split('\r\n')[0].includes('User ID,Name,Role,Branch'));
  ok('a name typed as a formula is neutralised in the file', /,'=cmd X,/i.test(registryFile.split('\r\n')[1]), registryFile.split('\r\n')[1]);
  // 8 PM UTC on the 5th is 4 AM on the 6th in Manila — the day the page shows.
  script.users = [user({ id: 4, user_id: 'STD-4', created_at: new Date('2026-01-05T20:00:00Z') })];
  const lateLine = registryCsv((await getUserRegistry(staff(), {})).rows).split('\r\n')[1];
  ok('a date in the file is the day the page shows, not the UTC day', /,2026-01-06$/.test(lateLine), lateLine);
  const progressFile = progressCsv(progress);
  ok('the progress file has a line per learner and subject', progressFile.trim().split('\r\n').length === 6);
  ok('and the change keeps its sign', /,-20,/.test(progressFile));

  console.log('\n== the list filters ==');
  ok('every word must be said, in any order', matchesSearch(['Maria Santos', 'STD-0011'], 'santos maria') && !matchesSearch(['Maria Santos'], 'maria cruz'));
  ok('an empty search matches everything', matchesSearch(['x'], '') && matchesSearch([], '   '));
  ok('case and spacing do not matter', matchesSearch(['MARIA  SANTOS'], 'maria santos'));
  ok('null parts are skipped', matchesSearch([null, undefined, 'Santos'], 'santos'));
  ok('a date range includes both ends', withinDates(new Date('2026-10-05T10:00:00Z'), '2026-10-05', '2026-10-05'));
  ok('and excludes what is outside', !withinDates(new Date('2026-10-05T10:00:00Z'), '2026-10-06', '') && !withinDates(new Date('2026-10-05T10:00:00Z'), '', '2026-10-04'));
  ok('no range matches everything, even a missing date', withinDates(null, '', ''));
  ok('a range excludes a row with no date', !withinDates(null, '2026-10-01', ''));
  ok('only a plain YYYY-MM-DD is accepted as a date', cleanDate('2026-10-05') === '2026-10-05' && cleanDate('05/10/2026') === '' && cleanDate("2026-10-05'; DROP") === '');
  ok('a record id must be a whole number, or it is "all"', cleanId('12') === '12' && cleanId('abc') === 'all' && cleanId('1.5') === 'all' && cleanId('-3') === 'all' && cleanId('0') === 'all' && cleanId('') === 'all' && cleanId(undefined) === 'all' && cleanId("2'--") === 'all');
  ok('…and only a real calendar day', cleanDate('2026-13-45') === '' && cleanDate('2026-02-30') === '' && cleanDate('2028-02-29') === '2028-02-29' && cleanDate('2026-02-29') === '');

  console.log('\n== the tutor\'s Attendance Logs filter (the page) ==');
  const ejs = require('ejs');
  const path = require('path');
  const utils = require('../lib/utils');
  const { icon } = require('../lib/icons');
  const attendanceView = path.join(__dirname, '..', 'views', 'content', 'tutor-attendance.ejs');
  const attendanceBase = {
    formatDate: utils.formatDate, toInputDate: utils.toInputDate, attendanceLabel: utils.attendanceLabel, attendanceBadge: utils.attendanceBadge, icon,
    tutorSubjects: [{ id: 2, name: 'MATHEMATICS' }], students: [], selectedSubjectId: '2'
  };
  const logRow = (id, first, last, status) => ({ id, first_name: first, last_name: last, subject_name: 'MATHEMATICS', attendance_date: new Date('2026-10-02'), status });
  let page = await ejs.renderFile(attendanceView, { ...attendanceBase, attendanceLogs: [logRow(1, 'Maria', 'Santos', 'present'), logRow(2, 'Jose', 'Reyes', 'absent')], logCount: 2, logFilters: { search: '', status: 'all', from: '', to: '' } });
  ok('the logs have their own filter bar, its fields named log_*', /name="log_search"/.test(page) && /name="log_status"/.test(page) && /name="log_from"/.test(page) && /name="log_to"/.test(page));
  ok('it keeps the subject loaded for marking', /<form class="mq-toolbar"[^>]*>\s*<input type="hidden" name="subject_id" value="2" \/>/.test(page));
  page = await ejs.renderFile(attendanceView, { ...attendanceBase, attendanceLogs: [logRow(2, 'Jose', 'Reyes', 'absent')], logCount: 2, logFilters: { search: 'reyes', status: 'absent', from: '2026-10-01', to: '' } });
  ok('narrowed, it counts "1 of 2"', />1 of 2 logs</.test(page.replace(/\s+/g, ' ')));
  ok('a status change carries the filter back (and nothing empty)', /type="hidden" name="log_search" value="reyes"/.test(page) && /type="hidden" name="log_status" value="absent"/.test(page) && !/type="hidden" name="log_to"/.test(page));
  page = await ejs.renderFile(attendanceView, { ...attendanceBase, attendanceLogs: [], logCount: 2, logFilters: { search: 'zzz', status: 'all', from: '', to: '' } });
  ok('nothing found says so', /No attendance log matches these filters/.test(page));
  page = await ejs.renderFile(attendanceView, { ...attendanceBase, attendanceLogs: [], logCount: 0, logFilters: { search: '"><script>x()</script>', status: 'all', from: '', to: '' } });
  ok('a search with markup in it is escaped', !page.includes('<script>x()</script>'));

  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'The registry, the progress comparison, the pivots and the CSV files — hold.'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message, e.stack); process.exit(1); });
