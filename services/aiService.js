/**
 * File: services/aiService.js
 * Purpose: AI service layer for MindQuest. Handles AI-driven assessment generation,
 *          module generation from assessment results, and essay grading.
 *          Uses OpenAI API when configured, falls back to built-in mock generation.
 *
 * Environment variables:
 *   AI_PROVIDER   - 'openai' or 'mock' (default: 'mock')
 *   OPENAI_API_KEY - OpenAI API key (required when AI_PROVIDER=openai)
 *   AI_MODEL       - Model name (default: 'gpt-4o-mini')
 */

require('dotenv').config();

const AI_PROVIDER = String(process.env.AI_PROVIDER || 'mock').toLowerCase();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';

// ============================================================================
// OpenAI integration (used when AI_PROVIDER === 'openai' and key is set)
// ============================================================================

async function callOpenAI(systemPrompt, userPrompt, options = {}) {
  // max_tokens is a cap on the ANSWER, and a JSON answer that hits the cap comes
  // back truncated — which fails as "invalid JSON" rather than as a length error.
  // A 30-item assessment needs far more room than the 4,000 that was fine for 10,
  // so callers that ask for a lot of output raise it.
  const { maxTokens = 4000 } = options;
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${err}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    const tokensUsed = data.usage?.total_tokens || 0;

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (_e) {
      throw new Error('OpenAI returned invalid JSON: ' + content.substring(0, 200));
    }

    return { result: parsed, tokensUsed, provider: 'openai', model: AI_MODEL };
  } catch (error) {
    console.error('[aiService] OpenAI call failed:', error.message);
    throw error;
  }
}

/**
 * Transcribe a page image to plain text using the same OpenAI account and
 * client config as everything else here (Section 6: one provider only).
 *
 * This is the OCR path for scanned handouts — PDFs that are photographs of
 * paper and so carry no text layer. gpt-4o-mini is multimodal, so no separate
 * OCR engine or native dependency is needed.
 *
 * Measured on this project's own scans: ~3.6s and roughly $0.004 per page.
 *
 * @param {string} dataUrl a data:image/png;base64,... page render
 * @returns {Promise<{text: string, tokensUsed: number}>}
 */
async function transcribeImage(dataUrl) {
  // Deliberately NO "output NO_TEXT if empty" escape hatch. An earlier version
  // offered one and the model took it on diagram-heavy pages, returning NO_TEXT
  // for a page whose labels it transcribed perfectly well once the escape was
  // removed. Emptiness is detected by the caller from the length of the result.
  const systemPrompt = 'You transcribe page images into plain text for study material. '
    + 'Transcribe every word you can read, including labels inside diagrams, tables, boxes and figures. '
    + 'Preserve the natural reading order. Output only the transcribed text, with no commentary, '
    + 'no markdown fences and no explanation.';

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: AI_MODEL,
      max_tokens: 2000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl, detail: 'high' } }] }
      ]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI vision error ${response.status}: ${err.substring(0, 200)}`);
  }

  const data = await response.json();
  let text = data.choices?.[0]?.message?.content || '';
  // The model still tends to wrap transcriptions in a markdown fence.
  text = text.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  // Guard against a model that describes the page instead of transcribing it.
  if (/^(no (readable )?text|this (page|image) (is|contains|appears))/i.test(text)) text = '';
  return { text, tokensUsed: data.usage?.total_tokens || 0 };
}

/**
 * Whether the OpenAI integration is usable. Never throws — a bad/missing
 * config must degrade to the mock generators, not 500 the calling route.
 */
function isOpenAIConfigured() {
  try {
    return AI_PROVIDER === 'openai' && OPENAI_API_KEY.length > 10;
  } catch (_error) {
    return false;
  }
}

// ============================================================================
// MOCK generators (built-in fallback — no API key needed)
// ============================================================================

const QUESTION_TYPES = ['Multiple Choice', 'True or False', 'Identification'];

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateMockQuestions(subject, levelGroup, count = 20) {
  const questions = [];
  const levelLabel = levelGroup || 'General';
  const subjectName = subject || 'General Subject';

  // Distribute question types: ~10 MC, ~5 TF, ~5 Identification
  const distribution = [];
  for (let i = 0; i < Math.ceil(count * 0.5); i++) distribution.push('Multiple Choice');
  for (let i = 0; i < Math.ceil(count * 0.25); i++) distribution.push('True or False');
  for (let i = 0; i < count - distribution.length; i++) distribution.push('Identification');

  for (let i = 0; i < count; i++) {
    const qType = distribution[i] || randomChoice(QUESTION_TYPES);
    const qNum = i + 1;

    if (qType === 'Multiple Choice') {
      questions.push({
        question_text: `[${subjectName} - ${levelLabel}] Sample question #${qNum}: Which of the following is correct?`,
        question_type: 'Multiple Choice',
        choice_a: `Option A for question ${qNum}`,
        choice_b: `Option B for question ${qNum}`,
        choice_c: `Option C for question ${qNum}`,
        choice_d: `Option D for question ${qNum}`,
        correct_answer: randomChoice(['A', 'B', 'C', 'D']),
        explanation: `This is the explanation for question ${qNum}.`,
        points: 1
      });
    } else if (qType === 'True or False') {
      const answer = randomChoice(['true', 'false']);
      questions.push({
        question_text: `[${subjectName} - ${levelLabel}] True or False #${qNum}: This is a sample statement.`,
        question_type: 'True or False',
        choice_a: 'True',
        choice_b: 'False',
        choice_c: '',
        choice_d: '',
        correct_answer: answer,
        explanation: `The correct answer is ${answer}.`,
        points: 1
      });
    } else {
      questions.push({
        question_text: `[${subjectName} - ${levelLabel}] Identification #${qNum}: What is the term for this concept?`,
        question_type: 'Identification',
        choice_a: '',
        choice_b: '',
        choice_c: '',
        choice_d: '',
        correct_answer: `Answer${qNum}`,
        explanation: `The correct term is Answer${qNum}.`,
        points: 1
      });
    }
  }
  return questions;
}

