

require('dotenv').config();

const AI_PROVIDER = String(process.env.AI_PROVIDER || 'mock').toLowerCase();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';



async function callOpenAI(systemPrompt, userPrompt, options = {}) {
  
  
  
  
  
  
  
  const { maxTokens = 4000, temperature = 0.7 } = options;
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
        temperature,
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


async function transcribeImage(dataUrl) {
  
  
  
  
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
  
  text = text.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  
  if (/^(no (readable )?text|this (page|image) (is|contains|appears))/i.test(text)) text = '';
  return { text, tokensUsed: data.usage?.total_tokens || 0 };
}


function isOpenAIConfigured() {
  try {
    return AI_PROVIDER === 'openai' && OPENAI_API_KEY.length > 10;
  } catch (_error) {
    return false;
  }
}



const QUESTION_TYPES = ['Multiple Choice', 'True or False', 'Identification'];

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateMockQuestions(subject, levelGroup, count = 20) {
  const questions = [];
  const levelLabel = levelGroup || 'General';
  const subjectName = subject || 'General Subject';

  
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

  
  const questions = generateMockQuestions(subject, levelGroup, questionCount);
  return { questions, tokensUsed: 0, provider: 'mock', model: 'built-in' };
}




const PRE_POST_QUESTION_TYPES = ['multiple_choice'];
const MODULE_QUESTION_TYPES = ['multiple_choice', 'true_false'];


const SPEC_QUESTION_TYPES = MODULE_QUESTION_TYPES;

const { PRE_ASSESSMENT_ITEM_COUNT } = require('../config/assessmentDefaults');


function planQuestionMix(itemCount, requestedType = 'mixed', allowedTypes = MODULE_QUESTION_TYPES) {
  const total = Math.max(1, Number(itemCount) || 10);
  const types = (allowedTypes && allowedTypes.length) ? allowedTypes : MODULE_QUESTION_TYPES;

  
  if (types.length === 1) return { [types[0]]: total };

  if (requestedType && requestedType !== 'mixed' && types.includes(requestedType)) {
    return { [requestedType]: total };
  }

  if (total < types.length) {
    
    const mix = {};
    for (let i = 0; i < total; i++) {
      const type = types[i];
      mix[type] = (mix[type] || 0) + 1;
    }
    return mix;
  }

  
  const mix = {};
  const primary = types[0];
  mix[primary] = Math.max(1, Math.round(total * 0.5));
  const rest = types.slice(1);
  const share = Math.max(1, Math.floor((total - mix[primary]) / rest.length));
  rest.forEach((type) => { mix[type] = share; });

  
  const diff = total - Object.values(mix).reduce((a, b) => a + b, 0);
  mix[primary] = Math.max(1, mix[primary] + diff);
  return mix;
}


function normaliseChoice(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/^[."'(\[]+|[.,;:!?"')\]]+$/g, '').trim();
}

/** A choice that is just a number ("36", "-3", "1,200", "2.5"), as a number. */
function numericChoice(text) {
  const raw = String(text || '').trim().replace(/[−–]/g, '-').replace(/,/g, '');
  return /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : null;
}

/**
 * The letter of the right answer to a bare arithmetic question — "What is 6 x 6?",
 * "12 ÷ 3 = ?", "What is the sum of 7 + 5?" — worked out, not asked of anyone.
 *
 *   null  not a question of that kind (most questions)
 *   ''    it is, but no choice — or more than one — holds the result, so the
 *         item cannot be marked fairly and is dropped
 *   'B'   the choice holding the result
 *
 * Deliberately narrow: only a question that IS one expression. A word problem
 * ("8 apples in each of 5 boxes") is left to the answer-key check.
 */
function arithmeticKey(questionText, choices = []) {
  const text = String(questionText || '').trim()
    .replace(/[−–]/g, '-').replace(/×/g, 'x').replace(/÷/g, '/');
  const match = text.match(
    /^(?:what\s+is|what's|compute|calculate|find|solve|evaluate|give)?\s*(?:the\s+(?:value|result|answer|product|sum|difference|quotient)\s+of\s+)?(-?\d+(?:\.\d+)?)\s*([x*\/+-])\s*(-?\d+(?:\.\d+)?)\s*(?:=\s*)?(?:\?|\.)?\s*$/i
  );
  if (!match) return null;
  const a = Number(match[1]);
  const b = Number(match[3]);
  let result;
  switch (match[2].toLowerCase()) {
    case 'x': case '*': result = a * b; break;
    case '/': if (b === 0) return ''; result = a / b; break;
    case '+': result = a + b; break;
    case '-': result = a - b; break;
    default: return null;
  }
  const hits = choices.filter((c) => {
    const value = numericChoice(c.text);
    return value !== null && Math.abs(value - result) < 1e-9;
  });
  return hits.length === 1 ? hits[0].label : '';
}


function validateGeneratedQuestion(raw, allowedHandouts, allowedTypes = MODULE_QUESTION_TYPES) {
  if (!raw || typeof raw !== 'object') return null;

  const questionText = String(raw.question_text || '').trim();
  if (questionText.length < 5) return null;

  
  
  
  const type = allowedTypes.includes(raw.question_type) ? raw.question_type : null;
  if (!type) return null;

  
  
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
    
    
    
    if (/\bA[).]\s.{2,}\bB[).]\s/s.test(questionText)) return null;

    
    
    const stripLabel = (text) => String(text || '').trim().replace(/^\(?[A-Ea-e][).:]\s+/, '').trim();

    let choices = Array.isArray(raw.choices) ? raw.choices.map(stripLabel).filter(Boolean) : [];
    if (choices.length < 2) return null;

    
    
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

    
    const rawAnswer = String(raw.correct_answer || '').trim();
    let letter = /^[A-E]$/i.test(rawAnswer) ? rawAnswer.toUpperCase() : '';
    if (!letter) {
      const idx = base.choices.findIndex(
        (c) => normaliseChoice(c.text) === normaliseChoice(stripLabel(rawAnswer))
      );
      if (idx >= 0) letter = base.choices[idx].label;
    }

    
    
    
    
    const answerText = stripLabel(raw.correct_choice_text || '');
    if (answerText) {
      const byText = base.choices.find((c) => normaliseChoice(c.text) === normaliseChoice(answerText));
      if (byText && byText.label !== letter) letter = byText.label;
    }

    
    const worked = arithmeticKey(questionText, base.choices);
    if (worked === '') return null;
    if (worked) letter = worked;

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

  
  const rubric = String(raw.answer_rubric || raw.expected_answer || '').trim();
  if (rubric.length < 10) return null;
  base.answer_rubric = rubric;
  base.correct_answer = rubric.slice(0, 500);
  return base;
}


async function verifyAnswerKeys(questions = [], handout = {}) {
  if (!questions.length) return { kept: [], rejected: [], checked: false, tokensUsed: 0 };

  const systemPrompt = `You check the answer key of quiz questions that were written from a handout.
You are NOT given the key. Answer every question yourself, using the handout text and plain, certain facts.

Return a JSON object: {"results": [{"n": <question number>, "correct": [...], "reason": "<a few words>"}]}
- multiple_choice: "correct" lists EVERY choice letter that is a right answer to the question exactly as it is
  written. If two or more choices are right, list all of them. If none is right, return [].
- true_false: "correct" is ["true"] or ["false"]. If the handout does not settle it, return [].
Be strict: a question is only fair when exactly one choice is right.
Output strict JSON only. No commentary, no markdown.`;

  const lines = questions.map((q, i) => {
    if (q.question_type === 'true_false') return `${i + 1}. [true_false] ${q.question_text}`;
    const choices = (q.choices || []).map((c) => `   ${c.label}) ${c.text}`).join('\n');
    return `${i + 1}. [multiple_choice] ${q.question_text}\n${choices}`;
  });
  const userPrompt = `HANDOUT${handout.module_title ? ` (Module ${handout.order_number} — ${handout.module_title})` : ''}
${String(handout.extracted_text || '').trim()}

QUESTIONS
${lines.join('\n')}`;

  let reply;
  let tokensUsed = 0;
  try {
    const call = await callOpenAI(systemPrompt, userPrompt, {
      maxTokens: Math.min(6000, 300 + questions.length * 70),
      temperature: 0
    });
    reply = call.result;
    tokensUsed = call.tokensUsed || 0;
  } catch (error) {
    console.error('[aiService] answer-key check could not run:', error.message);
    return { kept: questions, rejected: [], checked: false, tokensUsed };
  }

  const results = Array.isArray(reply && reply.results) ? reply.results : null;
  if (!results) return { kept: questions, rejected: [], checked: false, tokensUsed };

  const byNumber = new Map();
  results.forEach((row, i) => {
    const n = Number(row && row.n) || i + 1;
    if (!byNumber.has(n)) byNumber.set(n, row);
  });

  const kept = [];
  const rejected = [];
  questions.forEach((q, i) => {
    const row = byNumber.get(i + 1);
    
    if (!row || !Array.isArray(row.correct)) { kept.push(q); return; }
    const found = [...new Set(row.correct.map((value) => String(value || '').trim()).filter(Boolean))];
    const key = String(q.correct_answer || '').trim();
    const agrees = q.question_type === 'true_false'
      ? found.length === 1 && found[0].toLowerCase() === key.toLowerCase()
      : found.length === 1 && found[0].toUpperCase() === key.toUpperCase();
    if (agrees) kept.push(q);
    else rejected.push({ question: q, checker: found, reason: String(row.reason || '').slice(0, 200) });
  });
  return { kept, rejected, checked: true, tokensUsed };
}


async function generateAssessmentFromHandouts(options = {}) {
  const {
    handouts = [], subject, yearLevel, itemCount = PRE_ASSESSMENT_ITEM_COUNT, questionType = 'mixed',


    allowedTypes = MODULE_QUESTION_TYPES, level = null, focus = null
  } = options;

  const usable = handouts.filter((h) => String(h.extracted_text || '').trim().length > 50);
  if (!usable.length) {
    throw new Error('None of this subject\'s handouts have readable text yet, so questions cannot be generated from them.');
  }
  if (!isOpenAIConfigured()) {
    throw new Error('The AI service is not configured, so assessment questions cannot be generated.');
  }

  const allowed = new Map(usable.map((h) => [Number(h.handout_id), h]));

  
  
  
  
  const tokenBudget = (n) => Math.min(16000, 1200 + n * 240);

  
  
  
  
  
  
  
  
  const quotas = spreadEvenly(itemCount, usable.length);
  const seen = new Set();
  let tokensUsed = 0;
  
  let rejectedByCheck = 0;

  
  const takeChecked = async (rawQuestions, slot) => {
    const fresh = [];
    absorb(rawQuestions, fresh);
    
    
    slot.written.push(...fresh.map((q) => q.question_text));
    const check = await verifyAnswerKeys(fresh, slot.handout);
    tokensUsed += check.tokensUsed;
    rejectedByCheck += check.rejected.length;
    if (check.rejected.length) {
      console.log(`[aiService] answer-key check dropped ${check.rejected.length} of ${fresh.length} item(s) for handout ${slot.handout.handout_id}`);
    }
    slot.questions.push(...check.kept);
  };

  const absorb = (rawQuestions, into) => {
    for (const raw of Array.isArray(rawQuestions) ? rawQuestions : []) {
      const validated = validateGeneratedQuestion(raw, allowed, allowedTypes);
      if (!validated) continue;
      
      
      const key = normalizeQuestionKey(validated.question_text);
      if (seen.has(key)) continue;
      seen.add(key);
      into.push(validated);
    }
  };

  const perHandout = usable.map((handout, i) => ({ handout, wanted: quotas[i], questions: [], written: [] }));

  
  
  
  
  await runWithConcurrency(perHandout.filter((slot) => slot.wanted > 0), 4, async (slot) => {
    const batch = slot.wanted + 2;
    const prompts = buildHandoutPrompts({
      handout: slot.handout, wanted: batch, questionType, subject, yearLevel, level, allowedTypes, focus
    });
    try {
      const call = await callOpenAI(prompts.systemPrompt, prompts.userPrompt, {
        maxTokens: tokenBudget(batch), temperature: GENERATION_TEMPERATURE
      });
      tokensUsed += call.tokensUsed;
      await takeChecked(call.result.questions, slot);
    } catch (error) {
      
      console.error(`[aiService] generation failed for handout ${slot.handout.handout_id}:`, error.message);
    }
  });

  
  
  
  
  let short = perHandout.filter((slot) => slot.questions.length < slot.wanted);
  const topUpUsed = short.length > 0;
  for (let round = 1; round <= TOP_UP_ROUNDS && short.length; round++) {
    const before = new Map(short.map((slot) => [slot, slot.questions.length]));
    await runWithConcurrency(short, 4, async (slot) => {
      const batch = Math.max(4, (slot.wanted - slot.questions.length) + 3);
      const prompts = buildHandoutPrompts({
        handout: slot.handout, wanted: batch, questionType, subject, yearLevel, level, allowedTypes,
        avoidTexts: slot.written, focus
      });
      try {
        const call = await callOpenAI(prompts.systemPrompt, prompts.userPrompt, {
          maxTokens: tokenBudget(batch), temperature: TOP_UP_TEMPERATURE
        });
        tokensUsed += call.tokensUsed;
        await takeChecked(call.result.questions, slot);
      } catch (error) {
        console.error(`[aiService] top-up failed for handout ${slot.handout.handout_id}:`, error.message);
      }
    });
    short = short.filter((slot) => slot.questions.length < slot.wanted && slot.questions.length > before.get(slot));
  }

  
  
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
    rejectedByCheck,
    topUpUsed
  };
}


