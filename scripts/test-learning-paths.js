/**
 * File: scripts/test-learning-paths.js
 * Purpose: Pin down learning paths (lib/learningPaths.js): each student's own
 *          copy of their modules, opened one after another as they pass.
 *
 * Run:  node scripts/test-learning-paths.js       (needs no database, no keys)
 *
 * WHAT MUST HOLD
 *   1. Intermediate (51%) or better passes a module; 50% does not.
 *   2. A student's copy of a module keeps EVERY original page, in order, and
 *      only adds pages — each right after the page it belongs to.
 *   3. The added lessons come only from what the student got wrong, and a bad
 *      page number from the AI is put back in range instead of failing.
 *   4. One student's assessment never shows up as a module's shared activity.
 *   5. A take is graded, kept, and — passed — opens the next module; not passed,
 *      it waits for the tutor to open another take. The last module passed makes
 *      the Post-Assessment due. The submission row stays one per student.
 *   6. A retake shows the questions in another order without changing the key.
 *   7. Only an unopened assessment can be edited, and an edit is checked.
 *
 * `config/db` is replaced in the require cache before anything loads it, and
 * `fetch` is replaced before services/aiService.js loads. Nothing dials out.
 */
process.env.AI_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key-0000000000000000';
process.env.LEARNING_PATH_JOBS = 'off';

let failures = 0;
const ok = (label, condition, extra = '') => {
  if (condition) console.log(`  PASS  ${label}${extra ? ' — ' + extra : ''}`);
  else { failures++; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
};

// --- the scripted database ------------------------------------------------
const db = {
  statements: [],
  pathModule: null,     // getPathModuleById's row
  assessment: null,     // getAssessmentWithQuestions' answer
  submissions: [],      // existing tutor_assessment_submissions rows
  takesUpdate: true,    // whether the takes_used UPDATE finds its row
  nextLocked: null,     // the id unlockNext opens, or null when none is left
  insertId: 900
};

function answer(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  db.statements.push({ sql, params });
  if (sql.startsWith('INSERT')) return { insertId: ++db.insertId };
  if (sql.includes('FROM learning_path_modules lpm JOIN learning_paths lp')) return db.pathModule ? [db.pathModule] : [];
  if (sql.startsWith('SELECT ta.*, s.name AS subject_name FROM tutor_assessments ta')) return db.assessment ? [db.assessment.header] : [];
  if (sql.startsWith('SELECT q.*, m.order_number AS source_order_number')) return db.assessment ? db.assessment.questions : [];
  if (sql.startsWith('SELECT * FROM tutor_question_options')) return db.assessment ? db.assessment.options : [];
  if (sql.startsWith('UPDATE learning_path_modules SET takes_used = takes_used + 1')) {
    return db.takesUpdate ? [{ takes_used: Number(db.pathModule.takes_used) + 1 }] : [];
  }
  if (sql.startsWith('SELECT TOP 1 id FROM tutor_assessment_submissions')) return db.submissions;
  if (sql.startsWith('UPDATE learning_path_modules SET status = \'open\', unlocked_at')) {
    return db.nextLocked ? [{ id: db.nextLocked }] : [];
  }
  if (sql.includes('FROM student_subject_levels')) return [];
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

// --- the AI, answered locally ----------------------------------------------
const sent = [];
let additionsReply = () => ({ additions: [] });
global.fetch = (url, options) => {
  const body = JSON.parse(options.body);
  const system = body.messages[0].content;
  sent.push({ url, system, user: body.messages[1].content });
  const payload = /You add teaching to ONE learner/.test(system) ? additionsReply(body) : { questions: [] };
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(payload) } }], usage: { total_tokens: 42 } })
  });
};

const { PDFDocument, StandardFonts } = require('pdf-lib');
const paths = require('../lib/learningPaths');
const data = require('../lib/data');
const ai = require('../services/aiService');
const { composeModulePdf, readPageTexts } = require('../lib/modulePdf');