function generateMockModuleContent(subject, resultLevel, originalTitle, round) {
  const levelDescriptions = {
    'Beginner': 'fundamental concepts and basic building blocks',
    'Intermediate': 'deeper understanding and practical applications',
    'Advance': 'advanced techniques and complex problem-solving'
  };
  const focus = levelDescriptions[resultLevel] || levelDescriptions['Beginner'];

  return {
    title: `AI Review Module: ${subject} — ${resultLevel} Level (Round ${round})`,
    content: `
# AI-Generated Review Module
## Subject: ${subject}
## Level: ${resultLevel}
## Round: ${round}
## Based on: ${originalTitle || 'Assessment Results'}

---

### Overview
This module was automatically generated based on your assessment results. It focuses on ${focus} to help you improve your understanding of ${subject}.

### Key Concepts

**Section 1: Foundations**
Review the core principles of ${subject}. Understanding these basics is essential before moving to more complex topics.
- Concept 1: Fundamental definition and application
- Concept 2: Related principles and their connections
- Concept 3: Common misconceptions to avoid

**Section 2: Practice Areas**
Based on your assessment, these areas need additional focus:
- Topic A: Review the key formulas and methods
- Topic B: Practice with real-world examples
- Topic C: Connect theory to practical applications

**Section 3: Self-Check**
Before taking the next assessment, make sure you can:
1. Explain the main concepts in your own words
2. Solve basic problems without reference materials
3. Identify the correct approach for different question types

### Study Tips
- Re-read this module at least twice
- Take notes on concepts you find difficult
- Try to teach a concept to someone else — this deepens understanding

---
*This module was generated by the MindQuest AI system to support your learning journey.*
    `.trim()
  };
}

function generateMockEssayGrade(question, studentAnswer) {
  if (!studentAnswer || String(studentAnswer).trim().length < 5) {
    return { score: 0, maxScore: 1, feedback: 'No meaningful answer provided.' };
  }
  const wordCount = String(studentAnswer).trim().split(/\s+/).length;
  const score = wordCount >= 20 ? 1 : (wordCount >= 10 ? 0.7 : 0.3);
  return {
    score: Number(score.toFixed(2)),
    maxScore: 1,
    feedback: wordCount >= 20
      ? 'Good effort — your answer demonstrates understanding of the topic.'
      : 'Your answer could be more detailed. Try to elaborate on key concepts.'
  };
}

// ============================================================================
// PUBLIC API — These are the functions other modules call
// ============================================================================

/**
 * Generate a 20-question mixed-type assessment from module content.
 *
 * @param {Object} options
 * @param {string} options.moduleContent - Text content or title of the source module
 * @param {string} options.subject - Subject name
 * @param {string} options.levelGroup - Education level group (Pre School, Primary, etc.)
 * @param {number} [options.questionCount=20] - Number of questions to generate
 * @returns {Promise<{questions: Array, tokensUsed: number, provider: string, model: string}>}
 */
