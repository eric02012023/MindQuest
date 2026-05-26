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

function isOpenAIConfigured() {
  return AI_PROVIDER === 'openai' && OPENAI_API_KEY.length > 10;
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

Return a JSON object with a "questions" array. Each question object must have:
- "question_text": the question
- "question_type": one of "Multiple Choice", "True or False", or "Identification"
- "choice_a", "choice_b", "choice_c", "choice_d": choices (empty strings for non-MC questions)
- "correct_answer": for MC use "A","B","C","D"; for TF use "true"/"false"; for ID use the answer text
- "explanation": brief explanation of the correct answer
- "points": always 1

Mix question types: ~50% Multiple Choice, ~25% True or False, ~25% Identification.
Make questions appropriate for the student's education level.`;

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
