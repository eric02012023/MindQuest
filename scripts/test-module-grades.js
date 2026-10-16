/**
 * File: scripts/test-module-grades.js
 * Purpose: Pin down "one grade per module", "the Post-Assessment opens on the
 *          last day of the enrolment", and what is left to a student once their
 *          month is over (only what it held; view-only when nothing is left).
 *
 * Run:  node scripts/test-module-grades.js       (needs no database, no keys)
 *
 * WHAT WENT WRONG BEFORE
 *   1. A module saved as ["Primary Level", "Grade 3"] was shown to Grades 1-6:
 *      the group stood for every grade inside it. A Grade 6 learner sat Grade 3's
 *      module assessments, and the subject's one Pre-Assessment was written from
 *      every grade's handouts — so a grade with no module could still sit it.
 *   2. Module numbers were unique across the whole subject: once English Grade 1
 *      had a Module 1, English Grade 6 could not have one.
 *   3. The Post-Assessment opened when a tutor pressed a button, for anyone who
 *      had opened every module — not on the last day of the enrolment.
 *
 * `config/db` is replaced in the require cache before lib/data.js loads, so the
 * real functions run against a scripted database. Nothing dials out.
 */

let failures = 0;
const ok = (label, condition, extra = '') => {
  if (condition) console.log(`  PASS  ${label}${extra ? ' — ' + extra : ''}`);
  else { failures++; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
};

// --- the scripted database ------------------------------------------------
const db = {
  modules: [],          // { id, subject_id, order_number, title, grade_level, target_year_levels_json, is_archived }
  inserted: [],
  lastSql: '',
  lastParams: [],
  preRows: [],          // hasCompletedPreAssessment answers
  postRows: [],         // getStudentPostSubmission answers
  enrolment: null,      // getSubjectEnrolment answers
  assignments: [],      // getStudentAssignments: the student's enrolments
  sat: [],              // ...the Pre/Post-Assessments they sat, per subject
  monthModules: [],     // ...the modules of the subjects whose month is over
  monthActivities: [],  // ...and the activities in them
  reads: 0,
  user: { id: 5, role: 'student', grade_level: 'Grade 6', year_level: 'Primary Level' }
};

function answer(text, params) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  db.lastSql = sql;
  db.lastParams = params;
  db.reads++;
  if (sql.includes('FROM user_subject_assignments usa INNER JOIN subjects s')) return db.assignments;
  if (sql.startsWith('SELECT DISTINCT ta.subject_id, ta.assessment_kind, ta.grade_level')) return db.sat;
  if (sql.startsWith('SELECT m.id, m.subject_id, m.grade_level, m.target_year_levels_json, m.created_at')) return db.monthModules;
  if (sql.startsWith('SELECT ta.id, ta.module_id, ta.created_at,')) return db.monthActivities;
  if (/FROM modules WHERE subject_id = \? AND is_archived = 0/.test(sql)) {
    const exclude = /AND id <> \?/.test(sql) ? Number(params[1]) : null;
    return db.modules.filter((m) => m.subject_id === Number(params[0]) && !m.is_archived && m.id !== exclude);
  }
  if (sql.startsWith('INSERT INTO modules')) {
    db.inserted.push(params);
    return { insertId: 500 + db.inserted.length };
  }
  if (sql.includes("ta.assessment_kind = 'pre_assessment'") && sql.includes('tutor_assessment_submissions')) return db.preRows;
  if (sql.includes("ta.assessment_kind = 'post_assessment'") && sql.includes('tutor_assessment_submissions')) return db.postRows;
  if (sql.includes('FROM user_subject_assignments') && sql.includes('end_date')) return db.enrolment ? [db.enrolment] : [];
  if (sql.includes('FROM users u') && sql.includes('WHERE u.id = ?')) return [db.user];
  return [];
}

const dbPath = require.resolve('../config/db');
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    sql: {},
    baseConfig: {},
    getPool: async () => { throw new Error('the test must never open a connection'); },
    query: async (text, params = []) => answer(text, params),
    withTransaction: async (work) => work({ query: async (text, params = []) => [answer(text, params)] })
  }
};