async function generateAssessmentFromModule(options = {}) {
  const { moduleContent, subject, levelGroup, questionCount = 20 } = options;

  if (isOpenAIConfigured()) {
    try {
      const systemPrompt = `You are an expert educational assessment creator. Generate exactly ${questionCount} assessment questions for a ${levelGroup || 'general'} level student studying ${subject || 'general subject'}. 

CRITICAL REQUIREMENT: The difficulty of these questions MUST STRICTLY match the '${levelGroup}' level. Do not make the questions too easy or too hard for this specific level. 

Return a JSON object with a "questions" array. Each question object must have:
- "question_text": the question
- "question_type": one of "Multiple Choice", "True or False", or "Identification"
- "choice_a", "choice_b", "choice_c", "choice_d": choices (empty strings for non-MC questions)
- "correct_answer": for MC use "A","B","C","D"; for TF use "true"/"false"; for ID use the answer text
- "explanation": brief explanation of the correct answer
- "points": always 1

Mix question types: ~50% Multiple Choice, ~25% True or False, ~25% Identification.
Make questions perfectly appropriate for the student's education level.`;

      const userPrompt = `Generate ${questionCount} questions based on this module content:\n\n${String(moduleContent || subject || 'General knowledge').substring(0, 3000)}`;

      const { result, tokensUsed } = await callOpenAI(systemPrompt, userPrompt);
      const questions = Array.isArray(result.questions) ? result.questions : [];

      if (questions.length < 1) {
        throw new Error('AI returned no questions');
      }

      // Validate and normalize each question
      const validated = questions.slice(0, questionCount).map((q, i) => ({
        question_text: q.question_text || `Question ${i + 1}`,
        question_type: QUESTION_TYPES.includes(q.question_type) ? q.question_type : 'Multiple Choice',
        choice_a: q.choice_a || '',
        choice_b: q.choice_b || '',
        choice_c: q.choice_c || '',
        choice_d: q.choice_d || '',
        correct_answer: q.correct_answer || 'A',
        explanation: q.explanation || '',
        points: Number(q.points || 1)
      }));

      return { questions: validated, tokensUsed, provider: 'openai', model: AI_MODEL };
    } catch (error) {
      console.error('[aiService] OpenAI assessment generation failed, falling back to mock:', error.message);
    }
  }

  // Mock fallback
  const questions = generateMockQuestions(subject, levelGroup, questionCount);
  return { questions, tokensUsed: 0, provider: 'mock', model: 'built-in' };
}

// ============================================================================
// Pre/Post assessment generation from handouts (overhaul Phase 5)
// ============================================================================

/**
 * The question types each kind of assessment may use.
 *
 * These are a REQUIREMENT, not a preference, and they differ per assessment kind:
 *
 *   Pre-Assessment / Post-Assessment  Multiple Choice only.
 *       Both are marked automatically and the Post reuses the Pre's exact items
 *       to measure improvement, so every item has to be gradeable the same way
 *       twice with no judgement involved.
 *
 *   Module assessment (written by a tutor)  Multiple Choice, Fill in the Blank,
 *       True or False. Essay is deliberately NOT here: it needs an AI grader,
 *       which makes a tutor's own quiz depend on a network call and a model's
 *       opinion.
 *
 * Fill in the blank is back, and it is graded case-insensitively — see
 * gradeObjectiveAnswer in lib/data.js. Spelling still has to match; only letter
 * casing is ignored, which is what the brief asks for.
 */
const PRE_POST_QUESTION_TYPES = ['multiple_choice'];
const MODULE_QUESTION_TYPES = ['multiple_choice', 'fill_blank', 'true_false'];

/**
 * Kept as the module-assessment set under its old name: every existing caller
 * that imports SPEC_QUESTION_TYPES is a tutor-side path.
 */
const SPEC_QUESTION_TYPES = MODULE_QUESTION_TYPES;

const { PRE_ASSESSMENT_ITEM_COUNT } = require('../config/assessmentDefaults');

/**
 * How many of each type to ask for, given a total item count.
 *
 * @param {number} itemCount
 * @param {string} [requestedType='mixed']  one allowed type, or 'mixed'
 * @param {string[]} [allowedTypes]         the types this assessment may use
 */
function planQuestionMix(itemCount, requestedType = 'mixed', allowedTypes = MODULE_QUESTION_TYPES) {
  const total = Math.max(1, Number(itemCount) || 10);
  const types = (allowedTypes && allowedTypes.length) ? allowedTypes : MODULE_QUESTION_TYPES;

  // A single-type assessment (a Pre-Assessment, say) needs no mixing at all.
  if (types.length === 1) return { [types[0]]: total };

  if (requestedType && requestedType !== 'mixed' && types.includes(requestedType)) {
    return { [requestedType]: total };
  }

  if (total < types.length) {
    // Not enough room for all of them; lead with the most gradeable types.
    const mix = {};
    for (let i = 0; i < total; i++) {
      const type = types[i];
      mix[type] = (mix[type] || 0) + 1;
    }
    return mix;
  }

  // Multiple choice carries half; the rest is split evenly over the others.
  const mix = {};
  const primary = types[0];
  mix[primary] = Math.max(1, Math.round(total * 0.5));
  const rest = types.slice(1);
  const share = Math.max(1, Math.floor((total - mix[primary]) / rest.length));
  rest.forEach((type) => { mix[type] = share; });

  // Rounding can overshoot or undershoot; settle the difference on the primary.
  const diff = total - Object.values(mix).reduce((a, b) => a + b, 0);
  mix[primary] = Math.max(1, mix[primary] + diff);
  return mix;
}

/**
 * Normalise and validate one AI-returned question.
 * Returns null when the question cannot be trusted, so bad items are dropped
 * rather than stored and shown to a student.
 */
