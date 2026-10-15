/**
 * File: scripts/test-reports.js
 * Purpose: Pin down the Analytics & Reports additions — the User registry and the
 * fields its summary table counts by, the Student progress comparison and its
 * pivot of averages, the CSV files — and the in-memory list filters the
 * monitoring pages share (with the tutor's Attendance Logs filter bar, rendered).
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
  buildAveragePivot, getUserRegistry, getProgressComparison, buildProgressSummary, PROGRESS_STATUS
} = require('../lib/analytics');
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