async function samplePdf(pageTexts) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pageTexts) {
    const page = doc.addPage([400, 500]);
    page.drawText(text, { x: 40, y: 440, size: 14, font });
  }
  return Buffer.from(await doc.save());
}

const LONG_TEXT = 'Energy is the ability to do work. '.repeat(12);

async function main() {
  console.log('\n== Intermediate or better passes ==');
  ok('50% does not pass', paths.passes(50) === false);
  ok('60% passes', paths.passes(60) === true);
  ok('100% passes', paths.passes(100) === true);
  ok('0% does not pass', paths.passes(0) === false);

  console.log('\n== where a module\'s assessment stands ==');
  const base = { status: 'open', assessment_id: 5, assessment_status: 'open', takes_opened: 1, takes_used: 0 };
  ok('a locked module: locked', paths.takeState({ ...base, status: 'locked' }) === 'locked');
  ok('not written yet: preparing', paths.takeState({ ...base, assessment_id: null, assessment_status: 'pending' }) === 'preparing');
  ok('written, not opened: waiting for the tutor', paths.takeState({ ...base, assessment_status: 'draft' }) === 'waiting_tutor');
  ok('opened, not taken: can take', paths.takeState(base) === 'can_take');
  ok('taken without passing: waits for the next take', paths.takeState({ ...base, takes_used: 1 }) === 'waiting_retake');
  ok('the tutor opened take 2: can take', paths.takeState({ ...base, takes_used: 1, takes_opened: 2 }) === 'can_take');
  ok('passed: passed', paths.takeState({ ...base, status: 'passed', assessment_status: 'passed' }) === 'passed');

  console.log('\n== what is due ==');
  ok('added pages still to write: due', paths.wantsAdditions({ status: 'locked', additions_status: 'pending', additions_attempts: 0 }));
  ok('failed three times: waits for a person', !paths.wantsAdditions({ status: 'open', additions_status: 'failed', additions_attempts: 3 }));
  ok('an open module with its pages written and no assessment: assessment due',
    paths.wantsAssessment({ status: 'open', assessment_id: null, additions_status: 'ready', assessment_status: 'waiting', assessment_attempts: 0 }));
  ok('a locked module gets no assessment yet',
    !paths.wantsAssessment({ status: 'locked', assessment_id: null, additions_status: 'ready', assessment_status: 'waiting', assessment_attempts: 0 }));
  ok('no assessment while its added pages are still being written',
    !paths.wantsAssessment({ status: 'open', assessment_id: null, additions_status: 'generating', assessment_status: 'waiting', assessment_attempts: 0 }));
  ok('added pages that failed for good still let the assessment be written',
    paths.wantsAssessment({ status: 'open', assessment_id: null, additions_status: 'failed', additions_attempts: 3, assessment_status: 'waiting', assessment_attempts: 0 }));
  ok('the Post is due once marked pending', paths.wantsPost({ post_status: 'pending', post_assessment_id: null }));
  ok('…but not while waiting for the modules', !paths.wantsPost({ post_status: 'waiting', post_assessment_id: null }));

  console.log('\n== the student\'s copy keeps every original page ==');
  const original = await samplePdf(['PAGE ONE about energy', 'PAGE TWO about heat', 'PAGE THREE about sound']);
  const composed = await composeModulePdf({
    moduleTitle: 'Module 1: Energy',
    studentName: 'Ana Reyes',
    parts: [{
      name: 'Module1.pdf',
      buffer: original,
      additions: [
        { after_page: 2, title: 'Heat, step by step', text: `${LONG_TEXT}\n- one\n- two\nAnswer: heat` },
        { after_page: 99, title: 'Past the last page', text: LONG_TEXT }
      ]
    }]
  });
  ok('three original pages, two added', composed.originalPages === 3 && composed.addedPages === 2 && composed.pages === 5,
    `${composed.originalPages} + ${composed.addedPages} = ${composed.pages}`);
  const pagesRead = await readPageTexts(composed.bytes);
  const order = pagesRead.map((p) => (/PAGE ONE/.test(p.text) ? '1' : /PAGE TWO/.test(p.text) ? '2' : /PAGE THREE/.test(p.text) ? '3' : /ADDED FOR YOU/.test(p.text) ? '+' : '?')).join('');
  ok('in order, each addition right after its page; an out-of-range one last', order === '12+3+', order);
  ok('the added page says what it is', /Heat, step by step/.test(pagesRead[2].text));
  const untouched = await composeModulePdf({ moduleTitle: 'M', parts: [{ name: 'a.pdf', buffer: original, additions: [] }] });
  ok('nothing missed: the module is its own pages only', untouched.pages === 3 && untouched.addedPages === 0);
  const unreadable = await composeModulePdf({ moduleTitle: 'M', parts: [{ name: 'a.pdf', buffer: Buffer.from('not a pdf'), additions: [{ after_page: 1, title: 'T', text: LONG_TEXT }] }] });
  ok('a file that cannot be read still gives a module, not an error', unreadable.pages >= 2 && unreadable.originalPages === 0);

  console.log('\n== the added lessons come from what they got wrong ==');
  additionsReply = () => ({
    additions: [
      { after_page: 7, title: 'Heat energy', text: LONG_TEXT },
      { after_page: 'two', title: 'Too short', text: 'short' },
      { after_page: 0, title: 'Sound', text: `## Heading\n**bold** ${LONG_TEXT}` }
    ]
  });
  const written = await ai.generateModuleAdditions({
    pages: [{ num: 1, text: 'PAGE ONE about energy' }, { num: 2, text: 'PAGE TWO about heat' }, { num: 3, text: 'PAGE THREE about sound' }],
    missed: [{ question_text: 'What gives heat energy?', correct_text: 'Fire', explanation: 'Fire is hot.' }],
    level: 'Beginner',
    subject: 'Science',
    gradeLevel: 'Grade 4',
    moduleTitle: 'Energy'
  });
  const prompt = sent[sent.length - 1];
  ok('the prompt carries the missed question and its answer', /What gives heat energy\?/.test(prompt.user) && /Correct answer: Fire/.test(prompt.user));
  ok('the prompt carries the pages by number', /=== Page 2 ===/.test(prompt.user));
  ok('the prompt forbids removing or rewriting pages', /never remove, shorten, correct or rewrite them/.test(prompt.system));
  ok('a page past the end is put on the last page', written.additions[0].after_page === 3, `${written.additions[0].after_page}`);
  ok('a lesson too short to use is dropped', written.additions.length === 2);
  ok('page 0 becomes page 1, and markdown is cleaned', written.additions[1].after_page === 1 && !/\*\*|##/.test(written.additions[1].text));
  const nothingMissed = await ai.generateModuleAdditions({ pages: [], missed: [] });
  ok('nothing missed: no AI call, nothing added', nothingMissed.additions.length === 0);
  additionsReply = () => ({ additions: [{ after_page: 1, title: 'x', text: 'tiny' }] });
  let thrown = '';
  try { await ai.generateModuleAdditions({ pages: [{ num: 1, text: 'PAGE' }], missed: [{ question_text: 'Q?' }] }); } catch (e) { thrown = e.message; }
  ok('nothing usable back: a clear error, recorded as a failure', /no added lesson/.test(thrown), thrown);

  console.log('\n== one student\'s assessment is never a module\'s shared activity ==');
  db.statements = [];
  await data.getTutorAssessmentsByModule(4);
  ok('the module\'s list leaves personal assessments out', /for_student_id IS NULL/.test(db.statements[0].sql));
  db.statements = [];
  await data.getSubjectModules(4);
  ok('the module\'s assessment count does too', /for_student_id IS NULL/.test(db.statements[0].sql));

  console.log('\n== a retake shows another order, with the same key ==');
  const questions = [1, 2, 3, 4, 5].map((n) => ({
    id: n,
    question_type: 'multiple_choice',
    correct_answer: 'B',
    options: ['A', 'B', 'C', 'D'].map((label) => ({ option_label: label, option_text: `${label}${n}` }))
  }));
  ok('take 1: the order the tutor checked', paths.questionsForTake(questions, 50, 1) === questions);
  const take2 = paths.questionsForTake(questions, 50, 2);
  const again = paths.questionsForTake(questions, 50, 2);
  ok('take 2: the same order on a reload', JSON.stringify(take2.map((q) => q.id)) === JSON.stringify(again.map((q) => q.id)));
  ok('take 2 differs from take 3', JSON.stringify(take2.map((q) => q.id)) !== JSON.stringify(paths.questionsForTake(questions, 50, 3).map((q) => q.id))
    || JSON.stringify(take2[0].options.map((o) => o.option_label)) !== JSON.stringify(paths.questionsForTake(questions, 50, 3)[0].options.map((o) => o.option_label)));
  ok('every question is still there once', take2.map((q) => q.id).sort().join(',') === '1,2,3,4,5');
  ok('each choice shows the letter of its new place', take2.every((q) => q.options.map((o) => o.display_label).join('') === 'ABCD'));
  ok('…while its answer value is the original one', take2.every((q) => q.options.map((o) => o.option_label).sort().join('') === 'ABCD'));

  console.log('\n== a take: graded, kept, and the next module opens on a pass ==');
  const opts = (id) => ['A', 'B', 'C', 'D'].map((label) => ({ question_id: id, option_label: label, option_text: `${label}${id}` }));
  db.assessment = {
    header: { id: 77, subject_id: 2, title: 'Module 1 Assessment', subject_name: 'SCIENCE' },
    questions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ id: n, question_type: 'multiple_choice', correct_answer: 'A', points: 1 })),
    options: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].flatMap(opts)
  };
  db.pathModule = {
    id: 11, path_id: 3, module_id: 61, position: 1, order_number: 1, status: 'open', assessment_id: 77,
    assessment_status: 'open', takes_opened: 1, takes_used: 0, additions_json: '[]',
    student_id: 5, subject_id: 2, placement_level: 'Beginner', first_name: 'Ana', last_name: 'Reyes'
  };
  const answersRight = (n) => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((id) => ({ question_id: id, student_answer: id <= n ? 'A' : 'B' }));

  db.statements = [];
  db.submissions = [];
  db.nextLocked = 12;
  const failed = await paths.submitModuleAttempt({ pathModuleId: 11, studentId: 5, answers: answersRight(4) });
  ok('4 of 10 is 40%: not passed', failed.percentage === 40 && failed.passed === false, `${failed.percentage}`);
  const sqlOf = () => db.statements.map((s) => s.sql);
  ok('the take is kept', sqlOf().some((s) => s.startsWith('INSERT INTO tutor_assessment_attempts')));
  ok('…with its answers', sqlOf().filter((s) => s.startsWith('INSERT INTO tutor_assessment_attempt_answers')).length === 10);
  ok('the first take writes the one submission row', sqlOf().some((s) => s.startsWith('INSERT INTO tutor_assessment_submissions')));
  ok('not passed: the module is not passed', !sqlOf().some((s) => s.includes("SET status = 'passed'")));
  ok('…and nothing new opens', !sqlOf().some((s) => s.startsWith("UPDATE learning_path_modules SET status = 'open'")));

  db.statements = [];
  db.submissions = [{ id: 400 }];
  db.pathModule = { ...db.pathModule, takes_opened: 2, takes_used: 1 };
  const passedTake = await paths.submitModuleAttempt({ pathModuleId: 11, studentId: 5, answers: answersRight(6) });
  ok('6 of 10 is 60%: passed', passedTake.percentage === 60 && passedTake.passed === true, `${passedTake.percentage}`);
  ok('a retake updates the same submission row, never a second one',
    sqlOf().some((s) => s.startsWith('UPDATE tutor_assessment_submissions SET score'))
    && !sqlOf().some((s) => s.startsWith('INSERT INTO tutor_assessment_submissions')));
  ok('…and replaces its answers with this take\'s', sqlOf().some((s) => s.startsWith('DELETE FROM tutor_student_answers')));
  ok('the take is number 2', passedTake.attemptNumber === 2);
  ok('passed: the module is marked passed', sqlOf().some((s) => s.includes("SET status = 'passed', assessment_status = 'passed'")));
  ok('…and the next module opens', passedTake.nextId === 12);

  db.statements = [];
  db.pathModule = { ...db.pathModule, takes_opened: 3, takes_used: 2 };
  db.nextLocked = null;
  const last = await paths.submitModuleAttempt({ pathModuleId: 11, studentId: 5, answers: answersRight(10) });
  ok('the last module passed: no module left to open', last.nextId === null);
  ok('…so the Post-Assessment is due', sqlOf().some((s) => s.includes("SET post_status = 'pending'")));

  db.takesUpdate = false;
  let refused = '';
  try { await paths.submitModuleAttempt({ pathModuleId: 11, studentId: 5, answers: answersRight(10) }); } catch (e) { refused = e.message; }
  ok('a second submit of the same take is refused', /submitted already/.test(refused), refused);
  db.takesUpdate = true;
  refused = '';
  db.pathModule = { ...db.pathModule, takes_opened: 1, takes_used: 1 };
  try { await paths.submitModuleAttempt({ pathModuleId: 11, studentId: 5, answers: answersRight(10) }); } catch (e) { refused = e.message; }
  ok('no take open: refused before grading', /not open for you/.test(refused), refused);
  refused = '';
  db.pathModule = { ...db.pathModule, takes_opened: 2 };
  try { await paths.submitModuleAttempt({ pathModuleId: 11, studentId: 6, answers: answersRight(10) }); } catch (e) { refused = e.message; }
  ok('another student cannot submit it', /not found/.test(refused), refused);

  console.log('\n== an edit is checked ==');
  const mc = { question_type: 'multiple_choice', question_text: 'Which gives heat?', choices: ['Fire', 'Ice', 'Snow'], correct_answer: 'A' };
  const cleaned = paths.cleanEditedQuestions([mc, { question_type: 'true_false', question_text: 'The sun gives light.', correct_answer: 'TRUE' }], ['multiple_choice', 'true_false']);
  ok('a good edit comes back labelled', cleaned[0].choices.map((c) => c.label).join('') === 'ABC' && cleaned[0].correct_answer === 'A' && cleaned[1].correct_answer === 'true');
  const refuse = (list, types = ['multiple_choice', 'true_false']) => { try { paths.cleanEditedQuestions(list, types); return ''; } catch (e) { return e.message; } };
  ok('no questions: refused', /at least one/.test(refuse([])));
  ok('a key that is not a choice: refused', /one of its choices/.test(refuse([{ ...mc, correct_answer: 'D' }])));
  ok('two choices the same: refused', /same thing/.test(refuse([{ ...mc, choices: ['Fire', 'fire'] }])));
  ok('one choice only: refused', /at least two/.test(refuse([{ ...mc, choices: ['Fire'] }])));
  ok('True or False on a Post-Assessment (Multiple Choice only): refused',
    /only Multiple Choice/.test(refuse([{ question_type: 'true_false', question_text: 'The sun gives light.', correct_answer: 'true' }], ['multiple_choice'])));
  ok('a blank question: refused', /needs its text/.test(refuse([{ ...mc, question_text: ' ' }])));

  console.log('\n== the topics of a take, as the breakdown shows them ==');
  const topics = paths.weakAreasFromAnswers([
    { source_module_id: 61, source_handout_id: 97, source_module_title: 'Energy', is_correct: true },
    { source_module_id: 61, source_handout_id: 97, source_module_title: 'Energy', is_correct: false },
    { source_module_id: 61, source_handout_id: 97, source_module_title: 'Energy', is_correct: 0 }
  ]);
  ok('grouped per handout, with the share right', topics.length === 1 && topics[0].correct === 1 && topics[0].total === 3 && topics[0].is_weak === true);

  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'Learning paths hold: every page kept, a pass opens the next module, a retake waits for the tutor.'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