function validateGeneratedQuestion(raw, allowedHandouts, allowedTypes = MODULE_QUESTION_TYPES) {
  if (!raw || typeof raw !== 'object') return null;

  const questionText = String(raw.question_text || '').trim();
  if (questionText.length < 5) return null;

  // A type the assessment is not allowed to use is dropped, not converted: a
  // Pre-Assessment that quietly accepted a True/False item because the model
  // felt like writing one would break the Post-Assessment comparison later.
  const type = allowedTypes.includes(raw.question_type) ? raw.question_type : null;
  if (!type) return null;

  // The model must attribute each question to a real handout, otherwise weak-area
  // reporting would point at nothing. An unknown id is not guessed at.
  const sourceId = Number(raw.source_handout_id);
  const source = allowedHandouts.get(sourceId);
  if (!source) return null;

  const base = {
    question_text: questionText,
    question_type: type,
    points: 1,
    explanation: String(raw.explanation || '').trim() || null,
    source_handout_id: source.handout_id,
    source_module_id: source.module_id,
    choices: [],
    answer_rubric: null,
    correct_answer: ''
  };

  if (type === 'multiple_choice') {
    // Reject an item whose choices are baked into the question text — it renders
    // as the options listed twice, once inside the sentence and once as the real
    // radio buttons. Observed in a live run.
    if (/\bA[).]\s.{2,}\bB[).]\s/s.test(questionText)) return null;

    // The model often prefixes its own label ("A. Confidentiality..."), which
    // would render as "A) A. Confidentiality..." once we add the real label.
    const stripLabel = (text) => String(text || '').trim().replace(/^\(?[A-Ea-e][).:]\s+/, '').trim();

    let choices = Array.isArray(raw.choices) ? raw.choices.map(stripLabel).filter(Boolean) : [];
    if (choices.length < 2) return null;

    // Reject duplicate options. Observed in practice: the model returned A and C
    // as the same string, which makes the item unanswerable.
    const seen = new Set();
    const unique = [];
    for (const choice of choices) {
      const key = choice.toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(choice);
    }
    if (unique.length < choices.length) return null;
    choices = unique;

    const labels = ['A', 'B', 'C', 'D', 'E'].slice(0, choices.length);
    base.choices = choices.slice(0, 5).map((text, i) => ({ label: labels[i], text }));

    // Accept either a letter or the full answer text, and store the letter.
    const rawAnswer = String(raw.correct_answer || '').trim();
    let letter = /^[A-E]$/i.test(rawAnswer) ? rawAnswer.toUpperCase() : '';
    if (!letter) {
      const idx = base.choices.findIndex(
        (c) => c.text.toLowerCase() === rawAnswer.toLowerCase()
      );
      if (idx >= 0) letter = base.choices[idx].label;
    }
    if (!letter || !base.choices.some((c) => c.label === letter)) return null;
    base.correct_answer = letter;
    return base;
  }

  if (type === 'true_false') {
    const answer = String(raw.correct_answer || '').trim().toLowerCase();
    if (!['true', 'false'].includes(answer)) return null;
    base.correct_answer = answer;
    base.choices = [{ label: 'A', text: 'True' }, { label: 'B', text: 'False' }];
    return base;
  }

  if (type === 'fill_blank') {
    // The answer must be SHORT to be gradeable by comparison. A model asked for
    // a fill-in-the-blank will sometimes return an open question with a sentence
    // for an answer; that item is unmarkable, so it is dropped here rather than
    // shown to a student who then loses a mark for phrasing.
    const answer = String(raw.correct_answer || '').trim();
    if (!answer || answer.length > 60) return null;
    const words = answer.split(/\s+/).filter(Boolean);
    if (words.length > 4) return null;

    // Prefer an actual blank in the sentence. An identification-style question
    // with a one-to-four word answer grades identically, so it is accepted too.
    const hasBlank = /_{2,}/.test(questionText);
    const looksLikeIdentification = /\?$/.test(questionText) || /:$/.test(questionText);
    if (!hasBlank && !looksLikeIdentification) return null;

    base.correct_answer = answer;
    return base;
  }

  // essay — only reachable when the caller allows it
  const rubric = String(raw.answer_rubric || raw.expected_answer || '').trim();
  if (rubric.length < 10) return null;
  base.answer_rubric = rubric;
  base.correct_answer = rubric.slice(0, 500);
  return base;
}

/**
 * Generate assessment questions from a subject's handouts.
 *
 * Each handout is presented to the model with its real database id, and every
 * returned question must cite one of those ids. That citation is what powers the
 * weak-area view later ("weak in Module 2 — Handout: Fractions"), so questions
 * that cite an unknown handout are discarded rather than stored unattributed.
 *
 * @param {object} options
 * @param {Array<{handout_id:number, module_id:number, order_number:number, module_title:string, file_original_name:string, extracted_text:string}>} options.handouts
 * @param {string} options.subject
 * @param {string} [options.yearLevel]
 * @param {number} [options.itemCount=30] defaults to the required Pre-Assessment size
 * @param {string} [options.questionType='mixed'] one of the four types, or 'mixed'
 * @returns {Promise<{questions: Array, tokensUsed: number, provider: string, model: string, requested: number, kept: number, topUpUsed: boolean}>}
 */
