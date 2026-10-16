/**
 * File: scripts/test-module-grades.js
 * Purpose: Pin down "one grade per module" and "the Post-Assessment opens on the
 *          last day of the enrolment".
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
  enrolment: null,      // getPostAssessmentWindow answers
  user: { id: 5, role: 'student', grade_level: 'Grade 6', year_level: 'Primary Level' }
};

function answer(text, params) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  db.lastSql = sql;
  db.lastParams = params;
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

  console.log('\n== …and closes five days later ==');
  const febWindow = data.postWindowFor(enrolledJan1);
  ok('it is open for five days: the last day and the four after it', data.POST_ASSESSMENT_OPEN_DAYS === 5);
  ok('the last minute is 11:59 PM Manila on 5 February', febWindow.openUntil && febWindow.openUntil.toISOString() === '2026-02-05T15:59:00.000Z',
    febWindow.openUntil && febWindow.openUntil.toISOString());
  ok('it closes at 12:00 AM on 6 February', febWindow.closesAt && febWindow.closesAt.toISOString() === '2026-02-05T16:00:00.000Z',
    febWindow.closesAt && febWindow.closesAt.toISOString());
  const at = (iso) => data.postWindowFor(enrolledJan1, new Date(iso));
  ok('still open at 11:59 PM on the fifth day', at('2026-02-05T15:59:59Z').isOpen === true && at('2026-02-05T15:59:59Z').isClosed === false);
  ok('closed from 12:00 AM on the sixth day', at('2026-02-05T16:00:00Z').isOpen === false && at('2026-02-05T16:00:00Z').isClosed === true);
  ok('and closed for good after that', at('2026-03-20T04:00:00Z').isOpen === false && at('2026-03-20T04:00:00Z').isClosed === true);
  ok('not "closed" before it ever opened', at('2026-01-20T04:00:00Z').isClosed === false);
  const lateFeb = data.postWindowFor({ start_date: '2026-01-26', end_date: '2026-02-26' });
  ok('the five days run across a month end (26 February -> 2 March)', lateFeb.openUntil.toISOString() === '2026-03-02T15:59:00.000Z', lateFeb.openUntil.toISOString());

  console.log('\n== once the Post-Assessment is done — taken, or closed — the subject is view-only ==');
  const finished = (row, post, iso) => data.subjectFinishedState(row, post, new Date(iso));
  ok('during the month: theirs to work in', finished(enrolledJan1, null, '2026-01-20T04:00:00Z').viewOnly === false);
  ok('the last day, and the five days of the Post-Assessment not yet taken: still theirs',
    finished(enrolledJan1, null, '2026-02-01T04:00:00Z').viewOnly === false && finished(enrolledJan1, null, '2026-02-05T15:59:00Z').viewOnly === false);
  ok('the five days over without it: view only ("closed")', finished(enrolledJan1, null, '2026-02-05T16:00:00Z').reason === 'closed');
  const takenOnLastDay = { submitted_at: new Date('2026-02-01T03:00:00Z') };
  ok('the Post-Assessment taken: view only at once ("taken")', finished(enrolledJan1, takenOnLastDay, '2026-02-01T04:00:00Z').reason === 'taken'
    && finished(enrolledJan1, takenOnLastDay, '2026-02-01T04:00:00Z').viewOnly === true);
  const enrolledAgain = { start_date: '2026-03-01', end_date: '2026-04-01' };
  ok('enrolled again: a Post-Assessment from the earlier month does not finish the new one',
    finished(enrolledAgain, { submitted_at: new Date('2026-02-02T03:00:00Z') }, '2026-03-10T04:00:00Z').viewOnly === false);
  ok('…but the new month\'s five days running out does', finished(enrolledAgain, { submitted_at: new Date('2026-02-02T03:00:00Z') }, '2026-04-06T04:00:00Z').reason === 'closed');
  ok('an end date read from the database as a Date counts as its day',
    finished({ end_date: new Date('2026-02-01T00:00:00Z') }, null, '2026-02-05T16:00:00Z').reason === 'closed'
    && finished({ end_date: new Date('2026-02-01T00:00:00Z') }, null, '2026-02-05T15:59:00Z').viewOnly === false);

  console.log('\n== where a student stands ==');
  db.user = { id: 5, role: 'student', grade_level: 'Grade 6', year_level: 'Primary Level' };
  db.preRows = [];
  db.postRows = [];
  db.enrolment = { start_date: '2026-01-01', end_date: '2099-02-01' };
  ok('no Pre-Assessment yet: it must come first', (await data.getStudentPostState(5, 2)).status === 'needs_pre');

  db.preRows = [{ id: 70, assessment_id: 9, grade_level: 'Grade 6', percentage: 40, level: 'Beginner' }];
  ok('before the last day: not yet', (await data.getStudentPostState(5, 2)).status === 'not_yet');

  // The enrolment ended yesterday (Manila): the Post-Assessment opened yesterday
  // and is open for four more days.
  const yesterday = require('../lib/utils').todayDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
  db.enrolment = { start_date: '2026-01-01', end_date: yesterday };
  const open = await data.getStudentPostState(5, 2);
  ok('within its five days: open', open.status === 'open', `${open.status} (ended ${yesterday})`);
  ok('it repeats the Pre-Assessment the student took', open.preSubmission && open.preSubmission.assessment_id === 9);
  ok('and it says until when', open.openUntil instanceof Date && open.openUntil.getTime() > Date.now());

  db.enrolment = { start_date: '2020-01-01', end_date: '2020-02-01' };
  ok('five days after it opened, not taken: closed', (await data.getStudentPostState(5, 2)).status === 'closed');
  db.preRows = [];
  ok('closed, too, for a student who never sat the Pre-Assessment', (await data.getStudentPostState(5, 2)).status === 'closed');
  db.preRows = [{ id: 70, assessment_id: 9, grade_level: 'Grade 6', percentage: 40, level: 'Beginner' }];

  db.postRows = [{ id: 81, percentage: 75 }];
  ok('once taken: taken, closed or not', (await data.getStudentPostState(5, 2)).status === 'taken');

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
