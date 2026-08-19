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

async function callOpenAI(systemPrompt, userPrompt) {
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
        max_tokens: 4000,
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

/**
 * Generate an AI review module based on assessment results.
 *
 * @param {Object} options
 * @param {string} options.originalModuleContent - Content of the original module
 * @param {string} options.originalModuleTitle - Title of the original module
 * @param {string} options.resultLevel - Student's result level (Beginner/Intermediate/Advance)
 * @param {string} options.subject - Subject name
 * @param {string} options.levelGroup - Education level group
 * @param {number} options.round - Learning cycle round number
 * @returns {Promise<{title: string, content: string, tokensUsed: number, provider: string, model: string}>}
 */
async function generateModuleFromAssessmentResult(options = {}) {
  const { originalModuleContent, originalModuleTitle, resultLevel, subject, levelGroup, round } = options;

  if (isOpenAIConfigured()) {
    try {
      const systemPrompt = `You are an expert educational content creator. Generate a focused review module for a ${levelGroup || 'general'} level student studying ${subject || 'general subject'} who scored at the "${resultLevel || 'Beginner'}" level on their last assessment.

Return a JSON object with:
- "title": A descriptive module title
- "content": The full module text in markdown format (at least 500 words). Include sections with headers, key concepts, examples, and study tips. Focus on helping the student improve from their current level.`;

      const userPrompt = `The student completed round ${round || 1} of their learning cycle.
Original module title: ${originalModuleTitle || 'N/A'}
Student level: ${resultLevel || 'Beginner'}
Subject: ${subject || 'General'}

${originalModuleContent ? 'Original module excerpt:\n' + String(originalModuleContent).substring(0, 2000) : 'Generate fresh review content for this subject.'}`;

      const { result, tokensUsed } = await callOpenAI(systemPrompt, userPrompt);

      return {
        title: result.title || `AI Review: ${subject} — ${resultLevel} (Round ${round})`,
        content: result.content || 'No content generated.',
        tokensUsed,
        provider: 'openai',
        model: AI_MODEL
      };
    } catch (error) {
      console.error('[aiService] OpenAI module generation failed, falling back to mock:', error.message);
    }
  }

  // Mock fallback
  const mock = generateMockModuleContent(subject, resultLevel, originalModuleTitle, round);
  return { ...mock, tokensUsed: 0, provider: 'mock', model: 'built-in' };
}

// ============================================================================
// Pre/Post assessment generation from handouts (overhaul Phase 5)
// ============================================================================

/** The four types the spec requires, as stored in tutor_assessment_questions. */
const SPEC_QUESTION_TYPES = ['multiple_choice', 'true_false', 'fill_blank', 'essay'];

/**
 * How many of each type to ask for, given a total item count.
 * The spec requires a Pre-Assessment to contain a mix of all four, so every type
 * gets at least one slot once there is room for it.
 */
function planQuestionMix(itemCount, requestedType = 'mixed') {
  const total = Math.max(1, Number(itemCount) || 10);

  if (requestedType && requestedType !== 'mixed' && SPEC_QUESTION_TYPES.includes(requestedType)) {
    return { [requestedType]: total };
  }

  if (total < 4) {
    // Not enough room for all four; lead with the most gradeable types.
    const order = ['multiple_choice', 'true_false', 'fill_blank', 'essay'];
    const mix = {};
    for (let i = 0; i < total; i++) mix[order[i]] = (mix[order[i]] || 0) + 1;
    return mix;
  }

  const mix = {
    multiple_choice: Math.max(1, Math.round(total * 0.4)),
    true_false: Math.max(1, Math.round(total * 0.2)),
    fill_blank: Math.max(1, Math.round(total * 0.2)),
    essay: Math.max(1, Math.round(total * 0.2))
  };
  // Rounding can overshoot or undershoot; settle the difference on MC.
  const diff = total - Object.values(mix).reduce((a, b) => a + b, 0);
  mix.multiple_choice = Math.max(1, mix.multiple_choice + diff);
  return mix;
}

/**
 * Normalise and validate one AI-returned question.
 * Returns null when the question cannot be trusted, so bad items are dropped
 * rather than stored and shown to a student.
 */
function validateGeneratedQuestion(raw, allowedHandouts) {
  if (!raw || typeof raw !== 'object') return null;

  const questionText = String(raw.question_text || '').trim();
  if (questionText.length < 5) return null;

  const type = SPEC_QUESTION_TYPES.includes(raw.question_type) ? raw.question_type : null;
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
    const answer = String(raw.correct_answer || '').trim();
    if (!answer) return null;
    base.correct_answer = answer.slice(0, 500);
    return base;
  }

  // essay
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
 * @param {number} [options.itemCount=10]
 * @param {string} [options.questionType='mixed'] one of the four types, or 'mixed'
 * @returns {Promise<{questions: Array, tokensUsed: number, provider: string, model: string, requested: number, kept: number}>}
 */
async function generateAssessmentFromHandouts(options = {}) {
  const {
    handouts = [], subject, yearLevel, itemCount = 10, questionType = 'mixed'
  } = options;

  const usable = handouts.filter((h) => String(h.extracted_text || '').trim().length > 50);
  if (!usable.length) {
    throw new Error('None of this subject\'s handouts have readable text yet, so questions cannot be generated from them.');
  }
  if (!isOpenAIConfigured()) {
    throw new Error('The AI service is not configured, so assessment questions cannot be generated.');
  }

  const allowed = new Map(usable.map((h) => [Number(h.handout_id), h]));
  const mix = planQuestionMix(itemCount, questionType);
  const mixText = Object.entries(mix).map(([type, n]) => `${n} x ${type}`).join(', ');

  // Asking the model to "spread questions across handouts" was not enough — in
  // testing it drew all 8 questions from the first handout, which would make the
  // weak-area view blind to the other modules. So the quota is stated per
  // handout id, explicitly.
  const perHandout = new Array(usable.length).fill(Math.floor(itemCount / usable.length));
  for (let i = 0; i < itemCount % usable.length; i++) perHandout[i]++;
  const quotaText = usable
    .map((h, i) => `- handout_id ${h.handout_id}: exactly ${perHandout[i]} question(s)`)
    .filter((_line, i) => perHandout[i] > 0)
    .join('\n');

  const systemPrompt = `You write assessment questions for a tutorial centre, using ONLY the handout text provided.

Return a JSON object with a single key "questions", an array of exactly ${itemCount} objects.
Produce this mix of question types: ${mixText}.

Draw this many questions from each handout — this quota is mandatory:
${quotaText}

Every question object must have:
- "question_text": the question, answerable purely from the handouts
- "question_type": one of "multiple_choice", "true_false", "fill_blank", "essay"
- "source_handout_id": the integer id of the handout the question comes from. Use ONLY the ids listed in the handout sections below.
- "correct_answer":
    * multiple_choice -> the letter of the correct choice ("A", "B", "C" or "D")
    * true_false      -> exactly "true" or "false"
    * fill_blank      -> the exact word or short phrase that fills the blank
    * essay           -> a concise model answer
- "choices": for multiple_choice ONLY, an array of 4 distinct answer strings in A,B,C,D order. Omit for other types.
- "answer_rubric": for essay ONLY, the key points a correct answer must mention, so it can be graded automatically.
- "explanation": one short sentence on why the answer is correct.

Rules:
- Base every question on the handout content. Never invent facts that are not in the text.
- For fill_blank, write the sentence with a blank shown as ____ and put the missing text in correct_answer.
- Make the difficulty appropriate for a ${yearLevel || 'general'} student.
- Respect the per-handout quota above exactly.
- In "choices", give the answer text ONLY. Do not prefix it with "A.", "B)" or any label.
- All four choices of a multiple_choice question must be different from each other.
- Output strict JSON only. No commentary, no markdown.`;

  const sources = usable
    .map((h) => {
      const label = `Module ${h.order_number} — ${h.module_title}` + (h.file_original_name ? ` (${h.file_original_name})` : '');
      return `### handout_id: ${h.handout_id}\n### source: ${label}\n${String(h.extracted_text).trim()}`;
    })
    .join('\n\n---\n\n');

  const userPrompt = `Subject: ${subject || 'General'}
Student level: ${yearLevel || 'General'}
Number of questions: ${itemCount}

HANDOUTS:

${sources}`;

  const { result, tokensUsed } = await callOpenAI(systemPrompt, userPrompt);
  const rawQuestions = Array.isArray(result.questions) ? result.questions : [];

  const questions = [];
  for (const raw of rawQuestions) {
    const validated = validateGeneratedQuestion(raw, allowed);
    if (validated) questions.push(validated);
    if (questions.length >= itemCount) break;
  }

  if (!questions.length) {
    throw new Error('The AI did not return any usable questions. Please try again.');
  }

  return {
    questions,
    tokensUsed,
    provider: 'openai',
    model: AI_MODEL,
    requested: itemCount,
    kept: questions.length
  };
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
  generateModuleFromAssessmentResult,
  gradeEssayAnswer,
  gradeEssayAnswers,
  transcribeImage,
  generateAssessmentFromHandouts,
  planQuestionMix,
  SPEC_QUESTION_TYPES,
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