async function generateAssessmentFromHandouts(options = {}) {
  const {
    handouts = [], subject, yearLevel, itemCount = PRE_ASSESSMENT_ITEM_COUNT, questionType = 'mixed',
    // Which types this assessment may contain. Defaults to the module set;
    // the Pre/Post generator passes PRE_POST_QUESTION_TYPES.
    allowedTypes = MODULE_QUESTION_TYPES
  } = options;

  const usable = handouts.filter((h) => String(h.extracted_text || '').trim().length > 50);
  if (!usable.length) {
    throw new Error('None of this subject\'s handouts have readable text yet, so questions cannot be generated from them.');
  }
  if (!isOpenAIConfigured()) {
    throw new Error('The AI service is not configured, so assessment questions cannot be generated.');
  }

  const allowed = new Map(usable.map((h) => [Number(h.handout_id), h]));

  // One item can be worth ~120 output tokens with its choices, rubric and
  // explanation, so the ceiling scales with the request instead of sitting at the
  // 4,000 that only ever had to hold 10 items. A JSON reply that hits the cap comes
  // back truncated, which surfaces as "invalid JSON" rather than as a length error.
  const tokenBudget = (n) => Math.min(16000, 1200 + n * 240);

  // One call per handout, not one call for all of them.
  //
  // The single-call version stated a per-handout quota in the prompt and the model
  // simply did not honour it: measured runs came back 16/11/3 and 15/2/13 across
  // three handouts, with the type mix drifting to 10 essays out of 30. A quota a
  // model may ignore is not a quota. Giving each handout its own call makes the
  // split structural — each reply can only cite the one handout it was given — and
  // the calls run concurrently, so N handouts cost roughly the wall time of one.
  const quotas = spreadEvenly(itemCount, usable.length);
  const seen = new Set();
  let tokensUsed = 0;

  const absorb = (rawQuestions, into) => {
    for (const raw of Array.isArray(rawQuestions) ? rawQuestions : []) {
      const validated = validateGeneratedQuestion(raw, allowed, allowedTypes);
      if (!validated) continue;
      // Duplicates are checked across the whole exam, not per handout: two
      // handouts covering the same ground do produce the same question.
      const key = normalizeQuestionKey(validated.question_text);
      if (seen.has(key)) continue;
      seen.add(key);
      into.push(validated);
    }
  };

  const perHandout = usable.map((handout, i) => ({ handout, wanted: quotas[i], questions: [] }));

  // Ask each handout for a little more than its quota. Validation rejects the
  // occasional malformed item (identical choices, an answer letter matching no
  // choice, an essay with no rubric), so asking for exactly N reliably lands under
  // N — measured 29 of 30 twice. The surplus is trimmed by the balancing step.
  await runWithConcurrency(perHandout.filter((slot) => slot.wanted > 0), 4, async (slot) => {
    const batch = slot.wanted + 2;
    const prompts = buildHandoutPrompts({
      handout: slot.handout, wanted: batch, questionType, subject, yearLevel, allowedTypes
    });
    try {
      const call = await callOpenAI(prompts.systemPrompt, prompts.userPrompt, { maxTokens: tokenBudget(batch) });
      tokensUsed += call.tokensUsed;
      absorb(call.result.questions, slot.questions);
    } catch (error) {
      // One unreadable handout must not cost the whole assessment.
      console.error(`[aiService] generation failed for handout ${slot.handout.handout_id}:`, error.message);
    }
  });

  // Any handout still short gets one top-up, again in parallel. One pass, not a
  // loop: a model that cannot fill the gap twice will not fill it on the tenth
  // try either, and the student is waiting.
  const short = perHandout.filter((slot) => slot.questions.length < slot.wanted);
  let topUpUsed = short.length > 0;
  if (short.length) {
    await runWithConcurrency(short, 4, async (slot) => {
      const batch = Math.max(4, (slot.wanted - slot.questions.length) + 3);
      const prompts = buildHandoutPrompts({
        handout: slot.handout, wanted: batch, questionType, subject, yearLevel, allowedTypes,
        avoidTexts: slot.questions.map((q) => q.question_text)
      });
      try {
        const call = await callOpenAI(prompts.systemPrompt, prompts.userPrompt, { maxTokens: tokenBudget(batch) });
        tokensUsed += call.tokensUsed;
        absorb(call.result.questions, slot.questions);
      } catch (error) {
        console.error(`[aiService] top-up failed for handout ${slot.handout.handout_id}:`, error.message);
      }
    });
  }

  // Interleave by handout so the exam alternates sources instead of running three
  // blocks; a student who gives up halfway has still been measured on every module.
  const candidates = interleaveByHandout(perHandout);
  if (!candidates.length) {
    throw new Error('The AI did not return any usable questions. Please try again.');
  }

  const questions = selectBalancedQuestions(
    candidates, itemCount, planQuestionMix(itemCount, questionType, allowedTypes), usable
  );

  return {
    questions,
    tokensUsed,
    provider: 'openai',
    model: AI_MODEL,
    requested: itemCount,
    kept: questions.length,
    candidates: candidates.length,
    topUpUsed
  };
}

/** Split `total` into `parts` whole numbers that differ by at most one. */
function spreadEvenly(total, parts) {
  const base = Math.floor(total / parts);
  return Array.from({ length: parts }, (_v, i) => base + (i < total % parts ? 1 : 0));
}

