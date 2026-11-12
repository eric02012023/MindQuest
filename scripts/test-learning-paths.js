/**
 * File: scripts/test-learning-paths.js
 * Purpose: Pin down learning paths (lib/learningPaths.js): each student's own
 *          copy of their modules, opened one after another as they pass.
 *
 * Run:  node scripts/test-learning-paths.js       (needs no database, no keys)
 *
 * WHAT MUST HOLD
 *   1. Advance (81%) passes a module; 80% does not.
 *   2. A student's copy of a module keeps EVERY original page, in order, and
 *      only adds pages — each weak point's section right after its page.
 *   3. What is added comes only from what the student got wrong: their weak
 *      points, FIVE topics each, checked against the module; every missed
 *      question belongs to a weak point, and a bad page number from the AI is
 *      put back in range instead of failing.
 *   4. One student's assessment never shows up as a module's shared activity.
 *   5. A take is graded, kept, and — passed — opens the next module; not passed,
 *      the next take opens at once. The last module passed makes the
 *      Post-Assessment due. The submission row stays one per student.
 *   6. A retake shows the questions in another order without changing the key.
 *   7. The Post-Assessment is the Pre-Assessment's own questions, in a new order,
 *      every answer key following its choice.
 *   8. Only an unopened assessment can be edited, and an edit is checked.
 *   9. Every score of a path is listed, and the Pre is set against the Post.
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
  reset: null,          // what resetPreAssessmentFor reads, when set
  post: null,           // what writePost reads, when set
  scores: null,         // what getPathScores reads, when set
  insertId: 900
};

function answer(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  db.statements.push({ sql, params });
  if (sql.startsWith('INSERT')) return { insertId: ++db.insertId };
  if (sql.startsWith('SELECT TOP 1 usa.tutor_id')) return db.assignedTutor ? [db.assignedTutor] : [];
  if (db.boxes) {
    if (sql.startsWith('SELECT DISTINCT usa.subject_id')) return db.boxes.enrolled;
    if (sql.includes("WHERE ta.assessment_kind = 'pre_assessment' AND ta.subject_id IN")) return db.boxes.sittings;
    if (sql.includes('WHERE lp.pre_submission_id IN')) return db.boxes.paths;
  }
  if (db.post) {
    if (sql.startsWith('UPDATE learning_paths SET post_status = \'generating\'')) return [{ id: db.post.path.id }];
    if (sql.includes('FROM learning_paths lp JOIN subjects s')) return [db.post.path];
    if (sql.includes('FROM learning_path_modules lpm LEFT JOIN modules m')) return db.post.modules;
  }
  if (db.scores) {
    if (sql.includes('WHERE sub.id = ? AND sub.student_id = ?')) return db.scores.pre ? [db.scores.pre] : [];
    if (sql.includes('WHERE sub.assessment_id = ? AND sub.student_id = ?')) return db.scores.post ? [db.scores.post] : [];
    if (sql.includes('GROUP BY a.submission_id, q.source_module_id')) return db.scores.tallies;
    if (sql.includes("ta.purpose = 'activity'") && sql.includes('ta.module_id IN')) return db.scores.activities;
  }
  if (db.reset) {
    if (sql.startsWith('SELECT sub.id FROM tutor_assessment_submissions sub') && sql.includes("'pre_assessment'")) return db.reset.pre;
    if (sql.startsWith('SELECT TOP 1 sub.id FROM tutor_assessment_submissions sub') && sql.includes("'post_assessment'")) return db.reset.post;
    if (sql.startsWith('SELECT id, post_assessment_id FROM learning_paths')) return db.reset.paths;
    if (sql.startsWith('SELECT id, assessment_id FROM learning_path_modules')) return db.reset.modules;
    if (sql.startsWith('SELECT id FROM tutor_assessments WHERE id IN')) return db.reset.personal;
    if (sql.startsWith('SELECT id FROM focus_handouts')) return db.reset.focus;
  }
  if (sql.includes('FROM learning_path_modules lpm JOIN learning_paths lp')) return db.pathModule ? [db.pathModule] : [];
  if (sql.startsWith('SELECT ta.*, s.name AS subject_name FROM tutor_assessments ta')) return db.assessment ? [db.assessment.header] : [];
  if (sql.startsWith('SELECT q.*, m.order_number AS source_order_number')) return db.assessment ? db.assessment.questions : [];
  if (sql.startsWith('SELECT * FROM tutor_question_options')) return db.assessment ? db.assessment.options : [];
  if (sql.startsWith('SELECT o.* FROM tutor_question_options o')) return db.assessment ? db.assessment.options : [];
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
// Three kinds of call write what is added to a module: the plan (the weak
// points), the topics of one weak point, and the check of those topics.
const sent = [];
let planReply = () => ({ weak_points: [] });
let leftoverReply = () => ({});
let topicsReply = () => ({ topics: [] });
let reviewReply = () => ({ topics: [] });
global.fetch = (url, options) => {
  const body = JSON.parse(options.body);
  const system = body.messages[0].content;
  const user = body.messages[1].content;
  sent.push({ url, system, user });
  let payload = { questions: [] };
  if (/find their WEAK POINTS/.test(system)) payload = planReply(user);
  else if (/not in any of their WEAK POINTS yet/.test(system)) payload = leftoverReply(user);
  else if (/You write ADDED TOPICS/.test(system)) payload = topicsReply(user);
  else if (/You check ADDED TOPICS/.test(system)) payload = reviewReply(user);
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(payload) } }], usage: { total_tokens: 42 } })
  });
};

/** The topic numbers a topics prompt asks for ("WRITE TOPICS 1, 2, 3, 4, 5"). */
function askedNumbers(user) {
  const match = String(user).match(/WRITE TOPICS? ([\d, ]+)/);
  return match ? match[1].split(',').map((n) => Number(n.trim())).filter(Boolean) : [];
}
/** The weak point a topics prompt is about. */
function askedPoint(user) {
  const match = String(user).match(/WEAK POINT: (.+)/);
  return match ? match[1].trim() : '';
}

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
  console.log('\n== Advance passes ==');
  ok('80% (Intermediate) does not pass', paths.passes(80) === false);
  ok('60% does not pass', paths.passes(60) === false);
  ok('81% passes', paths.passes(81) === true);
  ok('90% passes', paths.passes(90) === true);
  ok('100% passes', paths.passes(100) === true);
  ok('0% does not pass', paths.passes(0) === false);
  ok('the pages say Advance (81%)', paths.PASS_LABEL === 'Advance (81%)');

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

  const sectioned = await composeModulePdf({
    moduleTitle: 'Module 1: Energy',
    studentName: 'Ana Reyes',
    parts: [{
      name: 'Module1.pdf',
      buffer: original,
      sections: [{
        after_page: 1,
        heading: 'Weak point 1: Heat',
        intro: 'What to learn: where heat comes from.',
        topics: [1, 2, 3, 4, 5].map((n) => ({ title: `Topic ${n} of 5: Part ${n}`, text: `${LONG_TEXT}\nTry this: What gives heat?\nAnswer: Fire` }))
      }]
    }]
  });
  const sectionPages = await readPageTexts(sectioned.bytes);
  const sectionOrder = sectionPages.map((p) => (/PAGE ONE/.test(p.text) ? '1' : /PAGE TWO/.test(p.text) ? '2' : /PAGE THREE/.test(p.text) ? '3' : /ADDED FOR YOU/.test(p.text) ? '+' : '?')).join('');
  ok('a weak point is one section right after its page, every original page kept', /^1\++23$/.test(sectionOrder) && sectioned.originalPages === 3, sectionOrder);
  const sectionText = sectionPages.filter((p) => /ADDED FOR YOU/.test(p.text)).map((p) => p.text).join('\n');
  ok('the section shows its weak point, what to learn, and all five topics',
    /Weak point 1: Heat/.test(sectionText) && /What to learn/.test(sectionText)
    && [1, 2, 3, 4, 5].every((n) => sectionText.includes(`Topic ${n} of 5`)));

  console.log('\n== what is added: their weak points, five topics each ==');
  const missed = [
    { question_text: 'What gives heat energy?', correct_text: 'Fire', explanation: 'Fire is hot.' },
    { question_text: 'Which one makes sound?', correct_text: 'A drum' },
    { question_text: 'Heat moves from hot to what?', correct_text: 'Cold' }
  ];
  const pages = [{ num: 1, text: 'PAGE ONE about energy' }, { num: 2, text: 'PAGE TWO about heat' }, { num: 3, text: 'PAGE THREE about sound' }];
  const topicText = (point, n) => `${point} topic ${n}. ${LONG_TEXT}\nTry this: Name one source of heat.\nAnswer: The sun`;
  planReply = () => ({
    weak_points: [
      // covers question 1 only: question 3 is left out, and must still find a home
      { title: 'Heat energy', focus: 'Where heat comes from and how it moves.', after_page: 9, covers: [1], topics: ['What heat is', 'Sources of heat', 'Heat moves', 'The mistake', 'Using it'] },
      { title: 'Sound', focus: 'What makes a sound.', after_page: 0, covers: [2, 2, 7], topics: ['What sound is'] },
      { title: '', focus: 'no title', covers: [3] }
    ]
  });
  let firstWrite = true;
  topicsReply = (user) => {
    const point = askedPoint(user);
    const numbers = askedNumbers(user);
    // The first write of "Heat energy" leaves topic 4 out and makes topic 5 too short.
    if (point === 'Heat energy' && firstWrite) {
      firstWrite = false;
      return { topics: numbers.filter((n) => n !== 4).map((n) => ({ n, title: `T${n}`, text: n === 5 ? 'too short' : topicText(point, n) })) };
    }
    return { topics: numbers.map((n) => ({ n, title: `T${n}`, text: topicText(point, n) })) };
  };
  reviewReply = (user) => ({
    topics: [1, 2, 3, 4, 5].map((n) => (n === 2 && /WEAK POINT: Heat energy/.test(user)
      ? { n, ok: false, text: `Corrected: ${topicText('Heat energy', n)}` }
      : n === 3 ? { n, ok: false, text: 'cut short' } : { n, ok: true, text: '' }))
  });
  sent.length = 0;
  const written = await ai.generateModuleAdditions({ pages, missed, level: 'Beginner', subject: 'Science', gradeLevel: 'Grade 4', moduleTitle: 'Energy' });
  const plan = sent.find((s) => /find their WEAK POINTS/.test(s.system));
  ok('the plan carries every missed question and its answer', /What gives heat energy\?/.test(plan.user) && /Correct answer: Fire/.test(plan.user) && /3\. Heat moves/.test(plan.user));
  ok('the plan carries the pages by number', /=== Page 2 ===/.test(plan.user));
  ok('the plan asks for five topics per weak point', /exactly 5 short titles/.test(plan.system));
  ok('a weak point with no title is dropped: two weak points', written.weakPoints.length === 2, `${written.weakPoints.length}`);
  ok('every weak point has exactly five topics', written.weakPoints.every((point) => point.topics.length === 5),
    written.weakPoints.map((point) => point.topics.length).join(','));
  ok('topics are numbered 1 to 5, in order', written.weakPoints.every((point) => point.topics.map((t) => t.no).join('') === '12345'));
  ok('a topic missing or too short is asked for again, once',
    sent.filter((s) => /You write ADDED TOPICS/.test(s.system) && /WEAK POINT: Heat energy/.test(s.user)).length === 2
    && /WRITE TOPICS 4, 5/.test(sent.filter((s) => /You write ADDED TOPICS/.test(s.system) && /WEAK POINT: Heat energy/.test(s.user))[1].user));
  ok('the second ask lists what is written already', /TOPICS ALREADY WRITTEN/.test(sent.filter((s) => /WEAK POINT: Heat energy/.test(s.user) && /You write ADDED TOPICS/.test(s.system))[1].user));
  const heat = written.weakPoints.find((point) => point.title === 'Heat energy');
  const sound = written.weakPoints.find((point) => point.title === 'Sound');
  ok('a page past the end is put on the last page', heat.after_page === 3, `${heat.after_page}`);
  ok('page 0 becomes page 1', sound.after_page === 1, `${sound.after_page}`);
  ok('every missed question belongs to a weak point — one left out joins the closest',
    heat.questions.length + sound.questions.length === 3 && heat.questions.some((q) => /hot to what/.test(q.q)),
    JSON.stringify([heat.questions.map((q) => q.q), sound.questions.map((q) => q.q)]));
  ok('a question named twice, or out of range, is counted once', sound.questions.length === 1);
  ok('each weak point keeps the questions and answers behind it', heat.questions[0].q === 'What gives heat energy?' && heat.questions[0].a === 'Fire');
  ok('the check against the module corrects a topic', /^Corrected:/.test(heat.topics[1].text) && written.corrected >= 1);
  ok('…but a correction cut short is not taken', !/cut short/.test(heat.topics[2].text) && heat.topics[2].text.length > 150);
  ok('each topic is checked against the module pages', sent.some((s) => /You check ADDED TOPICS/.test(s.system) && /=== Page 1 ===/.test(s.user)));
  ok('the topics forbid invented facts', /Use ONLY facts present in the module pages/.test(sent.find((s) => /You write ADDED TOPICS/.test(s.system)).system));
  const leftoverAsk = sent.find((s) => /not in any of their WEAK POINTS yet/.test(s.system));
  ok('a question the plan left out is asked about once more, by its own number',
    !!leftoverAsk && /3\. Heat moves from hot to what\?/.test(leftoverAsk.user) && !/1\. What gives heat/.test(leftoverAsk.user));

  // The second ask puts a left-out question in a weak point of its own.
  planReply = () => ({ weak_points: [{ title: 'Heat energy', focus: 'Heat.', after_page: 2, covers: [1, 3], topics: [] }] });
  leftoverReply = () => ({ placed: [{ n: 1, weak_point: 1 }], new_weak_points: [{ title: 'Sound', focus: 'What makes a sound.', after_page: 3, covers: [2], topics: ['What sound is'] }] });
  firstWrite = false;
  reviewReply = () => ({ topics: [] });
  const placed = await ai.generateModuleAdditions({ pages, missed, level: 'Beginner', subject: 'Science', gradeLevel: 'Grade 4', moduleTitle: 'Energy' });
  ok('…and a new idea becomes a weak point of its own, five topics too',
    placed.weakPoints.length === 2 && placed.weakPoints[1].title === 'Sound' && placed.weakPoints[1].topics.length === 5
    && placed.weakPoints[1].questions.length === 1 && placed.weakPoints[0].questions.length === 2,
    JSON.stringify(placed.weakPoints.map((point) => [point.title, point.questions.length, point.topics.length])));
  leftoverReply = () => ({});

  const tidy = ai.tidyTopicText('Topic 1: What heat is\nHeat is energy. It moves from hot to cold. Try this: Name a hot thing. Answer: Fire.', 'What heat is');
  ok('a topic does not repeat its title, and its practice sits on lines of its own',
    tidy === 'Heat is energy. It moves from hot to cold.\n\nTry this: Name a hot thing.\nAnswer: Fire.', JSON.stringify(tidy));
  ok('…a first line that is just the title goes too', ai.tidyTopicText('What heat is:\nHeat is energy.', 'What heat is') === 'Heat is energy.');
  ok('…and a text already laid out stays as it is', ai.tidyTopicText('Heat is energy.\n\nTry this: Name one.\nAnswer: Fire', 'X') === 'Heat is energy.\n\nTry this: Name one.\nAnswer: Fire');

  const nothingMissed = await ai.generateModuleAdditions({ pages: [], missed: [] });
  ok('nothing missed: no AI call, nothing added', nothingMissed.weakPoints.length === 0);
  planReply = () => ({ weak_points: [{ title: 'Heat', covers: [1], after_page: 1, topics: [] }] });
  topicsReply = () => ({ topics: [{ n: 1, title: 'x', text: 'tiny' }] });
  let thrown = '';
  try { await ai.generateModuleAdditions({ pages: [{ num: 1, text: 'PAGE about heat' }], missed: [{ question_text: 'Q?' }] }); } catch (e) { thrown = e.message; }
  ok('topics that cannot be written: a clear error, recorded as a failure', /topics on "Heat" could be written/.test(thrown), thrown);
  planReply = () => ({ weak_points: [] });
  thrown = '';
  try { await ai.generateModuleAdditions({ pages: [{ num: 1, text: 'PAGE about heat' }], missed: [{ question_text: 'Q?' }] }); } catch (e) { thrown = e.message; }
  ok('no weak point found: a clear error', /no weak point/.test(thrown), thrown);

  console.log('\n== what is added is stored packed, and read both ways ==');
  const packed = paths.packAdditions(written.weakPoints.map((point, i) => ({ no: i + 1, handout_id: 97, ...point })));
  ok('stored packed, smaller than the plain text', packed.startsWith('gz:') && packed.length < JSON.stringify(written.weakPoints).length, `${packed.length} vs ${JSON.stringify(written.weakPoints).length}`);
  const read = paths.readAdditions(packed);
  ok('read back: the weak points, five topics each', read.weakPoints.length === 2 && read.weakPoints.every((point) => point.topics.length === 5 && !point.legacy));
  ok('…and every topic on its own for the PDF and the assessment', read.additions.length === 10 && read.additions[0].weak_point_title === 'Heat energy');
  const legacy = paths.readAdditions(JSON.stringify([{ handout_id: 97, after_page: 2, title: 'Old lesson', text: LONG_TEXT }]));
  ok('lessons added before weak points still read, one each', legacy.weakPoints.length === 1 && legacy.weakPoints[0].legacy && legacy.additions.length === 1);
  ok('nothing stored, or something unreadable: nothing added', paths.parseAdditions(null).length === 0 && paths.parseAdditions('gz:not-gzip').length === 0 && paths.parseAdditions('[]').length === 0);
  const section = paths.weakPointSection(read.weakPoints[0]);
  ok('a weak point becomes a PDF section with its five topics',
    section.heading === 'Weak point 1: Heat energy' && /^What to learn/.test(section.intro)
    && section.topics.length === 5 && section.topics[0].title.startsWith('Topic 1 of 5'));

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

  console.log('\n== a take: graded, kept; Advance opens the next module, below it the next take opens ==');
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
  const reopen = db.statements.find((s) => s.sql.startsWith('UPDATE learning_path_modules SET takes_opened = ?'));
  ok('…but the next take opens at once, no tutor needed', !!reopen && reopen.params[0] === 2 && failed.nextTake === 2,
    reopen ? JSON.stringify(reopen.params) : 'no UPDATE');

  db.statements = [];
  db.submissions = [{ id: 400 }];
  db.pathModule = { ...db.pathModule, takes_opened: 2, takes_used: 1 };
  const intermediate = await paths.submitModuleAttempt({ pathModuleId: 11, studentId: 5, answers: answersRight(8) });
  ok('8 of 10 is 80% — Intermediate: not passed', intermediate.percentage === 80 && intermediate.passed === false && intermediate.level === 'Intermediate');
  ok('a retake updates the same submission row, never a second one',
    sqlOf().some((s) => s.startsWith('UPDATE tutor_assessment_submissions SET score'))
    && !sqlOf().some((s) => s.startsWith('INSERT INTO tutor_assessment_submissions')));
  ok('…and replaces its answers with this take\'s', sqlOf().some((s) => s.startsWith('DELETE FROM tutor_student_answers')));
  ok('take 3 opens', intermediate.attemptNumber === 2 && intermediate.nextTake === 3);

  db.statements = [];
  db.pathModule = { ...db.pathModule, takes_opened: 3, takes_used: 2 };
  const passedTake = await paths.submitModuleAttempt({ pathModuleId: 11, studentId: 5, answers: answersRight(9) });
  ok('9 of 10 is 90% — Advance: passed', passedTake.percentage === 90 && passedTake.passed === true, `${passedTake.percentage}`);
  ok('the take is number 3', passedTake.attemptNumber === 3);
  ok('passed: the module is marked passed', sqlOf().some((s) => s.includes("SET status = 'passed', assessment_status = 'passed'")));
  ok('…and the next module opens', passedTake.nextId === 12);
  ok('…and no further take is opened', !sqlOf().some((s) => s.startsWith('UPDATE learning_path_modules SET takes_opened = ?')));

  db.statements = [];
  db.pathModule = { ...db.pathModule, takes_opened: 4, takes_used: 3 };
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

  console.log('\n== the Post-Assessment: the Pre-Assessment\'s own questions, in a new order ==');
  const preQuestions = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
    id: 200 + n,
    question_text: `Pre question ${n}?`,
    question_type: 'multiple_choice',
    correct_answer: ['A', 'B', 'C', 'D'][n % 4],
    points: 1,
    explanation: `Because ${n}.`,
    source_module_id: n <= 4 ? 61 : 62,
    source_handout_id: n <= 4 ? 97 : 98,
    options: ['A', 'B', 'C', 'D'].map((label) => ({ question_id: 200 + n, option_label: label, option_text: `${label}-text-${n}` }))
  }));
  const keyText = (q) => q.options.find((o) => o.option_label === q.correct_answer).option_text;
  const copy = paths.reshuffledCopy(preQuestions, 12345);
  ok('every Pre-Assessment question is in it, once', copy.map((q) => q.question_text).sort().join('|') === preQuestions.map((q) => q.question_text).sort().join('|'));
  ok('in a new order', copy.map((q) => q.question_text).join('|') !== preQuestions.map((q) => q.question_text).join('|'));
  ok('every answer key still points at the right choice', copy.every((q) => {
    const source = preQuestions.find((p) => p.question_text === q.question_text);
    const chosen = q.choices.find((c) => c.label === q.correct_answer);
    return chosen && chosen.text === keyText(source);
  }));
  ok('the choices are lettered A, B, C, D again', copy.every((q) => q.choices.map((c) => c.label).join('') === 'ABCD'));
  ok('each question keeps the module and handout it came from', copy.every((q) => {
    const source = preQuestions.find((p) => p.question_text === q.question_text);
    return q.source_module_id === source.source_module_id && q.source_handout_id === source.source_handout_id;
  }));
  ok('some choices moved', copy.some((q) => {
    const source = preQuestions.find((p) => p.question_text === q.question_text);
    return q.choices.map((c) => c.text).join('|') !== source.options.map((o) => o.option_text).join('|');
  }));
  const broken = paths.reshuffledCopy([{ ...preQuestions[0], correct_answer: 'Z' }], 7);
  ok('a key not among its choices: the choices stay as they were', broken[0].choices.map((c) => c.text).join('|') === preQuestions[0].options.map((o) => o.option_text).join('|') && broken[0].correct_answer === 'Z');

  db.post = {
    path: { id: 3, student_id: 5, subject_id: 2, subject_name: 'SCIENCE', grade_level: 'Grade 4', pre_submission_id: 70, pre_assessment_id: 55, post_status: 'pending', first_name: 'Ana', last_name: 'Reyes' },
    modules: [{ id: 11, path_id: 3, module_id: 61, position: 1, status: 'passed', additions_json: '[]' }, { id: 12, path_id: 3, module_id: 62, position: 2, status: 'passed', additions_json: '[]' }]
  };
  db.assessment = {
    header: { id: 55, subject_id: 2, title: 'Pre-Assessment — SCIENCE (Grade 4)', subject_name: 'SCIENCE', assessment_kind: 'pre_assessment' },
    questions: preQuestions.map(({ options, ...q }) => q),
    options: preQuestions.flatMap((q) => q.options)
  };
  db.statements = [];
  sent.length = 0;
  const post = await paths.runJobNow('post', 3);
  const inserted = db.statements.filter((s) => s.sql.startsWith('INSERT INTO tutor_assessment_questions'));
  ok('the Post is made', post.ok === true, JSON.stringify(post));
  ok('…with as many questions as the Pre-Assessment', inserted.length === preQuestions.length, `${inserted.length}`);
  ok('…no AI asked to write anything', sent.length === 0);
  const head = db.statements.find((s) => s.sql.startsWith('INSERT INTO tutor_assessments'));
  ok('…a Post-Assessment for this student alone', head && head.params.includes('post_assessment') && head.params[head.params.length - 1] === 5);
  ok('…unopened, for the tutor to check and edit', /is_published, grade_level, for_student_id\) VALUES \(\?, \?, NULL, \?, \?, \?, \?, \?, \?, 0/.test(head.sql));
  ok('…and the path waits on its tutor', db.statements.some((s) => s.sql.startsWith("UPDATE learning_paths SET post_assessment_id = ?, post_status = 'draft'")));
  db.post = null;

  console.log('\n== every score of a path, and the Pre against the Post ==');
  db.scores = {
    pre: { id: 70, score: 12, total_points: 30, percentage: 40, level: 'Beginner', submitted_at: new Date('2026-11-01T09:00:00Z'), title: 'Pre' },
    post: { id: 90, score: 27, total_points: 30, percentage: 90, level: 'Advance', submitted_at: new Date('2026-11-20T09:00:00Z'), title: 'Post' },
    tallies: [
      { submission_id: 70, module_id: 61, total: 15, correct: 4 },
      { submission_id: 70, module_id: 62, total: 15, correct: 8 },
      { submission_id: 90, module_id: 61, total: 15, correct: 14 },
      { submission_id: 90, module_id: 62, total: 15, correct: 13 }
    ],
    activities: [{ submission_id: 501, score: 4, total_points: 5, percentage: 80, level: 'Intermediate', submitted_at: new Date('2026-11-05T09:00:00Z'), assessment_id: 600, title: 'Heat practice', module_id: 61, for_student_id: 5 }]
  };
  const scoreView = {
    path: { id: 3, student_id: 5, pre_submission_id: 70, post_assessment_id: 91 },
    modules: [
      { id: 11, module_id: 61, position: 1, order_number: 1, module_title: 'Energy', status: 'passed', passed_by: null,
        attempts: [
          { id: 1, attempt_number: 1, score: 4, total_points: 10, percentage: 40, level: 'Beginner', submitted_at: new Date('2026-11-04T09:00:00Z') },
          { id: 2, attempt_number: 2, score: 9, total_points: 10, percentage: 90, level: 'Advance', submitted_at: new Date('2026-11-06T09:00:00Z') }
        ] },
      { id: 12, module_id: 62, position: 2, order_number: 2, module_title: 'Sound', status: 'passed', passed_by: null,
        attempts: [{ id: 3, attempt_number: 1, score: 10, total_points: 10, percentage: 100, level: 'Advance', submitted_at: new Date('2026-11-10T09:00:00Z') }] }
    ]
  };
  const scores = await paths.getPathScores(scoreView);
  ok('every score is listed: Pre, each take, the activity, Post', scores.rows.length === 6, scores.rows.map((r) => r.title).join(' / '));
  ok('the Pre first and the Post last, the rest by date', scores.rows[0].kind === 'pre' && scores.rows[5].kind === 'post'
    && scores.rows.slice(1, 5).map((r) => r.title).join('|') === 'Module 1 Assessment — Take 1|Heat practice|Module 1 Assessment — Take 2|Module 2 Assessment — Take 1');
  ok('a take that did not pass says so; the one that passed says so', scores.rows[1].passed === false && scores.rows[3].passed === true);
  ok('Pre against Post: 40% to 90%, +50 points, Beginner to Advance',
    scores.comparison.prePct === 40 && scores.comparison.postPct === 90 && scores.comparison.delta === 50 && scores.comparison.levelChanged);
  ok('…and module by module', scores.modules[0].prePct === 26.7 && scores.modules[0].postPct === 93.3 && scores.modules[0].change === 66.6
    && scores.modules[1].pre.correct === 8 && scores.modules[1].post.correct === 13, JSON.stringify(scores.modules.map((m) => [m.prePct, m.postPct, m.change])));
  db.scores = { ...db.scores, post: null };
  const noPost = await paths.getPathScores({ ...scoreView, path: { ...scoreView.path, post_assessment_id: null } });
  ok('before the Post: no comparison yet, the Pre per module still shown', noPost.comparison === null && noPost.modules[0].pre.correct === 4 && noPost.modules[0].post === null);
  db.scores = null;

  console.log('\n== resetting a Pre-Assessment (main admin) ==');
  const resetFails = async () => { try { await paths.resetPreAssessmentFor(5, 2); return ''; } catch (e) { return e.message; } };
  db.reset = { pre: [], post: [], paths: [], modules: [], personal: [], focus: [] };
  ok('nothing to reset: refused', /no Pre-Assessment/.test(await resetFails()));
  db.reset = { pre: [{ id: 70 }], post: [{ id: 81 }], paths: [], modules: [], personal: [], focus: [] };
  db.statements = [];
  ok('the Post-Assessment taken: refused, so the before-and-after is kept', /can no longer be reset/.test(await resetFails()));
  ok('…and nothing was deleted', !db.statements.some((s) => s.sql.startsWith('DELETE')));
  db.reset = {
    pre: [{ id: 70 }],
    post: [],
    paths: [{ id: 3, post_assessment_id: 90 }],
    modules: [{ id: 11, assessment_id: 77 }, { id: 12, assessment_id: null }],
    personal: [{ id: 77 }, { id: 90 }],
    focus: [{ id: 5 }]
  };
  db.statements = [];
  const done = await paths.resetPreAssessmentFor(5, 2);
  const deletes = db.statements.filter((s) => s.sql.startsWith('DELETE')).map((s) => s.sql);
  const at = (prefix) => deletes.findIndex((s) => s.startsWith(prefix));
  ok('it reports what it removed', done.removedSubmissions === 1 && done.removedPaths === 1 && done.removedAssessments === 2, JSON.stringify(done));
  ok('every take goes before the assessments it belongs to',
    at('DELETE FROM tutor_assessment_attempts') >= 0 && at('DELETE FROM tutor_assessment_attempts') < at('DELETE FROM tutor_assessments'));
  ok('answers go before the questions they point at',
    at('DELETE FROM tutor_student_answers') < at('DELETE FROM tutor_assessment_questions'));
  ok('only the student\'s own assessments are deleted',
    deletes.some((s) => s.startsWith('DELETE FROM tutor_assessments WHERE id IN') && s.includes('for_student_id = ?')));
  const preDelete = deletes.findIndex((s) => s.startsWith('DELETE FROM tutor_assessment_submissions WHERE id IN'));
  ok('focus areas and violations go before the Pre-Assessment result',
    at('DELETE FROM focus_handouts') < preDelete && deletes.findIndex((s) => s.includes('assessment_violations WHERE submission_id')) < preDelete);
  ok('the classification and an opened Post go too',
    deletes.some((s) => s.startsWith('DELETE FROM student_subject_levels')) && deletes.some((s) => s.startsWith('DELETE FROM post_openings')));
  ok('the path goes (its modules with it)', deletes.some((s) => s.startsWith('DELETE FROM learning_paths')));
  ok('activities and level modules are not touched',
    !deletes.some((s) => /level_modules|student_module_reads/.test(s)));
  db.reset = null;

  console.log('\n== the tutor is told, and the notice opens the very page it is about ==');
  db.post = {
    path: { id: 3, student_id: 5, subject_id: 2, subject_name: 'SCIENCE', grade_level: 'Grade 4', pre_submission_id: 70, pre_assessment_id: 55, post_status: 'pending', first_name: 'Ana', last_name: 'Reyes' },
    modules: [{ id: 11, path_id: 3, module_id: 61, position: 1, status: 'passed', additions_json: '[]' }]
  };
  db.assessment = {
    header: { id: 55, subject_id: 2, title: 'Pre-Assessment — SCIENCE (Grade 4)', subject_name: 'SCIENCE', assessment_kind: 'pre_assessment' },
    questions: preQuestions.map(({ options, ...q }) => q),
    options: preQuestions.flatMap((q) => q.options)
  };
  db.assignedTutor = { tutor_id: 353, first_name: 'Rosa', last_name: 'Lim' };
  db.statements = [];
  const told = await paths.runJobNow('post', 3);
  const notices = db.statements.filter((s) => s.sql.startsWith('INSERT INTO app_notifications'));
  const putAway = db.statements.findIndex((s) => s.sql.startsWith('UPDATE app_notifications SET is_read = 1') && s.params.includes(353));
  ok('the Post is made and the student\'s tutor is told', told.ok === true && notices.length === 1 && notices[0].params.includes(353),
    JSON.stringify(notices.map((n) => n.params)));
  ok('the notice opens the Post-Assessment\'s questions, to check them',
    notices.length === 1 && notices[0].params.some((p) => /^\/tutor\/path-assessments\/\d+\/edit$/.test(String(p))));
  ok('an unread notice about the same thing is put away first, so the bell lists it once',
    putAway >= 0 && putAway < db.statements.indexOf(notices[0]));
  db.post = null;
  db.assessment = null;

  db.pathModule = {
    id: 12, path_id: 5, module_id: 62, position: 1, order_number: 1, status: 'open', student_id: 352, subject_id: 5,
    first_name: 'Mark', last_name: 'Santos', additions_json: '[]'
  };
  db.statements = [];
  await paths.notifyActivityAnswered({
    assessment: { id: 700, title: 'Plants practice', subject_id: 5, for_student_id: 352, tutor_id: 353 },
    studentId: 352, submissionId: 901, score: 4, totalPoints: 5, percentage: 80, pathModuleId: 12
  });
  const answered = db.statements.find((s) => s.sql.startsWith('INSERT INTO app_notifications'));
  ok('an activity given to one student, answered: their tutor is told the score',
    !!answered && answered.params.includes(353) && answered.params.some((p) => String(p) === 'Mark Santos answered "Plants practice" (80.0%)'),
    answered ? JSON.stringify(answered.params.slice(0, 3)) : 'no notice');
  ok('…and the notice opens the student\'s answers',
    !!answered && answered.params.includes('/tutor/results/901') && answered.params.includes('tutor_submission') && answered.params.includes(901));
  db.statements = [];
  await paths.notifyActivityAnswered({
    assessment: { id: 701, title: 'Shared', subject_id: 5, for_student_id: null }, studentId: 352, submissionId: 902, pathModuleId: 12
  });
  ok('an activity shared with a whole level tells nobody', !db.statements.some((s) => s.sql.startsWith('INSERT INTO app_notifications')));
  db.assignedTutor = null;
  db.pathModule = null;

  console.log('\n== Modules & Assessments: a box per student who took the Pre-Assessment ==');
  db.boxes = {
    enrolled: [
      { subject_id: 5, student_id: 352, student_code: 'STD-0901', first_name: 'Mark', last_name: 'Santos', grade_level: 'Grade 1', image_path: null },
      { subject_id: 5, student_id: 304, student_code: 'STD-0902', first_name: 'Ana', last_name: 'Cruz', grade_level: 'Grade 4', image_path: '/uploads/profiles/a.png' },
      { subject_id: 5, student_id: 77, student_code: 'STD-0077', first_name: 'Ben', last_name: 'Lim', grade_level: 'Grade 2', image_path: null },
      { subject_id: 4, student_id: 352, student_code: 'STD-0901', first_name: 'Mark', last_name: 'Santos', grade_level: 'Grade 1', image_path: null },
      { subject_id: 4, student_id: 88, student_code: 'STD-0903', first_name: 'Carla', last_name: 'Diaz', grade_level: 'Grade 5', image_path: null }
    ],
    sittings: [
      { id: 1147, student_id: 352, subject_id: 5, pre_grade: 'Grade 1', level: 'Beginner' },
      { id: 1145, student_id: 352, subject_id: 4, pre_grade: 'Grade 1', level: 'Advanced' },
      { id: 1140, student_id: 304, subject_id: 5, pre_grade: 'Grade 4', level: 'Intermediate' },
      { id: 1100, student_id: 88, subject_id: 4, pre_grade: 'Grade 3', level: 'Advance' }
    ],
    paths: [
      { id: 5, student_id: 352, subject_id: 5, pre_submission_id: 1147, placement_level: 'Beginner', post_status: 'waiting', total: 3, passed: 0, to_check: 1 },
      { id: 4, student_id: 352, subject_id: 4, pre_submission_id: 1145, placement_level: 'Beginner', post_status: 'draft', total: 2, passed: 2, to_check: 0 }
    ]
  };
  const withBoxes = await paths.tutorModuleBoxes(353, [
    { subject_id: 4, subject_name: 'ENGLISH' }, { subject_id: 5, subject_name: 'SCIENCE' }, { subject_id: 9, subject_name: 'FILIPINO' }
  ]);
  const science = withBoxes.find((s) => s.subject_id === 5);
  const english = withBoxes.find((s) => s.subject_id === 4);
  ok('every subject the tutor teaches is listed, in order', withBoxes.map((s) => s.subject_name).join(',') === 'ENGLISH,SCIENCE,FILIPINO');
  ok('only a student who took the Pre-Assessment gets a box, by name', science.boxes.map((b) => b.code).join(',') === 'STD-0902,STD-0901',
    science.boxes.map((b) => b.code).join(','));
  ok('a Pre-Assessment of another grade does not count', english.boxes.map((b) => b.code).join(',') === 'STD-0901');
  const mark = science.boxes.find((b) => b.code === 'STD-0901');
  ok('a box says whose modules: the name, the grade and the level of the module',
    mark.name === 'Mark Santos' && mark.grade === 'Grade 1' && mark.level === 'Beginner' && mark.onPath);
  ok('on a learning path the level is the path\'s placement', english.boxes[0].level === 'Beginner');
  ok('before learning paths: the level of their Pre-Assessment', science.boxes[0].level === 'Intermediate' && !science.boxes[0].onPath);
  ok('what waits for the tutor to check is counted, the Post included', mark.toCheck === 1 && english.boxes[0].toCheck === 1);
  ok('a box opens the student\'s own modules', mark.href === '/tutor/modules/students/352/5');
  ok('a subject where nobody took it has no box', withBoxes.find((s) => s.subject_id === 9).boxes.length === 0);
  db.boxes = null;
  db.statements = [];
  const noSubjects = await paths.tutorModuleBoxes(353, []);
  ok('no subject: nothing asked of the database', noSubjects.length === 0 && db.statements.length === 0);

  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'Learning paths hold: every page kept, five topics per weak point, Advance opens the next module, a retake opens at once, the Post repeats the Pre.'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