const grades = require('../lib/moduleGrades');
const data = require('../lib/data');
const postWindow = require('../lib/postWindow');

async function main() {
  console.log('\n== a grade is read the same way everywhere ==');
  ok('"grade 3" is Grade 3', grades.canonicalGrade('grade 3') === 'Grade 3');
  ok('"GRADE3" is Grade 3', grades.canonicalGrade('GRADE3') === 'Grade 3');
  ok('"Kinder 1" is a grade', grades.canonicalGrade('Kinder 1') === 'Kinder 1');
  ok('a year-level group is not a grade', grades.canonicalGrade('Primary Level') === '');
  ok('"Grade 10" never reads as Grade 1', grades.canonicalGrade('Grade 10') === 'Grade 10');

  console.log('\n== a module is for ONE grade ==');
  ok('the column wins', grades.moduleGradeOf({ grade_level: 'Grade 6', target_year_levels_json: '["Grade 3"]' }) === 'Grade 6');
  ok('an old ["Primary Level","Grade 3"] module is Grade 3, not all of Primary',
    grades.moduleGradeOf({ target_year_levels_json: '["Primary Level","Grade 3"]' }) === 'Grade 3');
  ok('an old group-only module has no grade', grades.moduleGradeOf({ target_year_levels_json: '["Pre School Level"]' }) === '');
  ok('two grades listed: the youngest, as the migration picks',
    grades.moduleGradeOf({ target_year_levels_json: '["Grade 12","Grade 3"]' }) === 'Grade 3');

  console.log('\n== only that grade\'s students see it ==');
  const grade3Module = { target_year_levels_json: '["Primary Level","Grade 3"]' };
  const grade6Student = { year_level: 'Primary Level', grade_level: 'Grade 6' };
  const grade3Student = { year_level: 'Primary Level', grade_level: 'Grade 3' };
  ok('a Grade 3 module is NOT shown to a Grade 6 student (the live leak)', data.moduleTargetsStudent(grade3Module, grade6Student) === false);
  ok('a Grade 3 module is shown to a Grade 3 student', data.moduleTargetsStudent(grade3Module, grade3Student) === true);
  ok('a module with no grade is shown to nobody', data.moduleTargetsStudent({ target_year_levels_json: '[]' }, grade3Student) === false);
  ok('a student with no grade on record sees nothing', data.moduleTargetsStudent({ grade_level: 'Grade 3' }, { year_level: 'Primary Level' }) === false);
  ok('Kinder 1 never sees Grade 5', data.moduleTargetsStudent({ grade_level: 'Grade 5' }, { grade_level: 'Kinder 1' }) === false);

  console.log('\n== module numbers count within a grade ==');
  db.modules = [
    { id: 1, subject_id: 4, order_number: 1, title: 'Phonics', grade_level: 'Grade 1', target_year_levels_json: '["Grade 1"]', is_archived: 0 },
    { id: 2, subject_id: 4, order_number: 2, title: 'Sight words', grade_level: null, target_year_levels_json: '["Primary Level","Grade 1"]', is_archived: 0 }
  ];
  db.inserted = [];
  const grade6First = await data.createSubjectModule({ subject_id: 4, title: 'Reading', grade_level: 'Grade 6', order_number: 1 });
  ok('English Grade 6 can have a Module 1 while Grade 1 has one', grade6First.order_number === 1 && grade6First.grade_level === 'Grade 6');
  ok('the module is stored with its grade', db.inserted[0] && db.inserted[0].includes('Grade 6') && db.inserted[0].includes('["Grade 6"]'),
    JSON.stringify(db.inserted[0]));

  let refused = '';
  try { await data.createSubjectModule({ subject_id: 4, title: 'Again', grade_level: 'Grade 1', order_number: 1 }); } catch (e) { refused = e.message; }
  ok('a second Module 1 in English Grade 1 is refused', /Grade 1 already has a Module 1/.test(refused), refused);

  let refusedOld = '';
  try { await data.createSubjectModule({ subject_id: 4, title: 'Again', grade_level: 'Grade 1', order_number: 2 }); } catch (e) { refusedOld = e.message; }
  ok('a number held by a module saved before grade_level existed is still held', /Grade 1 already has a Module 2/.test(refusedOld), refusedOld);

  const next = await data.createSubjectModule({ subject_id: 4, title: 'Next', grade_level: 'Grade 1', order_number: '' });
  ok('left blank, Grade 1 gets its lowest free number (3)', next.order_number === 3, `${next.order_number}`);

  let noGrade = '';
  try { await data.createSubjectModule({ subject_id: 4, title: 'No grade', order_number: 1 }); } catch (e) { noGrade = e.message; }
  ok('a module without a grade is refused', /Choose the grade level/.test(noGrade), noGrade);

  let groupOnly = '';
  try { await data.createSubjectModule({ subject_id: 4, title: 'Group', grade_level: 'Primary Level', order_number: 1 }); } catch (e) { groupOnly = e.message; }
  ok('a year-level group is not accepted as the grade', /Choose the grade level/.test(groupOnly), groupOnly);

  console.log('\n== the Post-Assessment opens at 12:01 AM on the last day ==');
  // The office's example: enrolled 1 January, the month runs to 1 February.
  const enrolledJan1 = { start_date: '2026-01-01', end_date: '2026-02-01' };
  const opensAt = data.postWindowFor(enrolledJan1).opensAt;
  ok('it opens at 12:01 AM Manila on 1 February (16:01 UTC on 31 January)', opensAt && opensAt.toISOString() === '2026-01-31T16:01:00.000Z',
    opensAt && opensAt.toISOString());
  ok('closed at 12:00 AM on 1 February', data.postWindowFor(enrolledJan1, new Date('2026-01-31T16:00:59Z')).isOpen === false);
  ok('open from 12:01 AM on 1 February', data.postWindowFor(enrolledJan1, new Date('2026-01-31T16:01:00Z')).isOpen === true);
  ok('still open after the last day', data.postWindowFor(enrolledJan1, new Date('2026-02-03T02:00:00Z')).isOpen === true);
  ok('closed all through January', data.postWindowFor(enrolledJan1, new Date('2026-01-20T04:00:00Z')).isOpen === false);
  ok('with no end date, it is one month from the start',
    data.postWindowFor({ start_date: '2026-01-01' }).endDate === '2026-02-01', data.postWindowFor({ start_date: '2026-01-01' }).endDate);

  console.log('\n== …and does not close ==');
  const at = (iso) => data.postWindowFor(enrolledJan1, new Date(iso));
  ok('still open five days on, and a month on', at('2026-02-06T04:00:00Z').isOpen === true && at('2026-03-20T04:00:00Z').isOpen === true);
  ok('it has no closing time at all', !('closesAt' in data.postWindowFor(enrolledJan1)) && !('isClosed' in data.postWindowFor(enrolledJan1)));
  ok('the old five-day setting is gone', data.POST_ASSESSMENT_OPEN_DAYS === undefined);

  console.log('\n== the month is over at 12:00 AM after its last day ==');
  const month = (row, iso) => data.monthOf(row, new Date(iso));
  const jan = month(enrolledJan1, '2026-01-20T04:00:00Z');
  ok('its last day is 1 February', jan.endDate === '2026-02-01');
  ok('over at 12:00 AM Manila on 2 February (16:00 UTC on 1 February)', jan.overAt && jan.overAt.toISOString() === '2026-02-01T16:00:00.000Z',
    jan.overAt && jan.overAt.toISOString());
  ok('…the same moment as the database writes it', jan.overFrom === '2026-02-02 00:00:00', jan.overFrom);
  ok('running all through January', jan.isOver === false);
  ok('the last day itself is still the month (11:59 PM on 1 February)', month(enrolledJan1, '2026-02-01T15:59:59Z').isOver === false);
  ok('over from 12:00 AM on 2 February', month(enrolledJan1, '2026-02-01T16:00:00Z').isOver === true);
  ok('an end date read from the database as a Date counts as its day',
    month({ end_date: new Date('2026-02-01T00:00:00Z') }, '2026-02-01T16:00:00Z').isOver === true
    && month({ end_date: new Date('2026-02-01T00:00:00Z') }, '2026-02-01T15:59:00Z').isOver === false);
  ok('no enrolment, no month to be over', month(null, '2026-02-10T00:00:00Z').isOver === false);

  console.log('\n== once over, what was added later is not part of it ==');
  const over = month(enrolledJan1, '2026-03-01T00:00:00Z');
  // The driver hands a stored time back as if it were UTC (lib/postWindow.js, storedTime).
  ok('a stored time reads back as it was written', postWindow.storedTime(new Date('2026-02-01T23:59:59Z')) === '2026-02-01 23:59:59');
  ok('added at 11:59 PM on the last day: part of it', data.addedInMonth(new Date('2026-02-01T23:59:59Z'), over) === true);
  ok('added at 12:00 AM the day after: not', data.addedInMonth(new Date('2026-02-02T00:00:00Z'), over) === false);
  ok('…written as text too', data.addedInMonth('2026-02-01 22:00:00', over) === true && data.addedInMonth('2026-02-03 08:00:00', over) === false);
  ok('while the month runs, everything is', data.addedInMonth(new Date('2026-02-03T08:00:00Z'), jan) === true);

  console.log('\n== what is left, then view-only ==');
  const state = (m, left) => data.subjectMonthState(m, left);
  ok('while the month runs: nothing held back, nothing counted', state(jan, 3).monthOver === false && state(jan, 3).remaining === null && state(jan, 0).viewOnly === false);
  ok('over with assessments left: still theirs to answer', state(over, 2).monthOver === true && state(over, 2).remaining === 2 && state(over, 2).viewOnly === false);
  ok('over with nothing left: view-only', state(over, 0).viewOnly === true && state(over, 0).remaining === 0);
  ok('enrolled again: a new month, not over', month({ start_date: '2026-03-01', end_date: '2026-04-01' }, '2026-03-10T04:00:00Z').isOver === false);

  console.log('\n== counted for a real student ==');
  // Enrolled 15 September, last day 15 October: over from 12:00 AM on 16 October.
  db.user = { id: 5, role: 'student', grade_level: 'Grade 6', year_level: 'Primary Level' };
  db.assignments = [{ id: 31, student_id: 5, subject_id: 2, subject_name: 'MATHEMATICS', start_date: '2020-09-15', end_date: '2020-10-15' }];
  db.monthModules = [
    { id: 61, subject_id: 2, grade_level: 'Grade 6', target_year_levels_json: '["Grade 6"]', created_at: new Date('2020-09-20T10:00:00Z') },
    { id: 62, subject_id: 2, grade_level: 'Grade 6', target_year_levels_json: '["Grade 6"]', created_at: new Date('2020-10-16T08:00:00Z') },
    { id: 63, subject_id: 2, grade_level: 'Grade 3', target_year_levels_json: '["Grade 3"]', created_at: new Date('2020-09-20T10:00:00Z') }
  ];
  db.monthActivities = [
    { id: 71, module_id: 61, created_at: new Date('2020-10-15T23:59:00Z'), submitted: 0 }, // the last minute of the last day
    { id: 72, module_id: 61, created_at: new Date('2020-10-16T00:00:00Z'), submitted: 0 }, // the first minute after it
    { id: 73, module_id: 62, created_at: new Date('2020-10-17T09:00:00Z'), submitted: 0 }, // in a module added after it
    { id: 74, module_id: 63, created_at: new Date('2020-09-21T09:00:00Z'), submitted: 0 } // another grade's
  ];
  db.sat = [];
  let [mine] = await data.getStudentAssignments(5);
  ok('the month is over', mine.month_over === true && mine.month_end === '2020-10-15', `${mine.month_over} ${mine.month_end}`);
  ok('left: the Pre-Assessment, the one activity of that month, the Post-Assessment', mine.remaining === 3, `${mine.remaining}`);
  ok('…so not view-only yet', mine.view_only === false);
  db.sat = [{ subject_id: 2, assessment_kind: 'pre_assessment', grade_level: 'Grade 6' }];
  db.monthActivities[0].submitted = 1;
  [mine] = await data.getStudentAssignments(5);
  ok('the Pre-Assessment and the activity answered: the Post-Assessment left', mine.remaining === 1 && mine.view_only === false, `${mine.remaining}`);
  db.sat.push({ subject_id: 2, assessment_kind: 'post_assessment', grade_level: 'Grade 6' });
  [mine] = await data.getStudentAssignments(5);
  ok('everything of that month answered: view-only — what was added after it does not count', mine.remaining === 0 && mine.view_only === true, `${mine.remaining}`);
  db.sat = [{ subject_id: 2, assessment_kind: 'pre_assessment', grade_level: 'Grade 3' }, { subject_id: 2, assessment_kind: 'post_assessment', grade_level: 'Grade 3' }];
  [mine] = await data.getStudentAssignments(5);
  ok("another grade's Pre-Assessment does not count as theirs", mine.remaining === 1 && mine.view_only === false, `${mine.remaining}`);
  db.assignments = [{ ...db.assignments[0], start_date: '2099-01-01', end_date: '2099-02-01' }];
  const reads = db.reads;
  [mine] = await data.getStudentAssignments(5);
  ok('while the month runs: not over, nothing counted, not view-only — and nothing extra read',
    mine.month_over === false && mine.remaining === null && mine.view_only === false && db.reads === reads + 1, `${db.reads - reads} read(s)`);

  console.log('\n== where a student stands ==');
  db.user = { id: 5, role: 'student', grade_level: 'Grade 6', year_level: 'Primary Level' };
  db.preRows = [];
  db.postRows = [];
  db.enrolment = { start_date: '2026-01-01', end_date: '2099-02-01' };
  ok('no Pre-Assessment yet: it must come first', (await data.getStudentPostState(5, 2)).status === 'needs_pre');

  db.preRows = [{ id: 70, assessment_id: 9, grade_level: 'Grade 6', percentage: 40, level: 'Beginner' }];
  ok('before the last day: not yet', (await data.getStudentPostState(5, 2)).status === 'not_yet');

  // The enrolment ended yesterday (Manila): the Post-Assessment opened yesterday.
  const yesterday = require('../lib/utils').todayDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
  db.enrolment = { start_date: '2026-01-01', end_date: yesterday };
  const open = await data.getStudentPostState(5, 2);
  ok('from the last day: open', open.status === 'open', `${open.status} (ended ${yesterday})`);
  ok('it repeats the Pre-Assessment the student took', open.preSubmission && open.preSubmission.assessment_id === 9);

  db.enrolment = { start_date: '2020-01-01', end_date: '2020-02-01' };
  ok('long after the month, not taken: still open', (await data.getStudentPostState(5, 2)).status === 'open');
  db.preRows = [];
  ok('…once the Pre-Assessment it repeats is done', (await data.getStudentPostState(5, 2)).status === 'needs_pre');
  db.preRows = [{ id: 70, assessment_id: 9, grade_level: 'Grade 6', percentage: 40, level: 'Beginner' }];

  db.postRows = [{ id: 81, percentage: 75 }];
  ok('once taken: taken', (await data.getStudentPostState(5, 2)).status === 'taken');

  console.log('\n== the Pre-Assessment that counts is the student\'s own grade\'s ==');
  db.preRows = [];
  await data.hasCompletedPreAssessment(5, 2);
  ok('the lookup is filtered to the grade (or to one from before grades)',
    /ta\.grade_level IS NULL OR ta\.grade_level = \?/.test(db.lastSql) && db.lastParams[2] === 'Grade 6',
    JSON.stringify(db.lastParams));

  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'One grade per module, and the last-day Post-Assessment, hold.'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error('ERROR', error.stack || error.message); process.exit(1); });