/** Run an async job over items, at most `limit` in flight. */
async function runWithConcurrency(items, limit, job) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await job(item);
    }
  });
  await Promise.all(workers);
}

/** One from each handout in turn, so the exam does not run in per-handout blocks. */
function interleaveByHandout(slots) {
  const out = [];
  const depth = Math.max(0, ...slots.map((s) => s.questions.length));
  for (let i = 0; i < depth; i++) {
    for (const slot of slots) {
      if (slot.questions[i]) out.push(slot.questions[i]);
    }
  }
  return out;
}

/**
 * Choose which `itemCount` of the candidates make the final exam.
 *
 * Taking the first N in arrival order looked fine and was not: the model emits
 * questions in blocks, so a 30-item cut of 36 candidates came back with 11 essays
 * instead of 6, and 3 questions from the last handout instead of 12 — the tail of
 * the reply is always the same handout, so truncation silently starved it. That
 * defeats the weak-area view, which is only as good as its coverage.
 *
 * So the cut respects both quotas first, then relaxes them rather than returning
 * short: a slightly lopsided exam beats a 27-item one.
 */
function selectBalancedQuestions(candidates, itemCount, typeMix, usable) {
  const typeQuota = { ...typeMix };
  const handoutQuota = {};
  const ids = usable.map((h) => Number(h.handout_id));
  const base = Math.floor(itemCount / ids.length);
  ids.forEach((id, i) => { handoutQuota[id] = base + (i < itemCount % ids.length ? 1 : 0); });

  const chosen = [];
  const taken = new Set();

  const sweep = (accept) => {
    for (let i = 0; i < candidates.length && chosen.length < itemCount; i++) {
      if (taken.has(i)) continue;
      const q = candidates[i];
      if (!accept(q)) continue;
      taken.add(i);
      chosen.push({ index: i, question: q });
      typeQuota[q.question_type] = (typeQuota[q.question_type] || 0) - 1;
      handoutQuota[q.source_handout_id] = (handoutQuota[q.source_handout_id] || 0) - 1;
    }
  };

  sweep((q) => typeQuota[q.question_type] > 0 && handoutQuota[q.source_handout_id] > 0);
  sweep((q) => typeQuota[q.question_type] > 0);   // type balance matters more than
  sweep((q) => handoutQuota[q.source_handout_id] > 0); // even coverage
  sweep(() => true);

  // Back to the order the model produced them in, which follows the handouts.
  return chosen.sort((a, b) => a.index - b.index).map((c) => c.question);
}

