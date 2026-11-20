/**
 * File: scripts/test-objectives.js
 * Purpose: Pin down MindQuest's own learning objectives (lib/objectives.js) and
 *          everything that reads them.
 *
 * Run:  node scripts/test-objectives.js       (needs no database, no keys)
 *
 * WHAT MUST HOLD
 *   1. A saved list is checked: one to eight different objectives, each 8 to
 *      300 letters. Saving it unchanged writes nothing; changing it keeps each
 *      objective's id, adds the new ones, archives the removed ones, and makes
 *      the list a draft again. Approving needs at least one.
 *   2. The AI drafts three to five objectives from the module's readable
 *      handouts, cleaned of numbering and repeats; a module that has objectives
 *      is left alone unless asked to replace them.
 *   3. A question keeps an objective only when it is one of its own module's
 *      approved ones — never one the AI or a form made up.
 *   4. The AI writes each question against its module's objectives: they are in
 *      the prompt, and the objective a question names is kept only when real.
 *   5. A result reads per objective: Mastered at 60% right, Not yet below; the
 *      Pre and the Post side by side.
 *   6. A learning path adds lessons only for the objectives not mastered yet —
 *      the AI is told them — and every missed question with no objective, as
 *      before. Each weak point says which objective it teaches.
 *   7. The Pre-Assessment's fingerprint is unchanged by modules with no
 *      objectives, and changes when approved objectives do.
 *
 * `config/db` is replaced in the require cache, and `fetch` before the AI
 * service loads. Nothing dials out.
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
  objectives: [],         // module_objectives rows getObjectives returns
  approved: [],           // rows approvedByModule returns
  module: null,           // getModuleById's row
  handouts: [],           // getModuleHandouts' rows
  results: [],            // objectiveResultsFor's rows, by submission id
  insertId: 700
};

function answer(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  db.statements.push({ sql, params });
  if (sql.startsWith('INSERT')) return { insertId: ++db.insertId };
  if (sql.startsWith('SELECT id, module_id, position, objective_text, status')) return db.objectives;
  if (sql.startsWith('SELECT id, module_id, position, objective_text FROM module_objectives')) {
    return db.approved.filter((row) => params.map(Number).includes(Number(row.module_id)));
  }
  if (sql.startsWith('SELECT m.*, s.name AS subject_name, s.handout_version FROM modules m')) return db.module ? [db.module] : [];
  if (sql.startsWith('SELECT h.*, u.first_name, u.last_name FROM module_handouts h')) return db.handouts;
  if (sql.startsWith('SELECT o.id, o.objective_text, o.position, m.order_number, m.title AS module_title')) {
    return (db.results[Number(params[0])] || []);
  }
  return [];
}

const stub = (modulePath, exports) => {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
stub('../config/db', {
  sql: {},
  baseConfig: {},
  getPool: async () => { throw new Error('the test must never open a connection'); },
  query: async (text, params = []) => answer(text, params),
  withTransaction: async (work) => work({ query: async (text, params = []) => [answer(text, params)] })
});

// --- the AI, answered locally ----------------------------------------------
const sent = [];
let reply = () => ({});
global.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  const system = body.messages[0].content;
  const user = body.messages[1].content;
  sent.push({ system, user });
  const content = /You check the answer key/.test(system) ? {} : reply(system, user);
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 10 } })
  };
};

const objectives = require('../lib/objectives');
const ai = require('../services/aiService');
const paths = require('../lib/learningPaths');
const data = require('../lib/data');

function fresh(patch = {}) {
  Object.assign(db, { statements: [], objectives: [], approved: [], module: null, handouts: [], results: [] }, patch);
  sent.length = 0;
  reply = () => ({});
}
const ran = (prefix) => db.statements.filter((s) => s.sql.startsWith(prefix));
const live = (id, text, status = 'approved', extra = {}) => ({
  id, module_id: 11, position: id, objective_text: text, status, written_by: 'ai', ...extra
});

async function main() {
  console.log('\n== 1. the admin\'s list ==');
  const refuse = (items) => { try { objectives.cleanList(items); return null; } catch (error) { return error.message; } };
  ok('an empty list is refused', /at least one/.test(refuse([{ text: '  ' }])));
  ok('a list longer than eight is refused', /at most 8/.test(refuse(Array.from({ length: 9 }, (_v, i) => ({ text: `Identify thing ${i}` })))));
  ok('a too-short objective is refused, by number', /Objective 2 is too short/.test(refuse([{ text: 'Identify the parts' }, { text: 'Add' }])));
  ok('two that say the same thing are refused', /Objective 2 says the same/.test(refuse([{ text: 'Identify the parts' }, { text: 'identify  the parts' }])));
  ok('spaces are tidied', objectives.cleanList([{ text: '  Identify   the parts ' }])[0].text === 'Identify the parts');
  ok('the status of a list: none, draft, approved',
    objectives.statusOf([]) === 'none' && objectives.statusOf([live(1, 'a'), live(2, 'b', 'draft')]) === 'draft'
      && objectives.statusOf([live(1, 'a'), live(2, 'b')]) === 'approved');

  fresh({ objectives: [live(1, 'Identify the three states of matter'), live(2, 'Describe a solid')] });
  let saved = await objectives.saveObjectives(11, [
    { id: 1, text: 'Identify the three states of matter' }, { id: 2, text: 'Describe a solid' }
  ]);
  ok('saving it unchanged writes nothing', saved.changed === false && !ran('UPDATE').length && !ran('INSERT').length);

  fresh({ objectives: [live(1, 'Identify the three states of matter'), live(2, 'Describe a solid'), live(3, 'Explain melting')] });
  saved = await objectives.saveObjectives(11, [
    { id: 2, text: 'Describe the properties of a solid' }, { id: 1, text: 'Identify the three states of matter' },
    { text: 'Classify objects as solid, liquid or gas' }
  ]);
  const updates = ran('UPDATE module_objectives SET position = ?');
  ok('a changed list keeps each objective\'s id, in its new place', saved.changed === true && updates.length === 2
    && updates[0].params[0] === 1 && updates[0].params[3] === 2 && updates[1].params[0] === 2 && updates[1].params[3] === 1);
  ok('…a reworded one is the admin\'s now, an unchanged one keeps who wrote it',
    updates[0].params[2] === 'admin' && updates[1].params[2] === 'ai');
  ok('…a new one is added as the admin\'s', ran('INSERT INTO module_objectives').length === 1
    && ran('INSERT INTO module_objectives')[0].params[2] === 'Classify objects as solid, liquid or gas');
  const archived = ran('UPDATE module_objectives SET is_archived = 1');
  ok('…one taken out is archived, never deleted', archived.length === 1 && archived[0].params[0] === 3 && !ran('DELETE').length);
  ok('…and the whole list is a draft again', ran("UPDATE module_objectives SET status = 'draft'").length === 1);

  fresh({ objectives: [] });
  const none = await objectives.approveObjectives(11, 1).then(() => null, (error) => error.message);
  ok('approving needs at least one objective', /at least one/.test(String(none)));
  fresh({ objectives: [live(1, 'Identify the parts', 'draft')] });
  await objectives.approveObjectives(11, 1);
  const approval = ran("UPDATE module_objectives SET status = 'approved'")[0];
  ok('approving marks them approved, by whom', !!approval && approval.params[0] === 1 && approval.params[1] === 11);

  console.log('\n== 2. the AI drafts them ==');
  const MODULE = { id: 11, subject_id: 5, subject_name: 'SCIENCE', grade_level: 'Grade 4', title: 'Matter' };
  const HANDOUT = { id: 31, module_id: 11, extracted_at: '2026-11-01', extracted_text: 'Matter is anything that has mass and takes up space. '.repeat(5) };
  fresh({ module: MODULE, handouts: [HANDOUT] });
  reply = () => ({
    objectives: ['1. Identify the three states of matter.', '- Describe the properties of a solid;', 'identify the three states of matter.',
      'Classify common objects as solid, liquid or gas', 'Explain melting', 'Compare a liquid and a gas', 'Name a gas']
  });
  const drafted = await objectives.draftWithAI(11, { replace: false });
  const writtenDrafts = ran('INSERT INTO module_objectives');
  ok('the AI\'s drafts are saved as drafts, the AI\'s, in order', !drafted.skipped && writtenDrafts.length === 5
    && writtenDrafts.every((s) => s.sql.includes("'draft', 'ai'")) && writtenDrafts[0].params[1] === 1);
  ok('…cleaned of numbering, bullets and repeats, at most five',
    writtenDrafts.map((s) => s.params[2]).join(' | ') === 'Identify the three states of matter. | Describe the properties of a solid | Classify common objects as solid, liquid or gas | Explain melting | Compare a liquid and a gas',
    writtenDrafts.map((s) => s.params[2]).join(' | '));
  ok('…from the module\'s handout text, for its grade', /Grade: Grade 4/.test(sent[0].user) && sent[0].user.includes('Matter is anything'));

  fresh({ module: MODULE, handouts: [HANDOUT], objectives: [live(1, 'Identify the parts')] });
  const kept = await objectives.draftWithAI(11, { replace: false });
  ok('a module that has objectives is left alone', kept.skipped === true && !sent.length && !ran('INSERT').length);
  fresh({ module: MODULE, handouts: [HANDOUT], objectives: [live(1, 'Identify the parts')] });
  reply = () => ({ objectives: ['Identify the three states of matter', 'Describe a solid', 'Explain melting'] });
  await objectives.draftWithAI(11, { replace: true });
  ok('…unless asked to write them again: the old ones archived, the new ones drafts',
    ran('UPDATE module_objectives SET is_archived = 1').length === 1 && ran('INSERT INTO module_objectives').length === 3);
  fresh({ module: MODULE, handouts: [{ ...HANDOUT, extracted_at: null }] });
  const unreadable = await objectives.draftWithAI(11, { replace: true }).then(() => null, (error) => error.message);
  ok('no readable handout: nothing to draft from', /no readable handout/.test(String(unreadable)) && !sent.length);

  console.log('\n== 3. only a real objective of its own module ==');
  fresh({ approved: [{ id: 41, module_id: 11, position: 1, objective_text: 'Identify' }, { id: 51, module_id: 12, position: 1, objective_text: 'Add' }] });
  const questions = [
    { source_module_id: 11, objective_id: 41 },
    { source_module_id: 11, objective_id: 51 },
    { source_module_id: 12, objective_id: 999 },
    { source_module_id: null, objective_id: 41 }
  ];
  await objectives.keepValidObjectives(questions);
  ok('its own module\'s approved objective is kept', questions[0].objective_id === 41);
  ok('another module\'s, a made-up one, or one with no module is dropped',
    questions[1].objective_id === null && questions[2].objective_id === null && questions[3].objective_id === null);

  console.log('\n== 4. the AI writes questions against them ==');
  fresh();
  const handout = {
    handout_id: 31, module_id: 11, order_number: 1, module_title: 'Matter', file_original_name: 'Matter.pdf',
    extracted_text: 'Matter is anything that has mass and takes up space. Solids keep their shape. '.repeat(4),
    objectives: [{ id: 41, text: 'Identify the three states of matter' }, { id: 42, text: 'Describe the properties of a solid' }]
  };
  reply = (system) => (/You write assessment questions/.test(system) ? {
    questions: [
      { question_text: 'Which keeps its own shape?', question_type: 'multiple_choice', source_handout_id: 31, objective_id: 42,
        choices: ['A solid', 'A liquid', 'A gas', 'Steam'], correct_answer: 'A', correct_choice_text: 'A solid' },
      { question_text: 'How many states of matter are taught?', question_type: 'multiple_choice', source_handout_id: 31, objective_id: 99,
        choices: ['One', 'Two', 'Three', 'Four'], correct_answer: 'C', correct_choice_text: 'Three' }
    ]
  } : {});
  const generated = await ai.generateAssessmentFromHandouts({ handouts: [handout], subject: 'SCIENCE', yearLevel: 'Grade 4', itemCount: 2, questionType: 'multiple_choice', allowedTypes: ['multiple_choice'] });
  const prompt = sent.find((s) => /You write assessment questions/.test(s.system));
  ok('the objectives are in the prompt, by id', !!prompt && prompt.user.includes('### objective_id 41: Identify the three states of matter')
    && prompt.system.includes('"objective_id": the id of the learning objective the question measures, one of 41, 42'));
  ok('…with the rule to spread the questions across them', /Spread the questions across the objectives/.test(prompt.system));
  const byText = (text) => generated.questions.find((q) => q.question_text === text);
  ok('a question keeps the objective it names', byText('Which keeps its own shape?').objective_id === 42);
  ok('…and one it made up is dropped', byText('How many states of matter are taught?').objective_id === null);
  fresh();
  reply = (system) => (/You write assessment questions/.test(system) ? { questions: [] } : {});
  await ai.generateAssessmentFromHandouts({ handouts: [{ ...handout, objectives: [] }], subject: 'SCIENCE', yearLevel: 'Grade 4', itemCount: 2 })
    .catch(() => null);
  const plain = sent.find((s) => /You write assessment questions/.test(s.system));
  ok('a module with no objectives is asked for as before', !!plain && !plain.system.includes('objective_id') && !plain.user.includes('LEARNING OBJECTIVES'));

  console.log('\n== 5. results per objective ==');
  ok('60% right is mastered, below is not', objectives.isMastered(3, 5) && !objectives.isMastered(2, 5) && !objectives.isMastered(0, 0));
  fresh({
    results: {
      900: [
        { id: 41, objective_text: 'Identify the three states of matter', position: 1, order_number: 1, module_title: 'Matter', total: 3, correct: 1 },
        { id: 42, objective_text: 'Describe a solid', position: 2, order_number: 1, module_title: 'Matter', total: 3, correct: 3 }
      ],
      901: [
        { id: 41, objective_text: 'Identify the three states of matter', position: 1, order_number: 1, module_title: 'Matter', total: 3, correct: 2 }
      ]
    }
  });
  const pre = await objectives.objectiveResultsFor({ submissionId: 900 });
  ok('each objective: right of total, and mastered or not', pre.length === 2 && pre[0].correct === 1 && pre[0].total === 3
    && pre[0].mastered === false && pre[1].mastered === true && pre[0].moduleLabel === 'Module 1: Matter');
  const versus = await objectives.objectiveComparison(900, 901);
  ok('the Pre against the Post, objective by objective',
    versus.length === 2 && versus[0].pre.mastered === false && versus[0].post.mastered === true && versus[1].post === null);
  const takeQuery = (await objectives.objectiveResultsFor({ attemptId: 77 }), db.statements[db.statements.length - 1]);
  ok('a take of a module assessment reads its own answers', takeQuery.sql.includes('FROM tutor_assessment_attempt_answers a') && takeQuery.params[0] === 77);

  console.log('\n== 6. a learning path teaches what is not mastered ==');
  const miss = (n, objective) => ({ question_text: `Missed ${n}`, correct_text: 'x', objective_id: objective, objective_text: objective ? `Objective ${objective}` : null });
  const results = {
    total: 8,
    objectives: [
      { id: 41, text: 'Identify the three states of matter', correct: 1, total: 3, mastered: false },
      { id: 42, text: 'Describe a solid', correct: 2, total: 3, mastered: true }
    ],
    wrong: [miss(1, 41), miss(2, 41), miss(3, 42), miss(4, null)]
  };
  const teach = paths.whatToTeach(results);
  ok('the misses of an objective not mastered are taught', teach.missed.some((q) => q.question_text === 'Missed 1') && teach.missed.some((q) => q.question_text === 'Missed 2'));
  ok('…a miss of a mastered objective is not', !teach.missed.some((q) => q.question_text === 'Missed 3'));
  ok('…a miss that measured no objective still is', teach.missed.some((q) => q.question_text === 'Missed 4'));
  ok('…and the objectives to teach are the ones not mastered', teach.objectives.map((o) => o.id).join() === '41');
  const noObjectives = paths.whatToTeach({ total: 2, objectives: [], wrong: [miss(1, null), miss(2, null)] });
  ok('with no objective at all, every miss is taught, as before', noObjectives.missed.length === 2 && !noObjectives.objectives.length);

  fresh();
  reply = (system, user) => {
    if (/find their WEAK POINTS/.test(system)) {
      return { weak_points: [{ title: 'States of matter', focus: 'Identify the three states of matter', after_page: 1, covers: [1, 2, 3], topics: ['a', 'b', 'c', 'd', 'e'] }] };
    }
    if (/You write ADDED TOPICS/.test(system)) {
      // The topic numbers the prompt asks for ("WRITE TOPICS 1, 2, 3, 4, 5").
      const match = String(user).match(/WRITE TOPICS? ([\d, ]+)/);
      const numbers = match ? match[1].split(',').map((n) => Number(n.trim())).filter(Boolean) : [1, 2, 3, 4, 5];
      return { topics: numbers.map((n) => ({ n, title: `Topic ${n}`, text: `Solids, liquids and gases are the states of matter. Topic ${n}. `.repeat(6) })) };
    }
    return { topics: [] };
  };
  const additions = await ai.generateModuleAdditions({
    pages: [{ num: 1, text: 'Matter is anything that has mass. '.repeat(20) }],
    missed: [miss(1, 41), miss(2, 41), miss(3, null)],
    objectives: [{ id: 41, text: 'Identify the three states of matter' }],
    level: 'Beginner', subject: 'SCIENCE', gradeLevel: 'Grade 4', moduleTitle: 'Matter'
  }).catch((error) => ({ error: error.message }));
  const plan = sent.find((s) => /find their WEAK POINTS/.test(s.system));
  ok('the AI is told the objectives not mastered, to make each a weak point',
    !!plan && plan.system.includes('has NOT mastered these learning objectives') && plan.system.includes('1. Identify the three states of matter'));
  ok('…and which objective each missed question measured', !!plan && plan.user.includes('Learning objective: Objective 41'));
  ok('a weak point says which objective it teaches — the one most of its questions measured',
    !!additions.weakPoints && additions.weakPoints[0].objective_id === 41, additions.error || '');

  console.log('\n== 7. the Pre-Assessment\'s fingerprint ==');
  const sources = [
    { handout_id: 31, extracted_at: '2026-11-01T00:00:00.000Z', extracted_text: 'x'.repeat(100), objectives: [] },
    { handout_id: 32, extracted_at: '2026-11-02T00:00:00.000Z', extracted_text: 'y'.repeat(80) }
  ];
  const withNone = data.preFingerprint(sources);
  ok('modules with no objectives: the fingerprint as it always was, so no master is written again', withNone === data.preFingerprint(sources.map(({ objectives: _o, ...rest }) => rest))
    && withNone.length === 40);
  const withSome = data.preFingerprint([{ ...sources[0], objectives: [{ id: 41, text: 'Identify' }, { id: 42, text: 'Describe' }] }, sources[1]]);
  ok('approved objectives change it', withSome !== withNone);
  const reordered = data.preFingerprint([{ ...sources[0], objectives: [{ id: 42, text: 'Describe' }, { id: 41, text: 'Identify' }] }, sources[1]]);
  ok('…not their order on the page', reordered === withSome);
  const reworded = data.preFingerprint([{ ...sources[0], objectives: [{ id: 41, text: 'Identify all' }, { id: 42, text: 'Describe' }] }, sources[1]]);
  ok('…but a reworded one does', reworded !== withSome);

  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'Learning objectives hold: drafted by the AI, approved by the admin, measured per question, read per objective, taught where not mastered.'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
