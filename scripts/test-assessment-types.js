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
let realCallsAttempted = 0;

global.fetch = (url, options) => {
  if (!String(url).startsWith('https://api.openai.com/')) realCallsAttempted++;
  const body = JSON.parse(options.body);
  sent.push({ url, system: body.messages[0].content, user: body.messages[1].content, maxTokens: body.max_tokens });
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      choices: [{ message: { content: JSON.stringify(reply) } }],
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
  console.log('\n== Module assessment: MC, Fill in the Blank, True or False ==');
  sent.length = 0;
  reply = {
    questions: [
      mc(10),
      { question_text: 'The number above the line is the ____.', question_type: 'fill_blank', correct_answer: 'numerator', source_handout_id: 7 },
      { question_text: 'A denominator sits below the line.', question_type: 'true_false', correct_answer: 'true', source_handout_id: 7 },
      // Must be rejected: essay is not allowed for a module assessment.
      { question_text: 'Discuss fractions at length.', question_type: 'essay', answer_rubric: 'numerator and denominator explained', source_handout_id: 7 },
      // Must be rejected: a "blank" whose answer is a sentence cannot be marked.
      { question_text: 'Describe the process ____.', question_type: 'fill_blank',
        correct_answer: 'you divide the whole into equal parts and count them', source_handout_id: 7 }
    ]
  };

  const mod = await ai.generateAssessmentFromHandouts({
    handouts, subject: 'MATHEMATICS', itemCount: 3,
    questionType: 'mixed', allowedTypes: ai.MODULE_QUESTION_TYPES
  });

  const modSystem = sent[0].system;
  ok('the prompt offers all three module types',
    /"multiple_choice", "fill_blank", "true_false"/.test(modSystem),
    (modSystem.match(/"question_type": one of .*/) || [])[0]);
  ok('the prompt still forbids essay', /Never write an essay or open-ended question/.test(modSystem));
  ok('the prompt demands a real blank in the sentence', /MUST contain the blank written as at least two underscores/.test(modSystem));
  ok('the prompt caps the blank answer length', /one to four words/.test(modSystem));

  const types = mod.questions.map((q) => q.question_type);
  ok('the essay item was dropped', !types.includes('essay'));
  ok('the ungradeable blank was dropped', !mod.questions.some((q) => String(q.correct_answer).split(/\s+/).length > 4));
  ok('the good fill-in-the-blank survived', mod.questions.some((q) => q.question_type === 'fill_blank' && q.correct_answer === 'numerator'));
  ok('every kept type is allowed', types.every((t) => ai.MODULE_QUESTION_TYPES.includes(t)), types.join(', '));

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
