/**
 * File: scripts/test-assessment-types.js
 * Purpose: Exercise the real AI generation pipeline with the transport stubbed.
 *
 * Run:  node scripts/test-assessment-types.js       (needs no database, no keys)
 *
 *
 * The point is to prove the question-type restriction end to end — the prompt
 * that goes out, and the filtering of what comes back — WITHOUT a network call
 * and without spending the account's OpenAI credits. `fetch` is replaced, so the
 * request is captured and answered locally; everything between the call site and
 * that boundary is the production code path.
 */
process.env.AI_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key-0000000000000000';

let failures = 0;
const ok = (l, c, e = '') => {
  if (c) console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`);
  else { failures++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};

const sent = [];
let reply = { questions: [] };
// What the answer-key check (verifyAnswerKeys) is told, when a test sets it.
// Left null, the check gets no verdicts to read and keeps the batch as it was —
// which is what every test above the key-check section relies on. `reply` may
// also be a function, for a test whose writing calls answer differently in turn.
let verifyReply = null;
let realCallsAttempted = 0;

global.fetch = (url, options) => {
  if (!String(url).startsWith('https://api.openai.com/')) realCallsAttempted++;
  const body = JSON.parse(options.body);
  const system = body.messages[0].content;
  const isKeyCheck = /You check the answer key/.test(system);
  sent.push({ url, system, user: body.messages[1].content, maxTokens: body.max_tokens, temperature: body.temperature, isKeyCheck });
  const payload = isKeyCheck
    ? (verifyReply || { no: 'verdicts' })
    : (typeof reply === 'function' ? reply() : reply);
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      choices: [{ message: { content: JSON.stringify(payload) } }],
      usage: { total_tokens: 123 }
    })
  });
};

const ai = require('../services/aiService');

const handouts = [{
  handout_id: 7,
  module_id: 3,
  order_number: 1,
  module_title: 'Fractions',
  file_original_name: 'fractions.pdf',
  extracted_text: 'A fraction has a numerator above the line and a denominator below it. '
    + 'The denominator says how many equal parts the whole is divided into. '.repeat(4)
}];

const mc = (n) => ({
  question_text: `Which of these is a fraction, case ${n}?`,
  question_type: 'multiple_choice',
  correct_answer: 'A',
  choices: ['One half', 'A whole', 'A line', 'A circle'],
  source_handout_id: 7,
  explanation: 'A half is a fraction.'
});

async function main() {
  ok('the AI layer thinks it is configured', ai.isOpenAIConfigured());

  // ---------------------------------------------------------- Pre/Post path
  console.log('\n== Pre-Assessment: Multiple Choice only ==');
  sent.length = 0;
  reply = {
    questions: [
      mc(1), mc(2), mc(3),
      // Two items the model should never have written for a Pre-Assessment.
      { question_text: 'The sky is blue.', question_type: 'true_false', correct_answer: 'true', source_handout_id: 7 },
      { question_text: 'Explain fractions.', question_type: 'essay', answer_rubric: 'numerator, denominator, equal parts', source_handout_id: 7 }
    ]
  };

  const pre = await ai.generateAssessmentFromHandouts({
    handouts, subject: 'MATHEMATICS', itemCount: 3,
    questionType: 'multiple_choice', allowedTypes: ai.PRE_POST_QUESTION_TYPES
  });

  const preSystem = sent[0].system;
  ok('a request was built', sent.length > 0);
  ok('it went to the OpenAI endpoint', String(sent[0].url).startsWith('https://api.openai.com/'));
  ok('no request escaped the stub', realCallsAttempted === 0);
  ok('the prompt allows multiple_choice only', /one of "multiple_choice"\. Use NO other value/.test(preSystem),
    (preSystem.match(/"question_type": one of .*/) || [])[0]);
  ok('the prompt never offers essay', !/\* essay\s+->/.test(preSystem));
  ok('the prompt never offers true_false', !/\* true_false\s+->/.test(preSystem));
  ok('the prompt forbids open-ended questions', /Never write an essay or open-ended question/.test(preSystem));
  ok('the prompt forbids fill-in-the-blank', /Never write a fill-in-the-blank question/.test(preSystem));
  ok('the requested mix is all multiple choice', /Produce this mix of question types: \d+ x multiple_choice\./.test(preSystem),
    (preSystem.match(/Produce this mix.*/) || [])[0]);

  ok('the true/false item was dropped', !pre.questions.some((q) => q.question_type === 'true_false'));
  ok('the essay item was dropped', !pre.questions.some((q) => q.question_type === 'essay'));
  ok('every kept question is multiple choice', pre.questions.every((q) => q.question_type === 'multiple_choice'),
    `${pre.questions.length} kept of ${reply.questions.length} returned`);
  ok('kept questions carry four labelled choices', pre.questions.every((q) => q.choices.length === 4 && q.choices[0].label === 'A'));
  ok('kept questions cite the handout they came from', pre.questions.every((q) => q.source_handout_id === 7));

  // ---------------------------------------------------------- module path
  console.log('\n== Module assessment: Multiple Choice and True or False only ==');
  ok('the module types are exactly MC and True or False',
    ai.MODULE_QUESTION_TYPES.join(',') === 'multiple_choice,true_false', ai.MODULE_QUESTION_TYPES.join(','));
  sent.length = 0;
  reply = {
    questions: [
      mc(10),
      { question_text: 'A denominator sits below the line.', question_type: 'true_false', correct_answer: 'true', source_handout_id: 7 },
      // Must be rejected: fill in the blank is gone from every assessment.
      { question_text: 'The number above the line is the ____.', question_type: 'fill_blank', correct_answer: 'numerator', source_handout_id: 7 },
      // Must be rejected: essay is not allowed for a module assessment.
      { question_text: 'Discuss fractions at length.', question_type: 'essay', answer_rubric: 'numerator and denominator explained', source_handout_id: 7 }
    ]
  };

  const mod = await ai.generateAssessmentFromHandouts({
    handouts, subject: 'MATHEMATICS', itemCount: 3,
    questionType: 'mixed', allowedTypes: ai.MODULE_QUESTION_TYPES
  });

  const modSystem = sent[0].system;
  ok('the prompt offers the two module types',
    /one of "multiple_choice", "true_false"\. Use NO other value/.test(modSystem),
    (modSystem.match(/"question_type": one of .*/) || [])[0]);
  ok('the prompt never offers fill_blank', !/fill_blank/.test(modSystem));
  ok('the prompt forbids fill-in-the-blank', /Never write a fill-in-the-blank question/.test(modSystem));
  ok('the prompt still forbids essay', /Never write an essay or open-ended question/.test(modSystem));

  const types = mod.questions.map((q) => q.question_type);
  ok('the essay item was dropped', !types.includes('essay'));
  ok('the fill-in-the-blank item was dropped', !types.includes('fill_blank'));
  ok('the true/false item survived', types.includes('true_false'));
  ok('every kept type is allowed', types.every((t) => ai.MODULE_QUESTION_TYPES.includes(t)), types.join(', '));

  // ---------------------------------------------------- the answer key
  console.log('\n== every answer key is checked before anyone is graded on it ==');
  const choice = (text, n) => ({
    question_text: `Key check question ${n}: which one is right?`,
    question_type: 'multiple_choice',
    correct_answer: text,
    choices: ['One half', 'A whole', 'A line', 'A circle'],
    source_handout_id: 7
  });
  sent.length = 0;
  reply = { questions: [choice('A', 1), choice('B', 2), choice('D', 3)] };
  verifyReply = {
    results: [
      { n: 1, correct: ['A'], reason: 'one half is a fraction' },
      // Two right answers — the live "-2 and -3 are both negative" case.
      { n: 2, correct: ['B', 'C'], reason: 'both fit' },
      // The checker found a different answer than the key.
      { n: 3, correct: ['C'], reason: 'the handout says C' }
    ]
  };
  const checked = await ai.generateAssessmentFromHandouts({
    handouts, subject: 'MATHEMATICS', itemCount: 3,
    questionType: 'multiple_choice', allowedTypes: ai.PRE_POST_QUESTION_TYPES
  });
  const checks = sent.filter((s) => s.isKeyCheck);
  ok('a separate answer-key check ran', checks.length >= 1, `${checks.length} check call(s)`);
  ok('the check runs at temperature 0', checks.every((s) => s.temperature === 0));
  ok('the check is never shown the key', checks.every((s) => !/correct_answer|"key"|Answer:/i.test(s.user)));
  const isTopUp = (s) => /These questions already exist/.test(s.system);
  const firstPass = sent.filter((s) => !s.isKeyCheck && !isTopUp(s));
  const topUps = sent.filter((s) => !s.isKeyCheck && isTopUp(s));
  ok('the first pass writes cooler than before', firstPass.length === 1 && firstPass.every((s) => s.temperature === 0.4));
  ok('the top-up writes warmer, for questions not written yet', topUps.length >= 1 && topUps.every((s) => s.temperature === 0.9),
    `${topUps.length} top-up call(s) at ${topUps.map((s) => s.temperature).join(', ')}`);
  ok('a top-up that adds nothing new is not repeated', topUps.length === 1, `${topUps.length} top-up call(s)`);
  ok('the top-up is told not to rewrite the questions the check dropped',
    topUps.every((s) => /question 2:/.test(s.system) && /question 3:/.test(s.system)));
  ok('the item the checker agreed with is kept', checked.questions.some((q) => /question 1:/.test(q.question_text)));
  ok('an item with two right answers is dropped', !checked.questions.some((q) => /question 2:/.test(q.question_text)));
  ok('an item whose key the checker disputes is dropped', !checked.questions.some((q) => /question 3:/.test(q.question_text)));
  ok('the drops are counted', checked.rejectedByCheck === 2, `rejectedByCheck=${checked.rejectedByCheck}`);

  // The check failing must not empty an assessment.
  verifyReply = { nothing: 'useful' };
  sent.length = 0;
  reply = { questions: [choice('A', 11), choice('B', 12)] };
  const unchecked = await ai.generateAssessmentFromHandouts({
    handouts, subject: 'MATHEMATICS', itemCount: 2,
    questionType: 'multiple_choice', allowedTypes: ai.PRE_POST_QUESTION_TYPES
  });
  ok('a check with no verdicts keeps the batch', unchecked.questions.length === 2, `${unchecked.questions.length} kept`);
  verifyReply = null;

  console.log('\n== a short handout is topped up with NEW questions, twice at most ==');
  // A narrow handout: the model keeps writing the same two questions and finds
  // only one new one per call.
  sent.length = 0;
  let writeNo = 0;
  reply = () => {
    writeNo++;
    return { questions: writeNo === 1 ? [mc(101), mc(102)] : [mc(101), mc(102), mc(101 + writeNo)] };
  };
  const narrow = await ai.generateAssessmentFromHandouts({
    handouts, subject: 'MATHEMATICS', itemCount: 6,
    questionType: 'multiple_choice', allowedTypes: ai.PRE_POST_QUESTION_TYPES
  });
  const narrowWrites = sent.filter((s) => !s.isKeyCheck);
  ok('a top-up that adds something earns one more, then it stops', narrowWrites.length === 3, `${narrowWrites.length} writing call(s)`);
  ok('the repeats are dropped and the new questions kept', narrow.questions.length === 4, `${narrow.questions.length} kept`);
  ok('the second top-up is told about the first one\'s question too', /case 103/.test(narrowWrites[2].system));
  ok('no question appears twice', new Set(narrow.questions.map((q) => q.question_text)).size === narrow.questions.length);
  reply = { questions: [] };

  console.log('\n== a slipped letter and a bare sum are corrected, not trusted ==');
  const allowed = new Map([[7, handouts[0]]]);
  const slipped = ai.validateGeneratedQuestion({
    question_text: 'Which of these is a fraction?',
    question_type: 'multiple_choice',
    correct_answer: 'B',
    correct_choice_text: 'One half',
    choices: ['One half', 'A whole', 'A line', 'A circle'],
    source_handout_id: 7
  }, allowed, ai.PRE_POST_QUESTION_TYPES);
  ok('the answer written out in words wins over a slipped letter', slipped && slipped.correct_answer === 'A', slipped && slipped.correct_answer);

  const sum = ai.validateGeneratedQuestion({
    question_text: 'What is 6 x 6?',
    question_type: 'multiple_choice',
    correct_answer: 'B',
    choices: ['36', '42', '30', '48'],
    source_handout_id: 7
  }, allowed, ai.PRE_POST_QUESTION_TYPES);
  ok('6 x 6 is worked out: the key becomes the choice holding 36', sum && sum.correct_answer === 'A', sum && sum.correct_answer);

  const impossible = ai.validateGeneratedQuestion({
    question_text: 'What is 7 + 5?',
    question_type: 'multiple_choice',
    correct_answer: 'A',
    choices: ['11', '13', '10', '14'],
    source_handout_id: 7
  }, allowed, ai.PRE_POST_QUESTION_TYPES);
  ok('a sum whose answer is not among the choices is dropped', impossible === null);

  ok('a word problem is left to the answer-key check', ai.arithmeticKey('If each box has 8 apples and there are 5 boxes, how many apples are there?', [{ label: 'A', text: '40' }]) === null);
  ok('division with the divide sign works', ai.arithmeticKey('12 ÷ 3 = ?', [{ label: 'A', text: '3' }, { label: 'B', text: '4' }]) === 'B');
  ok('a negative result is matched', ai.arithmeticKey('What is 3 - 5?', [{ label: 'A', text: '2' }, { label: 'B', text: '-2' }]) === 'B');

  // ------------------------------------------------------- focus material
  console.log('\n== focus material generation ==');
  sent.length = 0;
  reply = { handout: 'FOCUS AREAS FOR TEST LEARNER\nSubject: MATHEMATICS   Pre-Assessment result: 40%\n\n1. Fractions (scored 1/5)\n   What they are missing: the denominator names the number of equal parts.\n\nFull per-question results are in Analytics & Reports.' };

  const material = await ai.generateFocusMaterial({
    studentName: 'Test Learner',
    subject: 'MATHEMATICS',
    yearLevel: 'Grade 7',
    percentage: 40,
    topics: [{ topic: 'Fractions — fractions.pdf', correct: 1, total: 5, percentage: 20 }],
    sources: [{ module_title: 'Fractions', file_original_name: 'fractions.pdf', extracted_text: 'A fraction has a numerator and a denominator.' }]
  });

  ok('material was produced', !!material && material.includes('FOCUS AREAS FOR TEST LEARNER'));
  ok('the prompt names the weak topic', /Fractions/.test(sent[0].user));
  ok('the prompt carries the student score', /Pre-Assessment result: 40\.0%/.test(sent[0].user), (sent[0].user.match(/Pre-Assessment result:.*/) || [])[0]);
  ok('the prompt includes the handout source text', /numerator and a denominator/.test(sent[0].user));
  ok('the prompt tells it to write for the tutor', /Write for the tutor, not the student/.test(sent[0].system));
  ok('the prompt forbids inventing content', /Use ONLY facts present in the handout text/.test(sent[0].system));

  // --------------------------------------------------- failure is survivable
  console.log('\n== the AI failing must not break anything ==');
  global.fetch = () => Promise.reject(new Error('network down'));
  const fallback = await ai.generateFocusMaterial({
    studentName: 'Test Learner', subject: 'MATHEMATICS', percentage: 40,
    topics: [{ topic: 'Fractions', correct: 1, total: 5, percentage: 20 }],
    sources: [{ module_title: 'Fractions', extracted_text: 'text' }]
  });
  ok('a failed AI call returns null rather than throwing', fallback === null);

  let threw = false;
  try {
    await ai.generateAssessmentFromHandouts({
      handouts, subject: 'MATHEMATICS', itemCount: 3,
      questionType: 'multiple_choice', allowedTypes: ai.PRE_POST_QUESTION_TYPES
    });
  } catch (e) {
    threw = /did not return any usable questions/.test(e.message);
  }
  ok('a total generation failure surfaces a clear error', threw);

  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'All AI-path checks passed (no network call, no credits spent).'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('ERROR', e.message, e.stack); process.exit(1); });
