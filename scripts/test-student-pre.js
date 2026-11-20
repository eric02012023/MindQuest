/**
 * File: scripts/test-student-pre.js
 * Purpose: Pin down each student's own Pre-Assessment (lib/studentPre.js): the
 *          AI writes one master per subject and grade, and every student gets a
 *          copy that their tutor checks and opens before they can take it.
 *
 * Run:  node scripts/test-student-pre.js       (needs no database, no keys)
 *
 * WHAT MUST HOLD
 *   1. A student with no grade, or whose grade has no readable handout, gets no
 *      copy; a missing master is asked for in the background, never waited on.
 *   2. The copy is the master's questions and choices, the student's alone
 *      (for_student_id), unpublished, a draft — and their tutor is told.
 *   3. Without `create` nothing is written: a page may only look.
 *   4. A draft nobody edited takes a newer master by itself; an edited one is
 *      left as it is and the newer one is offered instead.
 *   5. Opening publishes it, tells the student, and happens once; a copy with
 *      no questions cannot be opened.
 *   6. The check page knows a copy: Multiple Choice only, every question in one
 *      of the student's grade's modules, a handout kept only with its module.
 *   7. A new master retires only the old master — never a student's copy.
 *   8. A reset removes the copy, after the result that points at it.
 *   9. The app is told why the student cannot start yet.
 *
 * `config/db`, the warm-up and the AI service are replaced in the require cache
 * before anything loads them. Nothing dials out.
 */
process.env.LEARNING_PATH_JOBS = 'off';

const crypto = require('crypto');