const GENERATION_TEMPERATURE = 0.4;


const TOP_UP_TEMPERATURE = 0.9;
const TOP_UP_ROUNDS = 2;


function spreadEvenly(total, parts) {
  const base = Math.floor(total / parts);
  return Array.from({ length: parts }, (_v, i) => base + (i < total % parts ? 1 : 0));
}


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
  sweep((q) => typeQuota[q.question_type] > 0);   
  sweep((q) => handoutQuota[q.source_handout_id] > 0); 
  sweep(() => true);

  
  return chosen.sort((a, b) => a.index - b.index).map((c) => c.question);
}


function normalizeQuestionKey(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}


const LEVEL_QUESTION_GUIDES = {
  Beginner: 'Pitch every question at a BEGINNER: recalling and recognising the key facts and terms, one step each, in simple words.',
  Intermediate: 'Pitch every question at the INTERMEDIATE level: applying the ideas to a short example or situation, not only recalling them.',
  Advance: 'Pitch every question at the ADVANCE level: reasoning, comparing, and problems that take several steps, so the ideas must be understood and not only remembered.'
};


function buildHandoutPrompts({
  handout, wanted, questionType, subject, yearLevel, level = null,
  allowedTypes = MODULE_QUESTION_TYPES, avoidTexts = [], focus = null
}) {
  const itemCount = wanted;
  const mix = planQuestionMix(itemCount, questionType, allowedTypes);
  const mixText = Object.entries(mix).map(([type, n]) => `${n} x ${type}`).join(', ');

  
  
  
  
  const answerRules = {
    multiple_choice: '    * multiple_choice -> the letter of the correct choice ("A", "B", "C" or "D")',
    true_false: '    * true_false      -> exactly "true" or "false"',
    essay: '    * essay           -> a concise model answer'
  };
  const typeList = allowedTypes.map((type) => `"${type}"`).join(', ');
  const answerLines = allowedTypes.map((type) => answerRules[type]).filter(Boolean).join('\n');

  
  const extraRules = ['- Never write a fill-in-the-blank question. Ask it as multiple_choice instead.'];
  if (allowedTypes.includes('essay')) {
    extraRules.push('- "answer_rubric": for essay ONLY, the key points a correct answer must mention, so it can be graded automatically.');
  } else {
    extraRules.push('- Never write an essay or open-ended question. Every item must have one exact answer.');
  }
  if (LEVEL_QUESTION_GUIDES[level]) extraRules.push(`- ${LEVEL_QUESTION_GUIDES[level]}`);
  if (focus) extraRules.push(`- ${String(focus).trim()}`);

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
- "correct_choice_text": for multiple_choice ONLY, the full text of the correct choice, copied exactly.
- "explanation": one short sentence on why the answer is correct.

Rules:
- Base every question on the handout content. Never invent facts that are not in the text.
- Exactly ONE choice may be correct. Every other choice must be clearly wrong — never offer two choices that
  could both be right (for example two negative numbers when asking for "a negative integer").
- Before writing "correct_answer", re-read the question and check that the letter points at the right choice.
${extraRules.join('\n')}
- Make the difficulty appropriate for a ${yearLevel || 'general'} student.
- Keep the choices out of "question_text": no "A) ... B) ..." list, no answer letter.
- In "choices", give the answer text ONLY. Do not prefix it with "A.", "B)" or any label.
- All four choices of a multiple_choice question must be different from each other.
- Every question must be different from every other question in this set.
- Output strict JSON only. No commentary, no markdown.${avoidTexts.length ? `

These questions already exist in this assessment. Do NOT repeat them or ask the
same thing in different words. Ask about OTHER details, examples, words and
sentences of the handout instead:
${avoidTexts.map((t) => `- ${t}`).join('\n')}` : ''}`;

  const label = `Module ${handout.order_number} — ${handout.module_title}`
    + (handout.file_original_name ? ` (${handout.file_original_name})` : '');

  const userPrompt = `Subject: ${subject || 'General'}
Student level: ${yearLevel || 'General'}${LEVEL_QUESTION_GUIDES[level] ? `\nLearner level: ${level}` : ''}
Number of questions: ${itemCount}

HANDOUT
### handout_id: ${handout.handout_id}
### source: ${label}

${String(handout.extracted_text).trim()}`;

  return { systemPrompt, userPrompt };
}


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

  
  const mock = generateMockEssayGrade(questionText, studentAnswer);
  return { ...mock, tokensUsed: 0, provider: 'mock' };
}


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
  generateLevelLesson,
  generateModuleAdditions,
  cleanLessonText,
  LEVEL_QUESTION_GUIDES,
  planQuestionMix,
  validateGeneratedQuestion,
  
  verifyAnswerKeys,
  arithmeticKey,
  SPEC_QUESTION_TYPES,
  PRE_POST_QUESTION_TYPES,
  MODULE_QUESTION_TYPES,
  isOpenAIConfigured,
  getAiStatus
};


async function gradeEssayAnswers(essays = []) {
  if (!essays.length) return [];

  
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

  
  return essays.map(e => {
    const student = String(e.studentAnswer || '').trim().toLowerCase();
    const expected = String(e.expectedAnswer || '').trim().toLowerCase();
    if (!student || student.length < 3) return { isCorrect: false, score: 0, feedback: 'No meaningful answer provided.' };
    if (!expected) return { isCorrect: true, score: 1, feedback: 'No expected answer to compare.' };

    
    const expectedWords = expected.split(/\s+/).filter(w => w.length > 3);
    const matchingWords = expectedWords.filter(w => student.includes(w));
    const matchRatio = expectedWords.length > 0 ? matchingWords.length / expectedWords.length : 0;

    
    const isCorrect = matchRatio >= 0.5;
    return {
      isCorrect,
      score: Number(matchRatio.toFixed(2)),
      feedback: isCorrect ? 'Your answer captures the key ideas.' : 'Your answer does not sufficiently match the expected answer.'
    };
  });
}




async function generateFocusMaterial(options = {}) {
  const { studentName, subject, yearLevel, percentage, topics = [], sources = [] } = options;
  if (!isOpenAIConfigured() || !topics.length) return null;

  const topicList = topics
    .map((t, i) => `${i + 1}. ${t.topic} — scored ${t.correct}/${t.total} (${t.percentage}%)`)
    .join('\n');

  
  
  
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


const LEVEL_LESSON_GUIDES = {
  Beginner: 'This learner is a BEGINNER in this topic. Start from the very basics. Use simple words and short sentences, '
    + 'explain one idea at a time, step by step, and give two or three easy worked examples.',
  Intermediate: 'This learner is at the INTERMEDIATE level. Recap the key ideas briefly, then focus on using them: '
    + 'worked examples that apply the ideas, and the mistakes learners commonly make with them.',
  Advance: 'This learner is at the ADVANCE level and already knows the basics. Keep the recap short and go deeper: '
    + 'why and how the ideas work, how they compare with each other, and problems that take several steps.'
};


async function generateLevelLesson(options = {}) {
  const { handout = {}, level, subject, gradeLevel, moduleTitle } = options;
  const guide = LEVEL_LESSON_GUIDES[level];
  if (!guide) throw new Error(`Unknown level "${level}".`);
  const sourceText = String(handout.extracted_text || '').trim();
  if (sourceText.length < 50) throw new Error('This handout has no readable text to write a lesson from.');
  if (!isOpenAIConfigured()) throw new Error('The AI service is not configured, so the lesson cannot be written.');

  const systemPrompt = `You write one lesson of a learning module for a learner at a tutorial centre, using ONLY the handout text provided.

${guide}

Return a JSON object with two keys:
- "title": a short title for this lesson, under 80 characters
- "lesson": the lesson as plain text

Lay the lesson out like this:
- a line starting with "## " for the heading of each part
- a line starting with "- " for each item of a list
- an empty line between paragraphs
End with a part headed "## Check yourself": three short questions on this lesson, each followed on the next line by its answer, starting with "Answer: ".

Rules:
- Use ONLY facts present in the handout text. Never invent facts, names or numbers the handout does not give.
- Write in the same language as the handout.
- Write to the learner ("you"), in words a ${gradeLevel || 'young'} learner understands.
- Keep it between 250 and 600 words.
- No other markdown: no bold, no italics, no tables, no code.`;

  const userPrompt = `Subject: ${subject || 'General'}
Grade: ${gradeLevel || 'General'}
Level: ${level}
Module: ${moduleTitle || 'Module'}

HANDOUT
### ${handout.file_original_name || 'Handout'}

${sourceText.slice(0, 12000)}`;

  const call = await callOpenAI(systemPrompt, userPrompt, { maxTokens: 2000, temperature: 0.4 });
  const lesson = cleanLessonText(call.result.lesson);
  if (lesson.length < 200) throw new Error('The AI returned a lesson too short to use.');
  return {
    title: String(call.result.title || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    lesson,
    tokensUsed: call.tokensUsed,
    provider: call.provider,
    model: call.model
  };
}


function cleanLessonText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`+/g, '')
    .replace(/^#{1,6}[ \t]*/gm, '## ')
    .replace(/^[ \t]*[*•][ \t]+/gm, '- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 9000);
}

/** Most weak points found in one handout of a module, for one learner. */
const MAX_WEAK_POINTS = 4;

/** Topics added to a learner's module for every weak point. */
const TOPICS_PER_WEAK_POINT = 5;

/** Characters of module text sent to the AI, all pages together. */
const ADDITION_SOURCE_CHARS = 28000;

/** An added topic shorter than this is not a topic. */
const MIN_TOPIC_CHARS = 150;

/** One line of text, no longer than `max`. */
function oneLine(value, max = 200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * The module's pages as the AI reads them, each headed by its number, so it can
 * say after which page an added part belongs.
 */
function modulePagesForPrompt({ pages = [], pageCount = 0, fallbackText = '' } = {}) {
  const readable = pages.filter((page) => String(page.text || '').trim().length > 0);
  const totalPages = Math.max(pages.length, Number(pageCount) || 0);
  let sourceText;
  if (readable.length) {
    const perPage = Math.max(600, Math.min(2500, Math.floor(ADDITION_SOURCE_CHARS / readable.length)));
    sourceText = readable
      .map((page) => `=== Page ${page.num} ===\n${String(page.text).trim().slice(0, perPage)}`)
      .join('\n\n');
  } else {
    const text = String(fallbackText || '').trim();
    if (text.length < 50) throw new Error('This module has no readable text to add lessons to.');
    sourceText = `=== Pages 1 to ${totalPages || 1} (which page each part is on is not known) ===\n${text.slice(0, ADDITION_SOURCE_CHARS)}`;
  }
  const lastPage = Math.max(1, totalPages || (readable.length ? readable[readable.length - 1].num : 1));
  return { sourceText, pagesKnown: readable.length > 0, totalPages, lastPage };
}

function missedQuestionsForPrompt(missed = []) {
  return missed.map((q, i) => {
    const lines = [`${i + 1}. ${String(q.question_text || '').trim()}`];
    if (q.correct_text) lines.push(`   Correct answer: ${String(q.correct_text).trim()}`);
    if (q.explanation) lines.push(`   Why: ${String(q.explanation).trim()}`);
    return lines.join('\n');
  }).join('\n');
}

/**
 * A topic's text laid out the same way every time: no first line repeating its
 * title ("Topic 1: …"), "Try this:" starting a paragraph of its own and
 * "Answer:" a line of its own, so the page and the PDF show them apart.
 */
function tidyTopicText(text, title) {
  const lines = String(text || '').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  if (lines.length) {
    const first = lines[0].trim();
    const bare = (value) => String(value || '').trim().replace(/[\s:.\-–—]+$/, '').toLowerCase();
    const repeatsTitle = !!title && bare(first) === bare(title);
    const numbered = /^topic\s*\d+(\s*of\s*\d+)?\s*[:.\-–—]/i.test(first) && first.length <= 140;
    if (repeatsTitle || numbered) lines.shift();
  }
  return lines.join('\n')
    .replace(/\s*\b(Try this|Subukan mo ito)\s*:\s*/gi, (_m, label) => `\n\n${label}: `)
    .replace(/\s*\b(Answer|Sagot)\s*:\s*/g, (_m, label) => `\n${label}: `)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A page number from the AI, put back between 1 and the last page. */
function pageInRange(value, lastPage) {
  const page = Math.round(Number(value));
  return Number.isFinite(page) ? Math.min(Math.max(1, page), lastPage) : lastPage;
}

/** The words of a text (four letters or more), to tell which weak point a question is closest to. */
function wordsOf(text) {
  return new Set(String(text || '').toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []);
}

function promptHeader({ subject, gradeLevel, level, moduleTitle }) {
  return `Subject: ${subject || 'General'}
Grade: ${gradeLevel || 'General'}
Level: ${level || 'Beginner'}
Module: ${moduleTitle || 'Module'}`;
}

/**
 * The learner's weak points in this part of a module: one for each idea behind
 * the Pre-Assessment questions they got wrong, with the page that teaches it and
 * the titles of the topics that will teach it. Every missed question belongs to
 * exactly one weak point: those the plan leaves out are asked about once more —
 * an existing weak point, or a new one while there is room — and any still left
 * join the weak point they share the most words with.
 */
const WEAK_POINT_FIELDS = (pagesInfo) => `- "title": the idea, in a few words (under 60 characters), named the way the module names it
- "focus": one sentence naming exactly what there is to learn about this idea — the part that was got wrong — as a goal, in plain words, for example "Which sense organ goes with each of the five senses." (do not write "you" or "the learner")
- "after_page": the number of the module page that teaches this idea${pagesInfo.pagesKnown ? '' : `. The page of each part is not known, so use ${pagesInfo.totalPages || 1}`}
- "covers": the numbers of the missed questions that come from this idea
- "topics": exactly ${TOPICS_PER_WEAK_POINT} short titles (under 70 characters) of the topics to add to the module to teach this idea, in teaching order`;

const WEAK_POINT_RULES = `- The ${TOPICS_PER_WEAK_POINT} topics of a weak point are all about that idea and all different from each other. They build the idea up
  step by step, for example: what it is; its parts, rules or steps; worked examples from the module; the mistake made
  and how to avoid it; using it in a new example.
- Plan only what the module pages teach. Never plan a topic the module has nothing on.
- Write in the same language as the module.
- Output strict JSON only. No commentary, no markdown.`;

/** One weak point from the AI, its questions limited to those not taken yet; null when unusable. */
function weakPointFrom(item, allowed, pagesInfo) {
  const title = oneLine(item && item.title, 120);
  const covers = [...new Set((Array.isArray(item && item.covers) ? item.covers : [])
    .map((n) => Math.round(Number(n)))
    .filter((n) => allowed.has(n)))];
  if (!title || !covers.length) return null;
  return {
    title,
    focus: oneLine(item && (item.focus || item.missed), 400),
    after_page: pageInRange(item && item.after_page, pagesInfo.lastPage),
    covers,
    topics: (Array.isArray(item && item.topics) ? item.topics : [])
      .map((topic) => oneLine(typeof topic === 'object' && topic ? topic.title : topic, 120))
      .filter(Boolean)
      .slice(0, TOPICS_PER_WEAK_POINT)
  };
}

async function planWeakPoints(context) {
  const { missed, pagesInfo } = context;
  const systemPrompt = `You study the Pre-Assessment mistakes of ONE learner on ONE learning module at a tutorial centre,
and find their WEAK POINTS: the ideas of the module this learner does not know yet.

Return a JSON object with one key, "weak_points": an array of 1 to ${MAX_WEAK_POINTS} objects, each with
${WEAK_POINT_FIELDS(pagesInfo)}

Rules:
- One weak point per distinct idea. Missed questions about the same idea belong to the same weak point.
- Every missed question, 1 to ${missed.length}, is in the "covers" of exactly one weak point. Check this before you answer.
${WEAK_POINT_RULES}`;

  const userPrompt = `${promptHeader(context)}

QUESTIONS THIS LEARNER GOT WRONG ON THE PRE-ASSESSMENT
${missedQuestionsForPrompt(missed)}

MODULE PAGES
${pagesInfo.sourceText}`;

  const call = await callOpenAI(systemPrompt, userPrompt, { maxTokens: 2000, temperature: 0.3 });
  let tokensUsed = call.tokensUsed || 0;
  const raw = Array.isArray(call.result && call.result.weak_points) ? call.result.weak_points : [];
  const claimed = new Set();
  const open = () => new Set(missed.map((_q, i) => i + 1).filter((n) => !claimed.has(n)));
  const points = [];
  for (const item of raw) {
    if (points.length >= MAX_WEAK_POINTS) break;
    // A question already in an earlier weak point stays there.
    const point = weakPointFrom(item, open(), pagesInfo);
    if (!point) continue;
    point.covers.forEach((n) => claimed.add(n));
    points.push(point);
  }
  if (!points.length) throw new Error('The AI found no weak point in this module it could use.');

  if (open().size) {
    try {
      tokensUsed += await placeLeftovers(context, points, claimed);
    } catch (error) {
      console.error('[aiService] the questions left out of the weak points could not be placed:', error.message);
    }
  }

  missed.forEach((question, index) => {
    const n = index + 1;
    if (claimed.has(n)) return;
    const words = wordsOf(`${question.question_text || ''} ${question.correct_text || ''}`);
    let best = points[0];
    let bestShared = -1;
    for (const point of points) {
      const pointWords = wordsOf([
        point.title, point.focus, ...point.topics,
        ...point.covers.map((c) => (missed[c - 1] && missed[c - 1].question_text) || '')
      ].join(' '));
      let shared = 0;
      for (const word of words) if (pointWords.has(word)) shared += 1;
      if (shared > bestShared) { best = point; bestShared = shared; }
    }
    best.covers.push(n);
    claimed.add(n);
  });
  for (const point of points) point.covers.sort((a, b) => a - b);
  return { points, tokensUsed };
}

/**
 * The missed questions a plan left out, placed by the AI: each in the existing
 * weak point it is about, or in new weak points of their own while there is
 * room. Changes `points` and `claimed`; returns the tokens it used.
 */
async function placeLeftovers(context, points, claimed) {
  const { missed, pagesInfo } = context;
  const left = missed.map((_q, i) => i + 1).filter((n) => !claimed.has(n));
  const room = Math.max(0, MAX_WEAK_POINTS - points.length);
  const systemPrompt = `Some questions a learner got wrong on a Pre-Assessment are not in any of their WEAK POINTS yet. Put each one where it belongs.

Return a JSON object with two keys:
- "placed": one object {"n": <question number>, "weak_point": <number of an existing weak point>} for every question that is about the idea of an existing weak point
- "new_weak_points": ${room ? `up to ${room} new weak points for the questions about another idea of the module, each with` : 'always an empty array: there is no room for another weak point'}
${room ? WEAK_POINT_FIELDS(pagesInfo) : ''}

Rules:
- Every question listed below is placed exactly once${room ? ': in an existing weak point, or in the "covers" of a new one' : ''}.
- A question goes in an existing weak point only when it is truly about that weak point's idea.
${room ? WEAK_POINT_RULES : '- Output strict JSON only. No commentary, no markdown.'}`;

  const userPrompt = `${promptHeader(context)}

THE WEAK POINTS SO FAR
${points.map((point, i) => `${i + 1}. ${point.title} — ${point.focus || ''}`).join('\n')}

QUESTIONS NOT IN A WEAK POINT YET
${left.map((n) => missedQuestionsForPrompt([missed[n - 1]]).replace(/^1\./, `${n}.`)).join('\n')}

MODULE PAGES
${pagesInfo.sourceText}`;

  const call = await callOpenAI(systemPrompt, userPrompt, { maxTokens: 1800, temperature: 0.2 });
  const result = call.result || {};
  for (const item of Array.isArray(result.new_weak_points) ? result.new_weak_points : []) {
    if (points.length >= MAX_WEAK_POINTS) break;
    const allowed = new Set(left.filter((n) => !claimed.has(n)));
    const point = weakPointFrom(item, allowed, pagesInfo);
    if (!point) continue;
    point.covers.forEach((n) => claimed.add(n));
    points.push(point);
  }
  for (const item of Array.isArray(result.placed) ? result.placed : []) {
    const n = Math.round(Number(item && item.n));
    const target = points[Math.round(Number(item && item.weak_point)) - 1];
    if (!target || !left.includes(n) || claimed.has(n)) continue;
    target.covers.push(n);
    claimed.add(n);
  }
  return call.tokensUsed || 0;
}

/**
 * The topics of one weak point, written from the module's pages. Any topic that
 * comes back missing or too short is asked for again, once; a weak point that
 * still lacks one throws.
 */
async function writeWeakPointTopics(context, point) {
  const { missed, pagesInfo, level, gradeLevel } = context;
  const guide = LEVEL_LESSON_GUIDES[level] || LEVEL_LESSON_GUIDES.Beginner;
  const questions = point.covers.map((n) => missed[n - 1]).filter(Boolean);
  const all = Array.from({ length: TOPICS_PER_WEAK_POINT }, (_v, i) => i + 1);
  const topics = new Map();
  let tokensUsed = 0;

  const ask = async (numbers) => {
    const systemPrompt = `You write ADDED TOPICS for ONE learner's own copy of a learning module at a tutorial centre.
They teach ONE weak point: an idea of the module this learner got wrong on the Pre-Assessment.
The module's own pages stay exactly as they are. The topics are new pages, placed after page ${point.after_page}.

${guide}

Return a JSON object with one key, "topics": an array of exactly ${numbers.length} object${numbers.length === 1 ? '' : 's'} — topic number${numbers.length === 1 ? '' : 's'} ${numbers.join(', ')} — each with
- "n": the topic number
- "title": the topic's title, under 70 characters
- "text": the topic as plain text

The ${TOPICS_PER_WEAK_POINT} topics of this weak point build the idea up step by step, each one about a different part of it, following the planned titles.
Write each "text" like this:
- explain one part of the idea at a time, step by step, with the module's own words, facts and examples
- where it helps, a worked example taken from the module's content
- end with an empty line, then a line starting with "Try this: " and one short practice question, then a line starting with "Answer: " and its answer
- do not start "text" with the title or the topic number: the title is shown above it
- a line starting with "- " for each item of a list, and an empty line between paragraphs

Rules:
- Use ONLY facts present in the module pages. Never invent facts, names or numbers the module does not give.
- Teach the idea. Do not copy the missed questions word for word.
- Write in the same language as the module, to the learner ("you"), in words a ${gradeLevel || 'young'} learner understands.
- Each "text" between 80 and 200 words, never fewer than 80: two to four short paragraphs, then the practice question.
- No markdown: no bold, no italics, no tables, no code.
- Output strict JSON only. No commentary.`;

    const planned = all.map((n) => `${n}. ${point.topics[n - 1] || '(a fitting part of this idea, different from the others)'}`).join('\n');
    const written = [...topics.values()].map((topic) => `${topic.no}. ${topic.title}`).join('\n');
    const userPrompt = `${promptHeader(context)}

WEAK POINT: ${point.title}
What was got wrong: ${point.focus || '(see the questions below)'}

THE QUESTIONS THE LEARNER GOT WRONG ON IT
${missedQuestionsForPrompt(questions)}

PLANNED TOPICS
${planned}
${written ? `\nTOPICS ALREADY WRITTEN (do not repeat them)\n${written}\n` : ''}
WRITE TOPIC${numbers.length === 1 ? '' : 'S'} ${numbers.join(', ')}

MODULE PAGES
${pagesInfo.sourceText}`;

    const call = await callOpenAI(systemPrompt, userPrompt, {
      maxTokens: Math.min(4000, 600 + numbers.length * 550),
      temperature: 0.5
    });
    tokensUsed += call.tokensUsed || 0;
    const raw = Array.isArray(call.result && call.result.topics) ? call.result.topics : [];
    raw.forEach((item, index) => {
      let n = Math.round(Number(item && item.n));
      if (!numbers.includes(n) || topics.has(n)) n = numbers[index];
      if (!n || topics.has(n)) return;
      const title = oneLine(item && item.title, 120) || point.topics[n - 1] || `Topic ${n}`;
      const text = tidyTopicText(cleanLessonText(item && item.text).replace(/^## /gm, ''), title);
      if (text.length < MIN_TOPIC_CHARS) return;
      topics.set(n, { no: n, title, text });
    });
  };

  await ask(all);
  const missing = all.filter((n) => !topics.has(n));
  if (missing.length) await ask(missing);
  const stillMissing = all.filter((n) => !topics.has(n));
  if (stillMissing.length) {
    throw new Error(`Only ${all.length - stillMissing.length} of the ${all.length} topics on "${point.title}" could be written.`);
  }
  return { topics: all.map((n) => topics.get(n)), tokensUsed };
}

/**
 * The topics read again against the module: a statement the pages contradict or
 * do not support is corrected from them or taken out, and each practice answer
 * is checked. A correction that comes back unusable leaves the topic as written.
 */
async function reviewWeakPointTopics(context, point, topics) {
  const { pagesInfo } = context;
  const systemPrompt = `You check ADDED TOPICS that were written for a learner, against the learning module they were written from.

For every topic:
- compare each statement with the module pages. Correct any statement the pages contradict or do not support, using the
  pages, or take it out.
- check the practice question's answer (the line starting with "Answer: ") against the module, and correct it if it is wrong.
- keep everything else as it is: the same layout, the "Try this:" and "Answer: " lines, about the same length, the same language.

Return a JSON object with one key, "topics": an array with one object per topic, each with
- "n": the topic number
- "ok": true when nothing had to be corrected, false when something was
- "text": the topic's full text after your corrections (the same text when "ok" is true)
Output strict JSON only. No commentary, no markdown.`;

  const userPrompt = `${promptHeader(context)}

WEAK POINT: ${point.title}

TOPICS
${topics.map((topic) => `### Topic ${topic.no}: ${topic.title}\n${topic.text}`).join('\n\n')}

MODULE PAGES
${pagesInfo.sourceText}`;

  let call;
  try {
    call = await callOpenAI(systemPrompt, userPrompt, { maxTokens: 4000, temperature: 0 });
  } catch (error) {
    console.error('[aiService] the added topics could not be checked:', error.message);
    return { topics, corrected: 0, checked: false, tokensUsed: 0 };
  }
  const raw = Array.isArray(call.result && call.result.topics) ? call.result.topics : [];
  let corrected = 0;
  const checked = topics.map((topic, index) => {
    const numbered = raw.find((item) => Math.round(Number(item && item.n)) === topic.no);
    const unnumbered = raw.length === topics.length && raw[index] && !Number.isFinite(Number(raw[index].n)) ? raw[index] : null;
    const item = numbered || unnumbered;
    if (!item || item.ok === true) return topic;
    const text = tidyTopicText(cleanLessonText(item.text).replace(/^## /gm, ''), topic.title);
    if (text.length < MIN_TOPIC_CHARS || text.length < topic.text.length * 0.5 || text === topic.text) return topic;
    corrected += 1;
    return { ...topic, text };
  });
  return { topics: checked, corrected, checked: true, tokensUsed: call.tokensUsed || 0 };
}

/**
 * What is added to ONE learner's own copy of a module: their weak points in it,
 * one for each idea behind the Pre-Assessment questions they got wrong, and for
 * every weak point five topics that teach it, placed after the module page that
 * teaches that idea. The module's own pages are never rewritten.
 *
 * Every weak point is planned, written and then checked against the module's
 * pages. A weak point whose topics cannot be written is tried once more; one that
 * still fails is left out and named in `errors`. None at all throws.
 *
 * @param {object} options
 * @param {Array<{num: number, text: string}>} options.pages  the module's pages, in order
 * @param {number} [options.pageCount]   pages in the PDF, when their text could not be read
 * @param {string} [options.fallbackText] the handout's stored text, for a scanned PDF
 * @param {Array<{question_text: string, correct_text: string, explanation?: string}>} options.missed
 * @returns {Promise<{ weakPoints: Array<{ title: string, focus: string, after_page: number,
 *   questions: Array<{ q: string, a: string }>, topics: Array<{ no: number, title: string, text: string }> }>,
 *   errors: string[], corrected: number, tokensUsed: number }>}
 */
async function generateModuleAdditions(options = {}) {
  const {
    pages = [], pageCount = 0, fallbackText = '', missed = [],
    level, subject, gradeLevel, moduleTitle
  } = options;
  if (!missed.length) return { weakPoints: [], errors: [], corrected: 0, tokensUsed: 0 };
  if (!isOpenAIConfigured()) throw new Error('The AI service is not configured, so the added lessons cannot be written.');

  const context = {
    missed, level, subject, gradeLevel, moduleTitle,
    pagesInfo: modulePagesForPrompt({ pages, pageCount, fallbackText })
  };
  const plan = await planWeakPoints(context);
  let tokensUsed = plan.tokensUsed;
  let corrected = 0;
  const errors = [];
  const results = new Array(plan.points.length).fill(null);

  await runWithConcurrency(plan.points.map((point, index) => ({ point, index })), 2, async ({ point, index }) => {
    for (let attempt = 1; attempt <= 2 && !results[index]; attempt++) {
      try {
        const written = await writeWeakPointTopics(context, point);
        tokensUsed += written.tokensUsed;
        const reviewed = await reviewWeakPointTopics(context, point, written.topics);
        tokensUsed += reviewed.tokensUsed;
        corrected += reviewed.corrected;
        results[index] = {
          title: point.title,
          focus: point.focus,
          after_page: point.after_page,
          questions: point.covers.map((n) => missed[n - 1]).filter(Boolean).map((q) => ({
            q: oneLine(q.question_text, 500),
            a: oneLine(q.correct_text, 300)
          })),
          topics: reviewed.topics
        };
      } catch (error) {
        if (attempt === 2) errors.push(error.message);
      }
    }
  });

  const weakPoints = results.filter(Boolean);
  if (!weakPoints.length) throw new Error(errors[0] || 'The AI returned no added lesson that could be used.');
  return { weakPoints, errors, corrected, tokensUsed };
}

// Defined after module.exports above, so added here (a const is not hoisted).
Object.assign(module.exports, { MAX_WEAK_POINTS, TOPICS_PER_WEAK_POINT, tidyTopicText });