/** Compare question texts ignoring case, punctuation and spacing. */
function normalizeQuestionKey(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Build the system + user prompts for one handout's batch of questions.
 *
 * One handout per call is what makes the per-handout split reliable: the reply
 * cannot cite a handout it was never shown. Split out from the caller so the
 * top-up pass reuses the identical rules — two copies of this prompt would drift.
 */
function buildHandoutPrompts({
  handout, wanted, questionType, subject, yearLevel,
  allowedTypes = MODULE_QUESTION_TYPES, avoidTexts = []
}) {
  const itemCount = wanted;
  const mix = planQuestionMix(itemCount, questionType, allowedTypes);
  const mixText = Object.entries(mix).map(([type, n]) => `${n} x ${type}`).join(', ');

  // The answer-key rules are stated only for the types this assessment may
  // contain. Describing "essay" to a Pre-Assessment generator is an invitation
  // to produce one, and every essay it produced would be validated away — paid
  // for, then thrown out.
  const answerRules = {
    multiple_choice: '    * multiple_choice -> the letter of the correct choice ("A", "B", "C" or "D")',
    true_false: '    * true_false      -> exactly "true" or "false"',
    fill_blank: '    * fill_blank      -> the missing word or short phrase, at most 4 words',
    essay: '    * essay           -> a concise model answer'
  };
  const typeList = allowedTypes.map((type) => `"${type}"`).join(', ');
  const answerLines = allowedTypes.map((type) => answerRules[type]).filter(Boolean).join('\n');

  const extraRules = [];
  if (allowedTypes.includes('fill_blank')) {
    extraRules.push('- A fill_blank question_text MUST contain the blank written as at least two underscores (e.g. "The powerhouse of the cell is the ____.").');
    extraRules.push('- A fill_blank answer must be one to four words, and must be spelled exactly as it appears in the handout.');
  } else {
    extraRules.push('- Never write a fill-in-the-blank question. Ask it as multiple_choice instead.');
  }
  if (allowedTypes.includes('essay')) {
    extraRules.push('- "answer_rubric": for essay ONLY, the key points a correct answer must mention, so it can be graded automatically.');
  } else {
    extraRules.push('- Never write an essay or open-ended question. Every item must have one exact answer.');
  }

  const systemPrompt = `You write assessment questions for a tutorial centre, using ONLY the handout text provided.

Return a JSON object with a single key "questions", an array of exactly ${itemCount} objects.
Produce this mix of question types: ${mixText}.

Every question object must have:
- "question_text": the question, answerable purely from the handout
- "question_type": one of ${typeList}. Use NO other value.
- "source_handout_id": always the integer ${handout.handout_id}
- "correct_answer":
${answerLines}
- "choices": for multiple_choice ONLY, an array of 4 distinct answer strings in A,B,C,D order. Omit for other types.
- "explanation": one short sentence on why the answer is correct.

Rules:
- Base every question on the handout content. Never invent facts that are not in the text.
${extraRules.join('\n')}
- Make the difficulty appropriate for a ${yearLevel || 'general'} student.
- Keep the choices out of "question_text": no "A) ... B) ..." list, no answer letter.
- In "choices", give the answer text ONLY. Do not prefix it with "A.", "B)" or any label.
- All four choices of a multiple_choice question must be different from each other.
- Every question must be different from every other question in this set.
- Output strict JSON only. No commentary, no markdown.${avoidTexts.length ? `

These questions already exist in this assessment. Do NOT repeat them or ask the
same thing in different words:
${avoidTexts.map((t) => `- ${t}`).join('\n')}` : ''}`;

  const label = `Module ${handout.order_number} — ${handout.module_title}`
    + (handout.file_original_name ? ` (${handout.file_original_name})` : '');

  const userPrompt = `Subject: ${subject || 'General'}
Student level: ${yearLevel || 'General'}
Number of questions: ${itemCount}

HANDOUT
### handout_id: ${handout.handout_id}
### source: ${label}

${String(handout.extracted_text).trim()}`;

  return { systemPrompt, userPrompt };
}

/**
 * Grade an essay/identification answer using AI.
 *
 * @param {Object} options
 * @param {string} options.questionText - The question
 * @param {string} options.rubric - Expected answer or grading rubric
 * @param {string} options.studentAnswer - Student's submitted answer
 * @returns {Promise<{score: number, maxScore: number, feedback: string, tokensUsed: number, provider: string}>}
 */
async function gradeEssayAnswer(options = {}) {
  const { questionText, rubric, studentAnswer } = options;

  if (isOpenAIConfigured()) {
    try {
      const systemPrompt = `You are an expert teacher grading a student's answer. Grade it on a scale of 0 to 1 (0 = completely wrong, 1 = fully correct).

Return a JSON object with:
- "score": number between 0 and 1
- "maxScore": always 1
- "feedback": brief constructive feedback (1-2 sentences)`;

      const userPrompt = `Question: ${questionText || 'N/A'}
Expected answer/rubric: ${rubric || 'N/A'}
Student's answer: ${studentAnswer || '(no answer)'}`;

      const { result, tokensUsed } = await callOpenAI(systemPrompt, userPrompt);

      return {
        score: Math.min(1, Math.max(0, Number(result.score || 0))),
        maxScore: 1,
        feedback: result.feedback || 'No feedback available.',
        tokensUsed,
        provider: 'openai'
      };
    } catch (error) {
      console.error('[aiService] OpenAI grading failed, falling back to mock:', error.message);
    }
  }

  // Mock fallback
  const mock = generateMockEssayGrade(questionText, studentAnswer);
  return { ...mock, tokensUsed: 0, provider: 'mock' };
}

/**
 * Check if the AI service is configured and ready.
 * @returns {{ provider: string, configured: boolean, model: string }}
 */
function getAiStatus() {
  return {
    provider: AI_PROVIDER,
    configured: isOpenAIConfigured(),
    model: isOpenAIConfigured() ? AI_MODEL : 'built-in-mock'
  };
}

module.exports = {
  generateAssessmentFromModule,
  gradeEssayAnswer,
  gradeEssayAnswers,
  transcribeImage,
  generateAssessmentFromHandouts,
  generateFocusMaterial,
  planQuestionMix,
  validateGeneratedQuestion,
  SPEC_QUESTION_TYPES,
  PRE_POST_QUESTION_TYPES,
  MODULE_QUESTION_TYPES,
  isOpenAIConfigured,
  getAiStatus
};

/**
 * Batch-grade essay answers. Returns array of { isCorrect, score, feedback } for each essay.
 * Uses AI if configured, otherwise falls back to semantic text comparison.
 *
 * @param {Array<{questionText: string, studentAnswer: string, expectedAnswer: string}>} essays
 * @returns {Promise<Array<{isCorrect: boolean, score: number, feedback: string}>>}
 */
async function gradeEssayAnswers(essays = []) {
  if (!essays.length) return [];

  // Try AI batch grading via a single API call
  if (isOpenAIConfigured()) {
    try {
      const systemPrompt = `You are an expert teacher grading student essay answers. For each question, determine if the student's answer conveys the same idea as the expected answer. It does NOT need to be an exact match — if the core idea is similar or correct, mark it as correct.

Return a JSON object with a "results" array. Each result must have:
- "isCorrect": boolean (true if the student's answer conveys the correct idea)
- "score": number 0-1 (confidence)
- "feedback": brief feedback (1 sentence)`;

      const questionsText = essays.map((e, i) =>
        `Q${i + 1}: ${e.questionText}\nExpected: ${e.expectedAnswer}\nStudent: ${e.studentAnswer || '(no answer)'}`
      ).join('\n\n');

      const { result } = await callOpenAI(systemPrompt, `Grade these ${essays.length} essay answers:\n\n${questionsText}`);
      const results = Array.isArray(result.results) ? result.results : [];

      return essays.map((_, i) => ({
        isCorrect: !!(results[i] && results[i].isCorrect),
        score: results[i]?.score || 0,
        feedback: results[i]?.feedback || ''
      }));
    } catch (err) {
      console.error('[aiService] Batch essay grading failed, falling back to text comparison:', err.message);
    }
  }

  // Fallback: simple semantic comparison (case-insensitive, keyword overlap)
  return essays.map(e => {
    const student = String(e.studentAnswer || '').trim().toLowerCase();
    const expected = String(e.expectedAnswer || '').trim().toLowerCase();
    if (!student || student.length < 3) return { isCorrect: false, score: 0, feedback: 'No meaningful answer provided.' };
    if (!expected) return { isCorrect: true, score: 1, feedback: 'No expected answer to compare.' };

    // Check if student answer contains the key words from expected answer
    const expectedWords = expected.split(/\s+/).filter(w => w.length > 3);
    const matchingWords = expectedWords.filter(w => student.includes(w));
    const matchRatio = expectedWords.length > 0 ? matchingWords.length / expectedWords.length : 0;

    // 50% keyword overlap = correct
    const isCorrect = matchRatio >= 0.5;
    return {
      isCorrect,
      score: Number(matchRatio.toFixed(2)),
      feedback: isCorrect ? 'Your answer captures the key ideas.' : 'Your answer does not sufficiently match the expected answer.'
    };
  });
}

// ============================================================================
// Weak-topic focus material (upgrade Section 6.3)
// ============================================================================

/**
 * Write focus material for one student's weak topics, from the handouts those
 * topics came from.
 *
 * Called after a Pre-Assessment is graded. It is allowed to fail: the caller
 * (lib/focusHandouts.js) falls back to a template built from the same measured
 * data, so a missing API key costs polish, not the handout.
 *
 * The prompt is deliberately narrow — it is given ONLY the handout text behind
 * the topics the student actually got wrong, so it cannot wander off into
 * material the student has not been taught.
 *
 * @param {object} options
 * @param {string} options.studentName
 * @param {string} options.subject
 * @param {string} [options.yearLevel]
 * @param {number} options.percentage      the Pre-Assessment result
 * @param {Array<{topic:string, correct:number, total:number, percentage:number}>} options.topics
 * @param {Array<{module_title:string, file_original_name:string, extracted_text:string}>} options.sources
 * @returns {Promise<string|null>} plain-text handout, or null when unavailable
 */
async function generateFocusMaterial(options = {}) {
  const { studentName, subject, yearLevel, percentage, topics = [], sources = [] } = options;
  if (!isOpenAIConfigured() || !topics.length) return null;

  const topicList = topics
    .map((t, i) => `${i + 1}. ${t.topic} — scored ${t.correct}/${t.total} (${t.percentage}%)`)
    .join('\n');

  // Cap the source text. A whole subject's handouts would blow the context
  // window, and the first few thousand characters of the RIGHT handout is what
  // matters here, not completeness.
  const sourceText = sources
    .slice(0, 4)
    .map((source) => `### ${source.module_title}${source.file_original_name ? ` — ${source.file_original_name}` : ''}\n`
      + String(source.extracted_text || '').trim().slice(0, 4000))
    .join('\n\n');

  const systemPrompt = `You write short, practical focus material for a one-to-one tutor at a tutorial centre.

The student has just sat a Pre-Assessment and these are the topics they were weakest in.
Write material the TUTOR will teach from in the next session, using ONLY the handout text provided.

Return a JSON object with one key, "handout", whose value is plain text laid out as:

FOCUS AREAS FOR <STUDENT NAME>
Subject: <subject>   Pre-Assessment result: <percentage>%

Then, for EACH weak topic, in order:
  <n>. <topic name>  (scored x/y)
     What they are missing: one or two sentences naming the specific idea, drawn from the handout.
     Teach it like this: two or three concrete steps or an analogy the tutor can use.
     Check they have it: one question the tutor can ask, with its answer.

End with a single line: "Full per-question results are in Analytics & Reports."

Rules:
- Use ONLY facts present in the handout text. Never invent content.
- Write for the tutor, not the student: say what to teach and how.
- Keep it under 500 words. A page a tutor will actually read beats a chapter.
- Plain text only. No markdown, no bullet characters other than a leading dash.`;

  const userPrompt = `Student: ${studentName}
Subject: ${subject || 'General'}
Level: ${yearLevel || 'General'}
Pre-Assessment result: ${Number(percentage || 0).toFixed(1)}%

WEAK TOPICS
${topicList}

HANDOUT SOURCE TEXT
${sourceText}`;

  try {
    const { result } = await callOpenAI(systemPrompt, userPrompt, { maxTokens: 1600 });
    const text = String(result.handout || '').trim();
    return text.length > 40 ? text : null;
  } catch (error) {
    console.error('[aiService] focus material generation failed:', error.message);
    return null;
  }
}