let failures = 0;
const ok = (label, condition, extra = '') => {
  if (condition) console.log(`  PASS  ${label}${extra ? ' — ' + extra : ''}`);
  else { failures++; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
};

// --- the scripted database ------------------------------------------------
const HANDOUTS = [
  {
    handout_id: 31, file_original_name: 'Fractions.pdf', extracted_text: 'f'.repeat(400), extracted_at: '2026-11-01T00:00:00.000Z',
    module_id: 11, order_number: 1, module_title: 'Fractions', grade_level: 'Grade 3', target_year_levels_json: null
  },
  {
    handout_id: 32, file_original_name: 'Decimals.pdf', extracted_text: 'd'.repeat(300), extracted_at: '2026-11-02T00:00:00.000Z',
    module_id: 12, order_number: 2, module_title: 'Decimals', grade_level: 'Grade 3', target_year_levels_json: null
  }
];

/** The same fingerprint lib/data.js gives a set of handouts, so a master can be current. */
function fingerprintOf(handouts) {
  const parts = handouts.map((h) => `${Number(h.handout_id)}:${String(h.extracted_at || '')}:${String(h.extracted_text || '').length}`).sort();
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
}

function assessment(id, questions) {
  return {
    header: { id, subject_id: 5, subject_name: 'MATHEMATICS', title: 'Pre-Assessment — MATHEMATICS (Grade 3)', is_archived: 0 },
    questions: questions.map((q, i) => ({ id: id * 10 + i, assessment_id: id, points: 1, ...q })),
    options: questions.flatMap((q, i) => (q.choices || []).map((text, n) => ({
      question_id: id * 10 + i, option_label: String.fromCharCode(65 + n), option_text: text
    })))
  };
}

const MASTER = {
  id: 400, subject_id: 5, title: 'Pre-Assessment — MATHEMATICS (Grade 3)', instructions: 'Answer every item.',
  question_type: 'multiple_choice', item_count: 2, handout_version: 3, grade_level: 'Grade 3',
  source_fingerprint: fingerprintOf(HANDOUTS), assessment_kind: 'pre_assessment'
};
const NEWER_MASTER = { ...MASTER, id: 401, title: 'Pre-Assessment — MATHEMATICS (Grade 3)' };

const db = {
  statements: [],
  user: null,
  preDone: null,
  copy: null,
  handouts: [],
  master: null,
  assessments: {},
  edits: 0,
  copyQuestions: 2,
  submissions: 0,
  tutor: { tutor_id: 9, first_name: 'Tess', last_name: 'Uy' },
  modules: [],
  handoutModules: [],
  reset: null,
  insertId: 500
};

function answer(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  db.statements.push({ sql, params });
  if (sql.startsWith('INSERT')) return { insertId: ++db.insertId };
  if (db.reset) {
    if (sql.startsWith('SELECT sub.id FROM tutor_assessment_submissions sub') && sql.includes("'pre_assessment'")) return db.reset.pre;
    if (sql.startsWith('SELECT TOP 1 sub.id FROM tutor_assessment_submissions sub') && sql.includes("'post_assessment'")) return [];
    if (sql.startsWith('SELECT id, post_assessment_id FROM learning_paths')) return [];
    if (sql.startsWith('SELECT id FROM focus_handouts')) return [];
    if (sql.startsWith('SELECT id, assessment_id FROM student_pre_assessments')) return db.reset.copies;
  }
  if (sql.startsWith('SELECT TOP 1 u.*, b.name AS branch_name')) return db.user ? [db.user] : [];
  if (sql.startsWith('SELECT TOP 1 sub.id, sub.percentage')) return db.preDone ? [db.preDone] : [];
  if (sql.startsWith('SELECT spa.*, s.name AS subject_name')) return db.copy ? [db.copy] : [];
  if (sql.startsWith('SELECT h.id AS handout_id')) return db.handouts;
  if (sql.startsWith('SELECT TOP 1 * FROM tutor_assessments WHERE subject_id = ? AND assessment_kind = ?')) return db.master ? [db.master] : [];
  if (sql.startsWith('SELECT ta.*, s.name AS subject_name FROM tutor_assessments ta')) {
    const found = db.assessments[Number(params[0])];
    return found ? [found.header] : [];
  }
  if (sql.startsWith('SELECT q.*, m.order_number AS source_order_number')) {
    const found = db.assessments[Number(params[0])];
    return found ? found.questions : [];
  }
  if (sql.startsWith('SELECT o.* FROM tutor_question_options o')) {
    const found = db.assessments[Number(params[0])];
    return found ? found.options : [];
  }
  if (sql.includes('FROM tutor_assessment_edits e JOIN student_pre_assessments spa')) return [{ n: db.edits }];
  if (sql.startsWith('UPDATE student_pre_assessments SET master_assessment_id')) {
    return db.copy && db.copy.status === 'draft' ? [{ id: db.copy.id }] : [];
  }
  if (sql.startsWith("UPDATE student_pre_assessments SET status = 'open'")) {
    return db.copy && db.copy.status === 'draft' ? [{ id: db.copy.id }] : [];
  }
  if (sql.startsWith('SELECT COUNT(*) AS n FROM tutor_assessment_questions WHERE assessment_id = ?')) return [{ n: db.copyQuestions }];
  if (sql.startsWith('SELECT TOP 1 usa.tutor_id')) return db.tutor ? [db.tutor] : [];
  if (sql.startsWith('SELECT m.*, s.name AS subject_name')) return db.modules;
  if (sql.startsWith('SELECT id, module_id FROM module_handouts WHERE id IN')) return db.handoutModules;
  if (sql.startsWith('SELECT TOP 1 id FROM learning_path_modules WHERE assessment_id = ?')) return [];
  if (sql.startsWith('SELECT TOP 1 id FROM learning_paths WHERE post_assessment_id = ?')) return [];
  if (sql.startsWith('SELECT COUNT(*) AS n FROM tutor_assessment_submissions WHERE assessment_id = ?')) return [{ n: db.submissions }];
  if (sql.startsWith('SELECT TOP 1 id, name, handout_version FROM subjects')) return [{ id: 5, name: 'MATHEMATICS', handout_version: 3 }];
  return [];
}

const stub = (modulePath, exports) => {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

// Every statement goes through answerWith, which a test may swap for a moment.
let answerWith = answer;
stub('../config/db', {
  sql: {},
  baseConfig: {},
  getPool: async () => { throw new Error('the test must never open a connection'); },
  query: async (text, params = []) => answerWith(text, params),
  withTransaction: async (work) => work({ query: async (text, params = []) => [answerWith(text, params)] })
});

// The warm-up: what was asked of it, and what it says it is doing.
const warmupCalls = [];
let warmupState = { status: 'idle' };
stub('../lib/preAssessmentWarmup', {
  schedulePreAssessmentWarmup: (subjectId, grade, reason, options) => { warmupCalls.push({ subjectId, grade, reason, options }); return null; },
  getWarmupState: () => warmupState,
  warmMissingPreAssessments: async () => [],
  DEFAULT_DELAY_MS: 0
});

// The AI: only a new master is ever written in this test.
const known = {
  PRE_POST_QUESTION_TYPES: ['multiple_choice'],
  MODULE_QUESTION_TYPES: ['multiple_choice', 'true_false'],
  generateAssessmentFromHandouts: async () => ({
    questions: [
      { question_text: 'What is 1/2 + 1/2?', question_type: 'multiple_choice', correct_answer: 'A', choices: [{ label: 'A', text: '1' }, { label: 'B', text: '2' }] }
    ],
    kept: 1, requested: 30, provider: 'openai', model: 'test', tokensUsed: 0, rejectedByCheck: 0
  })
};
stub('../services/aiService', new Proxy(known, { get: (target, key) => (key in target ? target[key] : async () => ({})) }));

const studentPre = require('../lib/studentPre');
const paths = require('../lib/learningPaths');
const data = require('../lib/data');

const STUDENT = { id: 50, role: 'student', grade_level: 'Grade 3', first_name: 'Lia', last_name: 'Reyes', branch_id: 2 };
const MODULES = [
  { id: 11, subject_id: 5, order_number: 1, title: 'Fractions', grade_level: 'Grade 3', is_archived: 0 },
  { id: 12, subject_id: 5, order_number: 2, title: 'Decimals', grade_level: 'Grade 3', is_archived: 0 }
];

const COPY = {
  id: 3, student_id: 50, subject_id: 5, grade_level: 'Grade 3', master_assessment_id: 400, assessment_id: 990,
  status: 'draft', subject_name: 'MATHEMATICS', first_name: 'Lia', last_name: 'Reyes', student_branch_id: 2, item_count: 2
};

function fresh(patch = {}) {
  Object.assign(db, {
    statements: [], user: { ...STUDENT }, preDone: null, copy: null, handouts: [...HANDOUTS], master: null,
    assessments: {}, edits: 0, copyQuestions: 2, submissions: 0,
    tutor: { tutor_id: 9, first_name: 'Tess', last_name: 'Uy' }, modules: [...MODULES], handoutModules: [], reset: null
  }, patch);
  warmupCalls.length = 0;
  warmupState = { status: 'idle' };
}

const masterQuestions = [
  { question_text: 'Which fraction is one half?', question_type: 'multiple_choice', correct_answer: 'B', source_module_id: 11, source_handout_id: 31, choices: ['1/3', '1/2', '2/3'] },
  { question_text: 'Which is the same as 0.5?', question_type: 'multiple_choice', correct_answer: 'A', source_module_id: 12, source_handout_id: 32, choices: ['1/2', '1/5'] }
];

const inserts = (prefix) => db.statements.filter((s) => s.sql.startsWith(prefix));
const ran = (prefix) => db.statements.some((s) => s.sql.startsWith(prefix));

async function main() {
  console.log('\n== 1. no grade, no handout, no master yet ==');
  fresh({ user: { ...STUDENT, grade_level: null, year_level: null } });
  let state = await studentPre.preStateFor(50, 5, { create: true });
  ok('no grade on record: not ready, and nothing written', state.state === 'not_ready' && !state.grade && !ran('INSERT'));

  fresh({ handouts: [] });
  state = await studentPre.preStateFor(50, 5, { create: true });
  ok('no readable handout for their grade: not ready', state.state === 'not_ready' && state.grade === 'Grade 3' && !ran('INSERT'));
  ok('…and no master is asked for', warmupCalls.length === 0);

  fresh();
  state = await studentPre.preStateFor(50, 5, { create: true });
  ok('handouts but no master yet: being prepared, nothing copied', state.state === 'preparing' && !ran('INSERT'));
  ok('…and the master is asked for in the background, at once', warmupCalls.length === 1 && warmupCalls[0].grade === 'Grade 3'
    && warmupCalls[0].options && warmupCalls[0].options.delayMs === 0);

  fresh();
  warmupState = { status: 'generating' };
  await studentPre.preStateFor(50, 5, { create: true });
  ok('a master already being written is not asked for twice', warmupCalls.length === 0);

  fresh();
  warmupState = { status: 'error', at: new Date() };
  await studentPre.preStateFor(50, 5, { create: true });
  ok('a master that just failed is not asked for again on every page view', warmupCalls.length === 0);

  console.log('\n== 2. the copy is the master\'s questions, the student\'s alone ==');
  fresh({ master: { ...MASTER }, assessments: { 400: assessment(400, masterQuestions) } });
  // getCopy finds nothing first, then the copy just made.
  let copyReads = 0;
  answerWith = (text, params) => {
    const sql = String(text).replace(/\s+/g, ' ').trim();
    if (sql.startsWith('SELECT spa.*, s.name AS subject_name')) {
      copyReads += 1;
      db.statements.push({ sql, params });
      return copyReads === 1 ? [] : [{ ...COPY }];
    }
    return answer(text, params);
  };
  state = await studentPre.preStateFor(50, 5, { create: true, notifyTutor: true });
  answerWith = answer;
  const header = inserts('INSERT INTO tutor_assessments')[0];
  ok('a draft copy is made', state.state === 'draft' && state.created === true && !!state.copy);
  ok('…as a Pre-Assessment for this student alone, unpublished',
    !!header && header.sql.includes("'pre', 'pre_assessment'") && header.sql.includes('VALUES (?, NULL, NULL, ?, ?, \'pre\'')
      && header.sql.includes(', 0, ?, ?, ?)') && header.params[header.params.length - 1] === 50,
    header ? JSON.stringify(header.params) : 'no insert');
  const questionInserts = inserts('INSERT INTO tutor_assessment_questions');
  ok('…with every question of the master', questionInserts.length === 2
    && questionInserts[0].params[1] === 'Which fraction is one half?' && questionInserts[0].params[7] === 11 && questionInserts[0].params[8] === 31);
  ok('…and every choice', inserts('INSERT INTO tutor_question_options').length === 5);
  const row = inserts('INSERT INTO student_pre_assessments')[0];
  ok('…recorded as a draft taken from the master', !!row && row.sql.includes("'draft'") && row.params[3] === 400 && row.params[2] === 'Grade 3');
  const told = inserts('INSERT INTO app_notifications')[0];
  ok('the tutor is told it waits to be checked, and the notice opens it',
    !!told && told.params.includes('pre_assessment_ready') && told.params.includes(9)
      && told.params.includes('/tutor/path-assessments/990/edit') && told.params.includes('student_pre_assessment'),
    told ? JSON.stringify(told.params) : 'no notice');

  console.log('\n== 3. without create, a page only looks ==');
  fresh({ master: { ...MASTER }, assessments: { 400: assessment(400, masterQuestions) } });
  state = await studentPre.preStateFor(50, 5, {});
  ok('master ready, no copy: "to make", and nothing written', state.state === 'to_make' && !ran('INSERT') && !ran('UPDATE') && !ran('DELETE'));

  fresh({ preDone: { id: 7001, percentage: 70, level: 'Intermediate', assessment_id: 990, grade_level: 'Grade 3' } });
  state = await studentPre.preStateFor(50, 5, { create: true });
  ok('already taken: taken, and no copy is made', state.state === 'taken' && !ran('INSERT'));

  console.log('\n== 4. a draft follows its master unless it was edited ==');
  fresh({ copy: { ...COPY }, master: { ...MASTER } });
  state = await studentPre.preStateFor(50, 5, { create: true });
  ok('the same master: the draft stays as it is', state.state === 'draft' && !state.newerMaster && !ran('DELETE'));

  fresh({ copy: { ...COPY }, master: { ...NEWER_MASTER }, assessments: { 401: assessment(401, masterQuestions.slice(0, 1)) } });
  state = await studentPre.preStateFor(50, 5, { create: true });
  ok('a newer master, nobody edited the draft: it takes the new questions',
    ran('DELETE FROM tutor_assessment_questions WHERE assessment_id = ?') && inserts('INSERT INTO tutor_assessment_questions').length === 1);
  ok('…without counting as an edit', !ran('INSERT INTO tutor_assessment_edits'));
  ok('…and it records when it did', ran('UPDATE student_pre_assessments SET synced_at'));

  fresh({ copy: { ...COPY }, master: { ...NEWER_MASTER }, edits: 1, assessments: { 401: assessment(401, masterQuestions) } });
  state = await studentPre.preStateFor(50, 5, { create: true });
  ok('a newer master, the draft was edited: it is left alone', state.state === 'draft' && !ran('DELETE'));
  ok('…and the newer version is offered', state.newerMaster === true);

  fresh({ copy: { ...COPY }, master: { ...NEWER_MASTER }, edits: 1, assessments: { 401: assessment(401, masterQuestions) } });
  await studentPre.useNewVersion(3, 9);
  const editRow = inserts('INSERT INTO tutor_assessment_edits')[0];
  const syncAt = db.statements.findIndex((s) => s.sql.startsWith('UPDATE student_pre_assessments SET synced_at'));
  const editAt = db.statements.findIndex((s) => s.sql.startsWith('INSERT INTO tutor_assessment_edits'));
  ok('"Use the New Version" replaces the questions and is recorded as an edit by whoever asked',
    ran('DELETE FROM tutor_assessment_questions WHERE assessment_id = ?') && !!editRow && editRow.params[1] === 9);
  ok('…recorded before the sync time, so it does not keep the next master out', editAt > -1 && syncAt > editAt);

  fresh({ copy: { ...COPY, status: 'open' }, master: { ...NEWER_MASTER } });
  state = await studentPre.preStateFor(50, 5, { create: true });
  ok('an open copy never changes', state.state === 'open' && !ran('DELETE') && !ran('UPDATE'));

  console.log('\n== 5. opening it ==');
  fresh({ copy: { ...COPY } });
  await studentPre.openCopy(3, 9);
  const opened = db.statements.find((s) => s.sql.startsWith("UPDATE student_pre_assessments SET status = 'open'"));
  ok('the copy is opened by whoever opened it', !!opened && opened.params[0] === 9);
  ok('…and published, so the student can take it', ran('UPDATE tutor_assessments SET is_published = 1'));
  const toStudent = inserts('INSERT INTO app_notifications').find((s) => s.params.includes('pre_assessment_open'));
  ok('…and the student is told, the notice opening their subject',
    !!toStudent && toStudent.params.includes(50) && toStudent.params.includes('/student/subjects/5'));

  fresh({ copy: { ...COPY, status: 'open' } });
  const twice = await studentPre.openCopy(3, 9).then(() => null, (error) => error.message);
  ok('it opens once', /open for the student already/.test(String(twice)) && !ran('UPDATE'), twice || '');

  fresh({ copy: { ...COPY }, copyQuestions: 0 });
  const empty = await studentPre.openCopy(3, 9).then(() => null, (error) => error.message);
  ok('a copy with no questions cannot be opened', /no questions/.test(String(empty)) && !ran('UPDATE'), empty || '');

  console.log('\n== 6. the check page knows a student\'s Pre-Assessment ==');
  fresh({ copy: { ...COPY } });
  const owner = await paths.getPersonalOwner(990);
  ok('a copy is owned by its student, as a Pre-Assessment', !!owner && owner.kind === 'pre' && owner.copy.id === 3);
  let state6 = await paths.editableState(990);
  ok('a draft with no answers can be edited', state6.ok === true);
  fresh({ copy: { ...COPY, status: 'open' } });
  state6 = await paths.editableState(990);
  ok('an open one cannot', state6.ok === false && /opened for the student already/.test(state6.reason));

  const mc = (patch = {}) => ({
    question_type: 'multiple_choice', question_text: 'Which is bigger, 1/2 or 1/3?', choices: ['1/2', '1/3'], correct_answer: 'A',
    source_module_id: 11, source_handout_id: 31, ...patch
  });
  fresh({ copy: { ...COPY } });
  const trueFalse = await paths.replaceDraftQuestions(990, [mc({ question_type: 'true_false', correct_answer: 'true' })], 9)
    .then(() => null, (error) => error.message);
  ok('Multiple Choice only, as before', /only Multiple Choice/.test(String(trueFalse)), trueFalse || '');

  fresh({ copy: { ...COPY } });
  const noModule = await paths.replaceDraftQuestions(990, [mc(), mc({ source_module_id: null, source_handout_id: null })], 9)
    .then(() => null, (error) => error.message);
  ok('a question with no module of the student\'s grade is refused, by number', /Question 2: choose the module/.test(String(noModule)), noModule || '');
  const otherGrade = await paths.replaceDraftQuestions(990, [mc({ source_module_id: 77 })], 9).then(() => null, (error) => error.message);
  ok('…a module of another grade too', /Question 1: choose the module/.test(String(otherGrade)), otherGrade || '');

  fresh({ copy: { ...COPY }, handoutModules: [{ id: 31, module_id: 11 }] });
  const saved = await paths.replaceDraftQuestions(990, [mc(), mc({ source_module_id: 12, question_text: 'Moved to Decimals by the tutor' })], 9);
  const written = inserts('INSERT INTO tutor_assessment_questions');
  ok('the questions are saved', saved.count === 2 && written.length === 2);
  ok('a handout stays with its own module', written[0].params[7] === 11 && written[0].params[8] === 31);
  ok('…and is dropped when the question moves to another module', written[1].params[7] === 12 && written[1].params[8] === null,
    JSON.stringify(written[1].params.slice(7)));
  ok('the save is recorded as an edit', ran('INSERT INTO tutor_assessment_edits'));

  fresh({ copy: { ...COPY }, master: { ...NEWER_MASTER }, edits: 1, assessments: { 990: assessment(990, masterQuestions) } });
  const page = await paths.editPageData(990, { follow: true });
  ok('the check page: the student, the modules a question can belong to',
    !!page && page.kind === 'pre' && page.studentId === 50 && page.studentLabel === 'Lia Reyes'
      && page.moduleChoices.map((m) => m.label).join(' | ') === 'Module 1: Fractions | Module 2: Decimals');
  ok('…Multiple Choice only, and the newer version offered', page.allowedTypes.join(',') === 'multiple_choice' && page.newerMaster === true);

  console.log('\n== 7. a new master retires only the old master ==');
  fresh({ master: null });
  await data.getOrCreatePreAssessment(5, 'Grade 3');
  const retire = db.statements.find((s) => s.sql.startsWith('UPDATE tutor_assessments SET is_archived = 1') && s.sql.includes("'pre_assessment'"));
  ok('the old master is retired, the students\' copies are not', !!retire && retire.sql.includes('AND for_student_id IS NULL'),
    retire ? retire.sql : 'no retire statement');

  console.log('\n== 8. a reset removes the copy after the result ==');
  fresh({ reset: { pre: [{ id: 7001 }], copies: [{ id: 3, assessment_id: 990 }] } });
  await paths.resetPreAssessmentFor(50, 5);
  const at = (prefix) => db.statements.findIndex((s) => s.sql.startsWith(prefix));
  const resultGone = at('DELETE FROM tutor_assessment_submissions WHERE id IN');
  const copyGone = at('DELETE FROM student_pre_assessments WHERE id IN');
  const assessmentGone = db.statements.findIndex((s) => s.sql.startsWith('DELETE FROM tutor_assessments WHERE id IN') && s.sql.includes('for_student_id = ?'));
  ok('the copy goes, after the result that pointed at it', resultGone > -1 && copyGone > resultGone && assessmentGone > copyGone,
    `result ${resultGone}, copy ${copyGone}, assessment ${assessmentGone}`);
  ok('…its questions, its notices and its edits go with it',
    ran('DELETE FROM tutor_assessment_questions WHERE assessment_id IN') && ran("DELETE FROM app_notifications WHERE ref_type = 'student_pre_assessment'")
      && ran('DELETE FROM tutor_assessment_edits WHERE assessment_id IN'));
  const scoped = db.statements.find((s) => s.sql.startsWith('SELECT id, assessment_id FROM student_pre_assessments'));
  ok('…in that subject only', !!scoped && scoped.sql.includes('AND subject_id = ?') && scoped.params[1] === 5);

  console.log('\n== 9. the app says why the student cannot start yet ==');
  const { SERIALIZERS } = require('../lib/mobileSerializers');
  const subjectPage = (preState) => SERIALIZERS['student-subject-detail']({
    assignment: { subject_id: 5, subject_name: 'MATHEMATICS' },
    preAssessmentDone: null,
    newModules: MODULES,
    gradeLevel: 'Grade 3',
    downPayment: { satisfied: true },
    handoutsReady: 2,
    completion: {},
    preState
  }).preGate;
  const waiting = subjectPage({ state: 'draft' });
  ok('a draft: the tutor is checking it', !waiting.canStart && waiting.reason === 'waiting_tutor' && /tutor is checking/.test(waiting.message));
  const preparing = subjectPage({ state: 'preparing' });
  ok('no copy yet: being prepared', !preparing.canStart && preparing.reason === 'preparing' && /being prepared/.test(preparing.message));
  const open = subjectPage({ state: 'open' });
  ok('opened: they can start', open.canStart === true && open.reason === null);

  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'Each student\'s Pre-Assessment holds: copied from the master, checked and opened by their tutor, never changed once open.'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
