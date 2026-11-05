/**
 * File: lib/learningPaths.js
 * Purpose: Each student's own learning path in a subject: the modules of their
 *          grade made into THEIR modules, opened one after another as they pass.
 *
 * For a student who takes the Pre-Assessment after this shipped:
 *  1. Every module of their grade becomes their own — the office's handout pages
 *     kept whole, with pages added that teach what they got wrong on that
 *     module's Pre-Assessment questions (the PDF is put together by lib/modulePdf.js).
 *  2. Module 1 is open; the others are locked.
 *  3. When a module opens, an assessment is written for that student from it.
 *     Their tutor or the main admin checks it, may edit it, and opens it.
 *  4. The student sees only their score. Intermediate or better passes and opens
 *     the next module; below that the tutor opens a retake.
 *  5. After the last module a Post-Assessment is written from their own modules,
 *     checked and opened the same way.
 *
 * The writing (added pages, assessments) never runs inside a request: it is
 * queued and runs two at a time, like level modules (lib/levelModules.js).
 * A student who sat the Pre-Assessment before this keeps the way they had.
 */

const { query, withTransaction } = require('../config/db');
const { determineLevel } = require('../config/levelThresholds');
const { normalizeLevel } = require('./levelModules');

/** Questions on each module's assessment. */
const MODULE_ITEM_COUNT = 10;

/** Automatic tries at writing something before it waits for a person. */
const MAX_ATTEMPTS = 3;

/** A job still "generating" after this long is taken to have died with its process. */
const STALE_MINUTES = 15;

const JOB_CONCURRENCY = 2;

const NOW = 'DATEADD(hour, 8, GETUTCDATE())';
const stale = (column) => `(${column} = 'generating' AND updated_at < DATEADD(minute, -${STALE_MINUTES}, ${NOW}))`;

const ADDED_HEADING = 'ADDED LESSONS FOR THIS LEARNER';
const FOCUS_RULE = `At least half of the questions must test the ideas taught in the part headed "${ADDED_HEADING}".`;

/** LEARNING_PATHS=off turns new paths off; everyone then keeps the old way. */
function isEnabled() {
  return String(process.env.LEARNING_PATHS || 'on').trim().toLowerCase() !== 'off';
}

/** LEARNING_PATH_JOBS=off stops the background writing (test harnesses). */
function jobsEnabled() {
  return String(process.env.LEARNING_PATH_JOBS || 'on').trim().toLowerCase() !== 'off';
}

/** Intermediate or better passes a module. */
function passes(percentage) {
  return determineLevel(percentage) !== 'Beginner';
}

function parseAdditions(json) {
  try {
    const list = JSON.parse(json || '[]');
    return Array.isArray(list) ? list.filter((item) => item && String(item.text || '').trim()) : [];
  } catch (_error) {
    return [];
  }
}

function withAdditions(row) {
  return row ? { ...row, additions: parseAdditions(row.additions_json) } : row;
}

function byModuleOrder(a, b) {
  return (Number(a.order_number) || 0) - (Number(b.order_number) || 0) || Number(a.id) - Number(b.id);
}

function errorText(error, fallback) {
  return String((error && error.message) || fallback || 'Something went wrong.').slice(0, 480);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const PATH_SELECT = `SELECT lp.*, s.name AS subject_name,
        u.first_name, u.middle_name, u.last_name, u.user_id AS student_code, u.branch_id AS student_branch_id
   FROM learning_paths lp
   JOIN subjects s ON s.id = lp.subject_id
   JOIN users u ON u.id = lp.student_id`;

async function getPathById(id) {
  const rows = await query(`${PATH_SELECT} WHERE lp.id = ?`, [Number(id)]);
  return rows[0] || null;
}

/** The path a Pre-Assessment sitting started, or null. */
async function getPathForPre(preSubmissionId) {
  if (!preSubmissionId) return null;
  const rows = await query(`${PATH_SELECT} WHERE lp.pre_submission_id = ?`, [Number(preSubmissionId)]);
  return rows[0] || null;
}

/**
 * The path that counts for a student in a subject: the one their current
 * Pre-Assessment sitting started (hasCompletedPreAssessment), or null.
 */
async function getCurrentPath(studentId, subjectId, preSubmission) {
  if (preSubmission === undefined) {
    const { hasCompletedPreAssessment } = require('./data');
    preSubmission = await hasCompletedPreAssessment(studentId, subjectId);
  }
  if (!preSubmission) return null;
  const path = await getPathForPre(preSubmission.id);
  return path && Number(path.student_id) === Number(studentId) ? path : null;
}

/** Every path of a student, newest first, one per subject. */
async function getPathsForStudent(studentId) {
  const rows = await query(`${PATH_SELECT} WHERE lp.student_id = ? ORDER BY lp.id DESC`, [Number(studentId)]);
  const seen = new Set();
  return rows.filter((row) => {
    if (seen.has(Number(row.subject_id))) return false;
    seen.add(Number(row.subject_id));
    return true;
  });
}

async function getPathModules(pathId) {
  const rows = await query(
    `SELECT lpm.*, m.title AS module_title, m.order_number, m.is_archived AS module_archived,
            m.subject_id AS module_subject_id
       FROM learning_path_modules lpm
       LEFT JOIN modules m ON m.id = lpm.module_id
      WHERE lpm.path_id = ?
      ORDER BY lpm.position ASC, lpm.id ASC`,
    [Number(pathId)]
  );
  return rows.map(withAdditions);
}

async function getPathModuleById(id) {
  const rows = await query(
    `SELECT lpm.*, m.title AS module_title, m.order_number, m.is_archived AS module_archived,
            lp.student_id, lp.subject_id, lp.grade_level, lp.placement_level, lp.pre_submission_id,
            lp.post_status, s.name AS subject_name,
            u.first_name, u.last_name, u.user_id AS student_code, u.branch_id AS student_branch_id
       FROM learning_path_modules lpm
       JOIN learning_paths lp ON lp.id = lpm.path_id
       JOIN subjects s ON s.id = lp.subject_id
       JOIN users u ON u.id = lp.student_id
       LEFT JOIN modules m ON m.id = lpm.module_id
      WHERE lpm.id = ?`,
    [Number(id)]
  );
  return withAdditions(rows[0] || null);
}

/**
 * Who a personal assessment belongs to: { kind: 'module', pathModule } or
 * { kind: 'post', path }, or null for every shared assessment.
 */
async function getPersonalOwner(assessmentId) {
  const id = Number(assessmentId);
  if (!id) return null;
  const moduleRows = await query('SELECT TOP 1 id FROM learning_path_modules WHERE assessment_id = ?', [id]);
  if (moduleRows.length) return { kind: 'module', pathModule: await getPathModuleById(moduleRows[0].id) };
  const pathRows = await query('SELECT TOP 1 id FROM learning_paths WHERE post_assessment_id = ?', [id]);
  if (pathRows.length) return { kind: 'post', path: await getPathById(pathRows[0].id) };
  return null;
}

/** Every take of an assessment by a student, first take first. */
async function getAttempts(assessmentId, studentId) {
  return query(
    `SELECT id, assessment_id, student_id, attempt_number, score, total_points, percentage, level,
            started_at, submitted_at, time_spent_seconds
       FROM tutor_assessment_attempts
      WHERE assessment_id = ? AND student_id = ?
      ORDER BY attempt_number ASC`,
    [Number(assessmentId), Number(studentId)]
  );
}

/** One take with its answers, shaped like a submission for the breakdown page. */
async function getAttemptDetail(attemptId) {
  const rows = await query(
    `SELECT att.*, ta.title, ta.subject_id, ta.assessment_kind, ta.for_student_id, s.name AS subject_name,
            u.first_name, u.middle_name, u.last_name, u.user_id AS student_code, u.branch_id AS student_branch_id
       FROM tutor_assessment_attempts att
       JOIN tutor_assessments ta ON ta.id = att.assessment_id
       JOIN subjects s ON s.id = ta.subject_id
       JOIN users u ON u.id = att.student_id
      WHERE att.id = ?`,
    [Number(attemptId)]
  );
  const attempt = rows[0];
  if (!attempt) return null;
  const answers = await query(
    `SELECT a.*, q.question_text, q.question_type, q.points, q.explanation, q.answer_rubric,
            q.source_module_id, q.source_handout_id,
            m.order_number AS source_order_number, m.title AS source_module_title,
            h.file_original_name AS source_handout_name
       FROM tutor_assessment_attempt_answers a
       JOIN tutor_assessment_questions q ON q.id = a.question_id
       LEFT JOIN modules m ON m.id = q.source_module_id
       LEFT JOIN module_handouts h ON h.id = q.source_handout_id
      WHERE a.attempt_id = ?
      ORDER BY a.id ASC`,
    [Number(attemptId)]
  );
  const mcIds = answers.filter((a) => a.question_type === 'multiple_choice').map((a) => Number(a.question_id));
  if (mcIds.length) {
    const options = await query(
      `SELECT * FROM tutor_question_options WHERE question_id IN (${mcIds.map(() => '?').join(',')}) ORDER BY option_label ASC`,
      mcIds
    );
    const byQuestion = new Map();
    for (const option of options) {
      const key = Number(option.question_id);
      if (!byQuestion.has(key)) byQuestion.set(key, []);
      byQuestion.get(key).push(option);
    }
    for (const answer of answers) answer.options = byQuestion.get(Number(answer.question_id)) || [];
  }
  return { ...attempt, answers };
}

/**
 * Where a student's own module assessment stands, from the student's side:
 *   locked          the module before it is not passed yet
 *   preparing       the system is still writing it
 *   waiting_tutor   written, waiting for their tutor to check and open it
 *   can_take        open for them now
 *   waiting_retake  taken without passing; the tutor opens the next take
 *   passed          done
 */
function takeState(row) {
  if (!row) return 'locked';
  if (row.status === 'passed') return 'passed';
  if (row.status !== 'open') return 'locked';
  if (!row.assessment_id) return 'preparing';
  if (row.assessment_status === 'draft') return 'waiting_tutor';
  if (row.assessment_status === 'open') {
    return Number(row.takes_used) < Number(row.takes_opened) ? 'can_take' : 'waiting_retake';
  }
  if (row.assessment_status === 'passed') return 'passed';
  return 'preparing';
}

/** A path with its live modules, for the pages. */
async function loadPathView(path) {
  if (!path) return null;
  const modules = (await getPathModules(path.id)).filter((row) => row.status !== 'removed');
  const passed = modules.filter((row) => row.status === 'passed').length;
  const assessmentIds = modules.map((row) => Number(row.assessment_id)).filter(Boolean);
  const attemptRows = assessmentIds.length
    ? await query(
      `SELECT id, assessment_id, attempt_number, percentage, level, submitted_at
         FROM tutor_assessment_attempts
        WHERE student_id = ? AND assessment_id IN (${assessmentIds.map(() => '?').join(',')})
        ORDER BY attempt_number ASC`,
      [Number(path.student_id), ...assessmentIds]
    )
    : [];
  for (const row of modules) {
    row.take_state = takeState(row);
    row.attempts = attemptRows.filter((a) => Number(a.assessment_id) === Number(row.assessment_id));
    row.added_count = row.additions.length;
  }
  let post = null;
  if (path.post_assessment_id) {
    const [postRow] = await query(
      `SELECT ta.id, ta.title, ta.item_count, ta.is_published,
              (SELECT TOP 1 s.id FROM tutor_assessment_submissions s
                WHERE s.assessment_id = ta.id AND s.student_id = ? ORDER BY s.submitted_at DESC) AS submission_id,
              (SELECT TOP 1 s.percentage FROM tutor_assessment_submissions s
                WHERE s.assessment_id = ta.id AND s.student_id = ? ORDER BY s.submitted_at DESC) AS percentage
         FROM tutor_assessments ta WHERE ta.id = ?`,
      [Number(path.student_id), Number(path.student_id), Number(path.post_assessment_id)]
    );
    post = postRow || null;
  }
  return {
    path,
    modules,
    passed,
    total: modules.length,
    allPassed: modules.length > 0 && passed === modules.length,
    current: modules.find((row) => row.status === 'open') || null,
    post
  };
}

/**
 * The path of each of these students in a subject, as counts for the tutor's
 * class list: student id -> { id, total, passed, toCheck, retakeDue, postStatus }.
 */
async function getPathSummaries(subjectId, studentIds = []) {
  const ids = [...new Set(studentIds.map(Number).filter(Boolean))];
  const summaries = new Map();
  if (!ids.length) return summaries;
  const rows = await query(
    `SELECT lp.id, lp.student_id, lp.post_status, lp.post_assessment_id,
            (SELECT COUNT(*) FROM learning_path_modules m WHERE m.path_id = lp.id AND m.status <> 'removed') AS total,
            (SELECT COUNT(*) FROM learning_path_modules m WHERE m.path_id = lp.id AND m.status = 'passed') AS passed,
            (SELECT COUNT(*) FROM learning_path_modules m WHERE m.path_id = lp.id AND m.assessment_status = 'draft') AS to_check,
            (SELECT COUNT(*) FROM learning_path_modules m
              WHERE m.path_id = lp.id AND m.status = 'open' AND m.assessment_status = 'open'
                AND m.takes_used >= m.takes_opened) AS retake_due
       FROM learning_paths lp
      WHERE lp.subject_id = ? AND lp.student_id IN (${ids.map(() => '?').join(',')})
      ORDER BY lp.id DESC`,
    [Number(subjectId), ...ids]
  );
  for (const row of rows) {
    const key = Number(row.student_id);
    if (summaries.has(key)) continue;
    summaries.set(key, {
      id: Number(row.id),
      total: Number(row.total || 0),
      passed: Number(row.passed || 0),
      toCheck: Number(row.to_check || 0) + (row.post_status === 'draft' ? 1 : 0),
      retakeDue: Number(row.retake_due || 0),
      postStatus: row.post_status
    });
  }
  return summaries;
}

/** How many modules of the student's current path are not passed yet. */
async function modulesLeft(pathId) {
  if (!pathId) return 0;
  const rows = await query(
    `SELECT COUNT(*) AS n FROM learning_path_modules WHERE path_id = ? AND status IN ('locked', 'open')`,
    [Number(pathId)]
  );
  return Number(rows[0] ? rows[0].n : 0);
}

// ---------------------------------------------------------------------------
// The Post-Assessment of a student WITHOUT a path: opened per student
// ---------------------------------------------------------------------------

async function isPostOpened(studentId, subjectId) {
  const rows = await query(
    'SELECT TOP 1 id FROM post_openings WHERE student_id = ? AND subject_id = ?',
    [Number(studentId), Number(subjectId)]
  );
  return rows.length > 0;
}

/** Student ids whose Post-Assessment in this subject has been opened. */
async function getPostOpenings(subjectId) {
  const rows = await query('SELECT student_id FROM post_openings WHERE subject_id = ?', [Number(subjectId)]);
  return new Set(rows.map((row) => Number(row.student_id)));
}

async function openPostForStudent(studentId, subjectId, actorId) {
  try {
    await query(
      'INSERT INTO post_openings (student_id, subject_id, opened_by) VALUES (?, ?, ?)',
      [Number(studentId), Number(subjectId), Number(actorId) || null]
    );
  } catch (error) {
    if (!/duplicate key|unique/i.test(String(error.message))) throw error;
    return { already: true };
  }
  await notify(studentId, {
    type: 'post_assessment_open',
    title: 'Your Post-Assessment is open',
    message: 'Your tutor opened your Post-Assessment. You can take it now.',
    linkUrl: `/student/subjects/${Number(subjectId)}`,
    refType: 'subject',
    refId: Number(subjectId)
  });
  return { opened: true };
}

// ---------------------------------------------------------------------------
// Making a path
// ---------------------------------------------------------------------------

/**
 * Start a student's path right after their Pre-Assessment: one row per module
 * of their grade, in order, Module 1 open. The added pages are written in the
 * background. Returns the path, or null when paths are turned off.
 */
async function createPathAfterPre(input = {}) {
  const { studentId, subjectId, preSubmission, gradeLevel = null, modules = [] } = input;
  if (!isEnabled() || !preSubmission || !preSubmission.id) return null;

  const existing = await getPathForPre(preSubmission.id);
  if (existing) return existing;

  const ordered = [...modules].sort(byModuleOrder);
  const placement = normalizeLevel(preSubmission.level) || 'Beginner';
  try {
    await withTransaction(async (connection) => {
      const [created] = await connection.query(
        `INSERT INTO learning_paths (student_id, subject_id, grade_level, pre_submission_id, pre_assessment_id, placement_level)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [Number(studentId), Number(subjectId), gradeLevel, Number(preSubmission.id),
          Number(preSubmission.assessment_id) || null, placement]
      );
      for (let i = 0; i < ordered.length; i++) {
        await connection.query(
          `INSERT INTO learning_path_modules (path_id, module_id, position, status, unlocked_at)
           VALUES (?, ?, ?, ?, ${i === 0 ? NOW : 'NULL'})`,
          [created.insertId, Number(ordered[i].id), i + 1, i === 0 ? 'open' : 'locked']
        );
      }
    });
  } catch (error) {
    // Two submits at once: uq_learning_paths_pre kept one path, and it is the answer.
    if (!/duplicate key|unique/i.test(String(error.message))) throw error;
  }
  const path = await getPathForPre(preSubmission.id);
  if (path) kickPath(path.id).catch((error) => console.error('[learningPaths] could not queue the path:', error.message));
  return path;
}

/**
 * Keep a path in step with the office's modules: a module removed since leaves
 * the path (the next one opens if it was the open one), and a module added to
 * the student's grade since goes at the end, while the Post is not written yet.
 *
 * @param {Array|null} visibleModules  the student's modules now (getStudentSubjectModules)
 */
async function syncPath(path, visibleModules = null) {
  if (!path) return false;
  const rows = await getPathModules(path.id);
  let changed = false;
  for (const row of rows) {
    const gone = row.module_title == null || row.module_archived === true || Number(row.module_archived) === 1;
    if (row.status !== 'removed' && gone) {
      await query(`UPDATE learning_path_modules SET status = 'removed', updated_at = ${NOW} WHERE id = ?`, [row.id]);
      changed = true;
    }
  }
  if (Array.isArray(visibleModules) && path.post_status === 'waiting') {
    const inPath = new Set(rows.map((row) => Number(row.module_id)));
    let position = rows.reduce((max, row) => Math.max(max, Number(row.position) || 0), 0);
    for (const mod of [...visibleModules].sort(byModuleOrder)) {
      if (inPath.has(Number(mod.id))) continue;
      position += 1;
      try {
        // No Pre-Assessment questions came from it, so it has nothing to add.
        await query(
          `INSERT INTO learning_path_modules (path_id, module_id, position, status, additions_status, additions_json, pre_total, pre_correct)
           VALUES (?, ?, ?, 'locked', 'none', '[]', 0, 0)`,
          [Number(path.id), Number(mod.id), position]
        );
        changed = true;
      } catch (error) {
        if (!/duplicate key|unique/i.test(String(error.message))) throw error;
      }
    }
  }
  if (changed) {
    const opened = await openNextIfNoneOpen(path.id);
    if (!opened) await markPostDueIfDone(path.id);
  }
  return changed;
}

/** Nothing open but something locked: the first locked module opens. */
async function openNextIfNoneOpen(pathId) {
  const rows = await query(
    `UPDATE learning_path_modules
        SET status = 'open', unlocked_at = ${NOW}, updated_at = ${NOW}
     OUTPUT inserted.id
      WHERE id = (SELECT TOP 1 id FROM learning_path_modules
                   WHERE path_id = ? AND status = 'locked' ORDER BY position ASC, id ASC)
        AND NOT EXISTS (SELECT 1 FROM learning_path_modules WHERE path_id = ? AND status = 'open')`,
    [Number(pathId), Number(pathId)]
  );
  return rows[0] ? Number(rows[0].id) : null;
}

/** Every live module passed: the Post-Assessment is due. */
async function markPostDueIfDone(pathId) {
  await query(
    `UPDATE learning_paths SET post_status = 'pending', updated_at = ${NOW}
      WHERE id = ? AND post_status = 'waiting'
        AND EXISTS (SELECT 1 FROM learning_path_modules WHERE path_id = ? AND status = 'passed')
        AND NOT EXISTS (SELECT 1 FROM learning_path_modules WHERE path_id = ? AND status IN ('locked', 'open'))`,
    [Number(pathId), Number(pathId), Number(pathId)]
  );
}

// ---------------------------------------------------------------------------
// What is due, and the background queue
// ---------------------------------------------------------------------------

function additionsSettled(row) {
  return ['ready', 'none'].includes(row.additions_status)
    || (row.additions_status === 'failed' && Number(row.additions_attempts) >= MAX_ATTEMPTS);
}

function wantsAdditions(row) {
  if (row.status === 'removed') return false;
  if (row.additions_status === 'pending' || row.additions_status === 'generating') return true;
  return row.additions_status === 'failed' && Number(row.additions_attempts) < MAX_ATTEMPTS;
}

function wantsAssessment(row) {
  if (row.status !== 'open' || row.assessment_id || !additionsSettled(row)) return false;
  if (['waiting', 'pending', 'generating'].includes(row.assessment_status)) return true;
  return row.assessment_status === 'failed' && Number(row.assessment_attempts) < MAX_ATTEMPTS;
}

function wantsPost(path) {
  if (!path || path.post_assessment_id) return false;
  if (['pending', 'generating'].includes(path.post_status)) return true;
  return path.post_status === 'failed' && Number(path.post_attempts) < MAX_ATTEMPTS;
}

/** Queue whatever a path is waiting on. Cheap enough to call on a page load. */
async function kickPath(pathId) {
  if (!jobsEnabled()) return;
  const path = await getPathById(pathId);
  if (!path) return;
  const modules = await getPathModules(path.id);
  for (const row of modules) {
    if (wantsAdditions(row)) queueJob('additions', row.id);
    else if (wantsAssessment(row)) queueJob('assessment', row.id);
  }
  if (wantsPost(path)) queueJob('post', path.id);
}

const queued = new Map();
const waiting = [];
let running = 0;

function queueJob(kind, id, options = {}) {
  const key = `${kind}:${Number(id)}`;
  if (!jobsEnabled() || !Number(id) || !JOBS[kind]) return Promise.resolve({ skipped: true });
  if (queued.has(key)) return queued.get(key);
  const promise = new Promise((resolve) => {
    waiting.push({ key, kind, id: Number(id), options, resolve });
  });
  queued.set(key, promise);
  pump();
  return promise;
}

function pump() {
  while (running < JOB_CONCURRENCY && waiting.length) {
    const job = waiting.shift();
    running++;
    Promise.resolve()
      .then(() => JOBS[job.kind](job.id, job.options))
      .catch((error) => {
        console.error(`[learningPaths] ${job.kind} ${job.id} failed:`, error.message);
        return { ok: false, error: error.message };
      })
      .then((result) => job.resolve(result))
      .finally(() => {
        running--;
        queued.delete(job.key);
        pump();
      });
  }
}

function logGeneration(entry) {
  const { logAiGeneration } = require('./data');
  return logAiGeneration(entry)
    .catch((error) => console.error('[learningPaths] could not write ai_generation_logs:', error.message));
}

function aiModelFields() {
  const { getAiStatus } = require('../services/aiService');
  const ai = getAiStatus();
  return { ai_provider: ai.provider, ai_model: ai.model };
}

// ---------------------------------------------------------------------------
// Writing: the added pages, a module's assessment, the Post-Assessment
// ---------------------------------------------------------------------------

/** The handouts of a module, with where their files are kept. */
async function moduleHandoutFiles(moduleId) {
  return query(
    `SELECT h.id AS handout_id, h.file_path, h.file_original_name, h.extracted_text,
            m.id AS module_id, m.order_number, m.title AS module_title
       FROM module_handouts h
       JOIN modules m ON m.id = h.module_id
      WHERE h.module_id = ? AND h.is_archived = 0
      ORDER BY h.id ASC`,
    [Number(moduleId)]
  );
}

/**
 * The Pre-Assessment questions of one module, as this student answered them:
 * { total, wrong: [{ question_text, correct_text, explanation, source_handout_id }] }.
 */
async function preResultsForModule(preSubmissionId, moduleId) {
  const rows = await query(
    `SELECT q.id, q.question_text, q.question_type, q.correct_answer, q.explanation,
            q.source_handout_id, a.is_correct
       FROM tutor_student_answers a
       JOIN tutor_assessment_questions q ON q.id = a.question_id
      WHERE a.submission_id = ? AND q.source_module_id = ?
      ORDER BY a.id ASC`,
    [Number(preSubmissionId), Number(moduleId)]
  );
  const wrong = rows.filter((row) => !(row.is_correct === true || Number(row.is_correct) === 1));
  const mcIds = wrong.filter((row) => row.question_type === 'multiple_choice').map((row) => Number(row.id));
  const options = mcIds.length
    ? await query(
      `SELECT question_id, option_label, option_text FROM tutor_question_options
        WHERE question_id IN (${mcIds.map(() => '?').join(',')})`,
      mcIds
    )
    : [];
  return {
    total: rows.length,
    wrong: wrong.map((row) => {
      let correctText = String(row.correct_answer || '');
      if (row.question_type === 'multiple_choice') {
        const hit = options.find((o) => Number(o.question_id) === Number(row.id)
          && String(o.option_label).toUpperCase() === correctText.toUpperCase());
        if (hit) correctText = hit.option_text;
      } else if (row.question_type === 'true_false') {
        correctText = /^t/i.test(correctText) ? 'True' : 'False';
      }
      return {
        question_text: row.question_text,
        correct_text: correctText,
        explanation: row.explanation || '',
        source_handout_id: row.source_handout_id
      };
    })
  };
}

/** A handout's file and its pages, or nothing when it cannot be read. */
async function readHandoutFile(handout) {
  const { getFile } = require('./storage');
  const { readPageTexts, countPages } = require('./modulePdf');
  let file = null;
  try {
    file = await getFile(handout.file_path);
  } catch (error) {
    console.error('[learningPaths] could not fetch handout', handout.handout_id, error.message);
  }
  const buffer = file && file.buffer ? file.buffer : null;
  const pages = buffer ? await readPageTexts(buffer) : [];
  const pageCount = pages.length || (buffer ? await countPages(buffer) : 0);
  return { buffer, pages, pageCount };
}

/**
 * The text an assessment of this module is written from, per handout: all of
 * the handout's own text, then the lessons added for this student.
 */
async function assessmentSources(row) {
  const handouts = await moduleHandoutFiles(row.module_id);
  const sources = [];
  for (const handout of handouts) {
    const { pages } = await readHandoutFile(handout);
    const own = pages.length
      ? pages.map((page) => page.text).filter(Boolean).join('\n\n')
      : String(handout.extracted_text || '');
    const added = (row.additions || []).filter((a) => Number(a.handout_id) === Number(handout.handout_id)
      || (!a.handout_id && handout === handouts[0]));
    let text = own.trim().slice(0, 20000);
    if (added.length) {
      text += `\n\n${ADDED_HEADING}\n`
        + added.map((a) => `### ${a.title}\n${String(a.text || '').trim()}`).join('\n\n');
    }
    if (text.trim().length > 50) {
      sources.push({
        handout_id: Number(handout.handout_id),
        module_id: Number(handout.module_id),
        order_number: handout.order_number,
        module_title: handout.module_title,
        file_original_name: handout.file_original_name,
        extracted_text: text
      });
    }
  }
  return sources;
}

/** Save a generated assessment for one student, unopened, plus `after` in the same transaction. */
async function insertPersonalAssessment(data, after) {
  return withTransaction(async (connection) => {
    const [created] = await connection.query(
      `INSERT INTO tutor_assessments
         (subject_id, module_id, tutor_id, title, instructions, purpose, assessment_kind,
          question_type, item_count, is_published, grade_level, for_student_id)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        Number(data.subject_id), data.module_id ? Number(data.module_id) : null,
        String(data.title).slice(0, 200), data.instructions || null, data.purpose, data.assessment_kind,
        data.question_type, data.questions.length, data.grade_level || null, Number(data.for_student_id)
      ]
    );
    const assessmentId = created.insertId;
    await insertQuestions(connection, assessmentId, data.questions);
    if (after) await after(connection, assessmentId);
    return assessmentId;
  });
}

async function insertQuestions(connection, assessmentId, questions) {
  for (const q of questions) {
    const [saved] = await connection.query(
      `INSERT INTO tutor_assessment_questions
         (assessment_id, question_text, question_type, points, correct_answer,
          explanation, answer_rubric, source_module_id, source_handout_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        assessmentId, q.question_text, q.question_type, Number(q.points || 1), q.correct_answer,
        q.explanation || null, q.answer_rubric || null,
        Number(q.source_module_id) || null, Number(q.source_handout_id) || null
      ]
    );
    for (const choice of q.choices || []) {
      await connection.query(
        'INSERT INTO tutor_question_options (question_id, option_label, option_text) VALUES (?, ?, ?)',
        [saved.insertId, choice.label, choice.text]
      );
    }
  }
}

/** Job: the pages added to one module for one student. */
async function writeAdditions(pathModuleId, options = {}) {
  const claimed = await query(
    `UPDATE learning_path_modules
        SET additions_status = 'generating', additions_attempts = additions_attempts + 1,
            additions_error = NULL, updated_at = ${NOW}
     OUTPUT inserted.id
      WHERE id = ? AND status <> 'removed'
        AND (additions_status = 'pending'
             OR (additions_status = 'failed' AND (additions_attempts < ${MAX_ATTEMPTS} OR ? = 1))
             OR ${stale('additions_status')})`,
    [Number(pathModuleId), options.force ? 1 : 0]
  );
  if (!claimed.length) return { skipped: true };

  const row = await getPathModuleById(pathModuleId);
  let outcome;
  try {
    const results = await preResultsForModule(row.pre_submission_id, row.module_id);
    if (!results.wrong.length) {
      await query(
        `UPDATE learning_path_modules
            SET additions_status = 'none', additions_json = '[]', pre_total = ?, pre_correct = ?, updated_at = ${NOW}
          WHERE id = ?`,
        [results.total, results.total, Number(pathModuleId)]
      );
      outcome = { ok: true, added: 0 };
    } else {
      const handouts = await moduleHandoutFiles(row.module_id);
      if (!handouts.length) throw new Error('This module has no handout to add lessons to.');
      const byHandout = new Map(handouts.map((h) => [Number(h.handout_id), []]));
      for (const question of results.wrong) {
        const key = byHandout.has(Number(question.source_handout_id))
          ? Number(question.source_handout_id)
          : Number(handouts[0].handout_id);
        byHandout.get(key).push(question);
      }

      const { generateModuleAdditions } = require('../services/aiService');
      const additions = [];
      const errors = [];
      let tokens = 0;
      for (const handout of handouts) {
        const missed = byHandout.get(Number(handout.handout_id)) || [];
        if (!missed.length) continue;
        try {
          const { pages, pageCount } = await readHandoutFile(handout);
          const written = await generateModuleAdditions({
            pages,
            pageCount,
            fallbackText: handout.extracted_text,
            missed,
            level: row.placement_level,
            subject: row.subject_name,
            gradeLevel: row.grade_level,
            moduleTitle: row.module_title
          });
          tokens += Number(written.tokensUsed || 0);
          for (const addition of written.additions) additions.push({ handout_id: Number(handout.handout_id), ...addition });
        } catch (error) {
          errors.push(error.message);
        }
      }
      if (!additions.length) throw new Error(errors[0] || 'The added lessons could not be written.');
      await query(
        `UPDATE learning_path_modules
            SET additions_status = 'ready', additions_json = ?, pre_total = ?, pre_correct = ?,
                additions_error = ?, updated_at = ${NOW}
          WHERE id = ?`,
        [
          JSON.stringify(additions), results.total, results.total - results.wrong.length,
          errors.length ? errorText({ message: errors[0] }) : null, Number(pathModuleId)
        ]
      );
      logGeneration({
        generation_type: 'learning_path_additions',
        student_id: row.student_id,
        subject_id: row.subject_id,
        input_summary: `path module ${row.id}: module ${row.module_id}, ${results.wrong.length} missed of ${results.total}, ${row.placement_level}`,
        output_summary: `${additions.length} added lesson(s)`,
        ...aiModelFields(),
        tokens_used: tokens,
        success: true
      });
      outcome = { ok: true, added: additions.length };
    }
  } catch (error) {
    await query(
      `UPDATE learning_path_modules SET additions_status = 'failed', additions_error = ?, updated_at = ${NOW} WHERE id = ?`,
      [errorText(error, 'The added lessons could not be written.'), Number(pathModuleId)]
    ).catch((saveError) => console.error('[learningPaths] could not record the failure:', saveError.message));
    logGeneration({
      generation_type: 'learning_path_additions',
      student_id: row && row.student_id,
      subject_id: row && row.subject_id,
      input_summary: `path module ${pathModuleId}`,
      success: false,
      error_message: errorText(error)
    });
    outcome = { ok: false, error: error.message };
  }

  // Whatever happened, this module's assessment may be due now: a student whose
  // added pages could not be written still gets an assessment of the module.
  const after = await getPathModuleById(pathModuleId);
  if (after && wantsAssessment(after)) queueJob('assessment', after.id);
  return outcome;
}

/** Job: one module's assessment, written for one student. */
async function writeModuleAssessment(pathModuleId, options = {}) {
  const claimed = await query(
    `UPDATE learning_path_modules
        SET assessment_status = 'generating', assessment_attempts = assessment_attempts + 1,
            assessment_error = NULL, updated_at = ${NOW}
     OUTPUT inserted.id
      WHERE id = ? AND status = 'open' AND assessment_id IS NULL
        AND (assessment_status IN ('waiting', 'pending')
             OR (assessment_status = 'failed' AND (assessment_attempts < ${MAX_ATTEMPTS} OR ? = 1))
             OR ${stale('assessment_status')})`,
    [Number(pathModuleId), options.force ? 1 : 0]
  );
  if (!claimed.length) return { skipped: true };

  const row = await getPathModuleById(pathModuleId);
  try {
    if (!additionsSettled(row)) {
      // Its added pages are still being written; that job queues this one.
      await query(
        `UPDATE learning_path_modules
            SET assessment_status = 'waiting', assessment_attempts = assessment_attempts - 1, updated_at = ${NOW}
          WHERE id = ?`,
        [Number(pathModuleId)]
      );
      return { skipped: true };
    }
    const sources = await assessmentSources(row);
    if (!sources.length) throw new Error('This module has no readable text to write an assessment from.');
    const { generateAssessmentFromHandouts, MODULE_QUESTION_TYPES } = require('../services/aiService');
    const generated = await generateAssessmentFromHandouts({
      handouts: sources,
      subject: row.subject_name,
      yearLevel: row.grade_level,
      itemCount: MODULE_ITEM_COUNT,
      questionType: 'mixed',
      allowedTypes: MODULE_QUESTION_TYPES,
      level: row.placement_level,
      focus: row.additions.length ? FOCUS_RULE : null
    });
    if (!generated.questions.length) throw new Error('The AI did not return any usable questions.');

    const number = row.order_number || row.position;
    const assessmentId = await insertPersonalAssessment({
      subject_id: row.subject_id,
      module_id: row.module_id,
      title: `Module ${number} Assessment: ${row.module_title || 'Module'}`,
      instructions: 'Answer every question. When you submit, you will see your score.',
      purpose: 'post',
      assessment_kind: 'tutor_assessment',
      question_type: 'mixed',
      grade_level: row.grade_level,
      for_student_id: row.student_id,
      questions: generated.questions
    }, async (connection, id) => {
      await connection.query(
        `UPDATE learning_path_modules SET assessment_id = ?, assessment_status = 'draft', updated_at = ${NOW} WHERE id = ?`,
        [id, Number(pathModuleId)]
      );
    });

    logGeneration({
      generation_type: 'learning_path_assessment',
      student_id: row.student_id,
      subject_id: row.subject_id,
      assessment_id: assessmentId,
      input_summary: `path module ${row.id}: module ${row.module_id}, ${row.placement_level}`,
      output_summary: `${generated.questions.length} question(s)`,
      ...aiModelFields(),
      tokens_used: generated.tokensUsed,
      success: true
    });
    await notifyTutorOrOffice(row, {
      type: 'path_assessment_ready',
      title: `Module ${number} assessment ready to check — ${studentName(row)}`,
      message: `The assessment written for ${studentName(row)} on Module ${number} (${row.module_title || 'module'}) is ready. Check it, edit it if needed, then open it for them.`,
      refType: 'learning_path_module',
      refId: row.id
    });
    return { ok: true, assessmentId };
  } catch (error) {
    await query(
      `UPDATE learning_path_modules SET assessment_status = 'failed', assessment_error = ?, updated_at = ${NOW} WHERE id = ?`,
      [errorText(error, 'The assessment could not be written.'), Number(pathModuleId)]
    ).catch((saveError) => console.error('[learningPaths] could not record the failure:', saveError.message));
    logGeneration({
      generation_type: 'learning_path_assessment',
      student_id: row && row.student_id,
      subject_id: row && row.subject_id,
      input_summary: `path module ${pathModuleId}`,
      success: false,
      error_message: errorText(error)
    });
    return { ok: false, error: error.message };
  }
}

/** How many Pre-Assessment questions each module had: module id -> count. */
async function preBlueprint(preSubmissionId) {
  const rows = await query(
    `SELECT q.source_module_id AS module_id, COUNT(*) AS n
       FROM tutor_student_answers a
       JOIN tutor_assessment_questions q ON q.id = a.question_id
      WHERE a.submission_id = ?
      GROUP BY q.source_module_id`,
    [Number(preSubmissionId)]
  );
  return new Map(rows.filter((row) => row.module_id).map((row) => [Number(row.module_id), Number(row.n)]));
}

/** Job: the Post-Assessment of one path, from the student's own modules. */
async function writePost(pathId, options = {}) {
  const claimed = await query(
    `UPDATE learning_paths
        SET post_status = 'generating', post_attempts = post_attempts + 1, post_error = NULL, updated_at = ${NOW}
     OUTPUT inserted.id
      WHERE id = ? AND post_assessment_id IS NULL
        AND (post_status = 'pending'
             OR (post_status = 'failed' AND (post_attempts < ${MAX_ATTEMPTS} OR ? = 1))
             OR ${stale('post_status')})`,
    [Number(pathId), options.force ? 1 : 0]
  );
  if (!claimed.length) return { skipped: true };

  const path = await getPathById(pathId);
  try {
    const modules = (await getPathModules(pathId)).filter((row) => row.status !== 'removed');
    if (!modules.length || modules.some((row) => row.status !== 'passed')) {
      await query(
        `UPDATE learning_paths SET post_status = 'waiting', post_attempts = post_attempts - 1, updated_at = ${NOW} WHERE id = ?`,
        [Number(pathId)]
      );
      return { skipped: true };
    }

    // The same number of questions on each module as the Pre-Assessment had,
    // so before and after weigh the modules the same.
    const { PRE_ASSESSMENT_ITEM_COUNT } = require('../config/assessmentDefaults');
    const blueprint = await preBlueprint(path.pre_submission_id);
    let plan = modules
      .map((row) => ({ row, count: blueprint.get(Number(row.module_id)) || 0 }))
      .filter((item) => item.count > 0);
    if (!plan.length) {
      const base = Math.floor(PRE_ASSESSMENT_ITEM_COUNT / modules.length);
      plan = modules.map((row, i) => ({ row, count: base + (i < PRE_ASSESSMENT_ITEM_COUNT % modules.length ? 1 : 0) }))
        .filter((item) => item.count > 0);
    }
    const wanted = plan.reduce((sum, item) => sum + item.count, 0);

    const { generateAssessmentFromHandouts, PRE_POST_QUESTION_TYPES } = require('../services/aiService');
    const questions = [];
    const errors = [];
    let tokens = 0;
    for (const item of plan) {
      try {
        const sources = await assessmentSources({ ...item.row });
        if (!sources.length) continue;
        const generated = await generateAssessmentFromHandouts({
          handouts: sources,
          subject: path.subject_name,
          yearLevel: path.grade_level,
          itemCount: item.count,
          questionType: 'multiple_choice',
          allowedTypes: PRE_POST_QUESTION_TYPES
        });
        tokens += Number(generated.tokensUsed || 0);
        questions.push(...generated.questions);
      } catch (error) {
        errors.push(error.message);
      }
    }
    if (questions.length < Math.ceil(wanted / 2)) {
      throw new Error(errors[0] || 'The AI did not return enough usable questions for the Post-Assessment.');
    }

    const assessmentId = await insertPersonalAssessment({
      subject_id: path.subject_id,
      module_id: null,
      title: `Post-Assessment — ${path.subject_name}`,
      instructions: 'These questions come from your own modules. Answer them so you and your tutor can see how much you have improved.',
      purpose: 'post',
      assessment_kind: 'post_assessment',
      question_type: 'multiple_choice',
      grade_level: path.grade_level,
      for_student_id: path.student_id,
      questions
    }, async (connection, id) => {
      await connection.query(
        `UPDATE learning_paths SET post_assessment_id = ?, post_status = 'draft', updated_at = ${NOW} WHERE id = ?`,
        [id, Number(pathId)]
      );
    });

    logGeneration({
      generation_type: 'learning_path_post',
      student_id: path.student_id,
      subject_id: path.subject_id,
      assessment_id: assessmentId,
      input_summary: `path ${path.id}: ${plan.length} module(s), ${wanted} item(s) wanted`,
      output_summary: `${questions.length} question(s)`,
      ...aiModelFields(),
      tokens_used: tokens,
      success: true
    });
    await notifyTutorOrOffice({ ...path, path_id: path.id }, {
      type: 'path_post_ready',
      title: `Post-Assessment ready to check — ${studentName(path)}`,
      message: `${studentName(path)} passed every module. Their Post-Assessment is written: check it, edit it if needed, then open it for them.`,
      refType: 'learning_path',
      refId: path.id
    });
    return { ok: true, assessmentId };
  } catch (error) {
    await query(
      `UPDATE learning_paths SET post_status = 'failed', post_error = ?, updated_at = ${NOW} WHERE id = ?`,
      [errorText(error, 'The Post-Assessment could not be written.'), Number(pathId)]
    ).catch((saveError) => console.error('[learningPaths] could not record the failure:', saveError.message));
    logGeneration({
      generation_type: 'learning_path_post',
      student_id: path && path.student_id,
      subject_id: path && path.subject_id,
      input_summary: `path ${pathId}`,
      success: false,
      error_message: errorText(error)
    });
    return { ok: false, error: error.message };
  }
}

const JOBS = {
  additions: writeAdditions,
  assessment: writeModuleAssessment,
  post: writePost
};

/**
 * Try a failed piece again now, past the automatic limit (tutor / main admin).
 * `what` is 'additions' or 'assessment' for a module, 'post' for a path.
 */
async function retry(what, id) {
  if (what === 'additions') {
    await query(
      `UPDATE learning_path_modules SET additions_status = 'pending', additions_attempts = 0, updated_at = ${NOW}
        WHERE id = ? AND additions_status = 'failed'`,
      [Number(id)]
    );
    return queueJob('additions', id);
  }
  if (what === 'assessment') {
    await query(
      `UPDATE learning_path_modules SET assessment_status = 'pending', assessment_attempts = 0, updated_at = ${NOW}
        WHERE id = ? AND assessment_status = 'failed' AND assessment_id IS NULL`,
      [Number(id)]
    );
    return queueJob('assessment', id);
  }
  if (what === 'post') {
    await query(
      `UPDATE learning_paths SET post_status = 'pending', post_attempts = 0, updated_at = ${NOW}
        WHERE id = ? AND post_status = 'failed' AND post_assessment_id IS NULL`,
      [Number(id)]
    );
    return queueJob('post', id);
  }
  return { skipped: true };
}

// ---------------------------------------------------------------------------
// Opening (tutor / main admin)
// ---------------------------------------------------------------------------

/**
 * Open a module's assessment for its student — the first take once it is
 * checked, or the next take after one that did not pass.
 */
async function openModuleAssessment(pathModuleId, actorId) {
  const row = await getPathModuleById(pathModuleId);
  if (!row || row.status !== 'open' || !row.assessment_id) {
    throw new Error('This assessment is not ready to open yet.');
  }
  const number = row.order_number || row.position;
  if (row.assessment_status === 'draft') {
    const moved = await withTransaction(async (connection) => {
      const [rows] = await connection.query(
        `UPDATE learning_path_modules
            SET assessment_status = 'open', takes_opened = 1, opened_by = ?, opened_at = ${NOW}, updated_at = ${NOW}
         OUTPUT inserted.id
          WHERE id = ? AND assessment_status = 'draft'`,
        [Number(actorId) || null, Number(pathModuleId)]
      );
      if (rows.length) {
        await connection.query(`UPDATE tutor_assessments SET is_published = 1, updated_at = ${NOW} WHERE id = ?`, [row.assessment_id]);
      }
      return rows.length > 0;
    });
    if (!moved) throw new Error('This assessment was opened already.');
    await notify(row.student_id, {
      type: 'path_assessment_open',
      title: `Your Module ${number} assessment is open`,
      message: `Your tutor opened your Module ${number} assessment. You can take it now.`,
      linkUrl: `/student/path-modules/${row.id}`,
      refType: 'learning_path_module',
      refId: row.id
    });
    return { opened: 'first' };
  }
  if (row.assessment_status === 'open' && Number(row.takes_used) >= Number(row.takes_opened)) {
    const rows = await query(
      `UPDATE learning_path_modules
          SET takes_opened = takes_opened + 1, opened_by = ?, opened_at = ${NOW}, updated_at = ${NOW}
       OUTPUT inserted.takes_opened
        WHERE id = ? AND status = 'open' AND assessment_status = 'open' AND takes_used >= takes_opened`,
      [Number(actorId) || null, Number(pathModuleId)]
    );
    if (!rows.length) throw new Error('A take is open for this student already.');
    await notify(row.student_id, {
      type: 'path_assessment_open',
      title: `Your Module ${number} assessment is open again`,
      message: `Your tutor opened another take of your Module ${number} assessment.`,
      linkUrl: `/student/path-modules/${row.id}`,
      refType: 'learning_path_module',
      refId: row.id
    });
    return { opened: 'retake', take: Number(rows[0].takes_opened) };
  }
  if (row.assessment_status === 'open') throw new Error('The student can already take this assessment.');
  throw new Error('This assessment is not ready to open yet.');
}

/** Open a path's Post-Assessment for its student, once it is checked. */
async function openPathPost(pathId, actorId) {
  const path = await getPathById(pathId);
  if (!path || path.post_status !== 'draft' || !path.post_assessment_id) {
    throw new Error('The Post-Assessment is not ready to open yet.');
  }
  const moved = await withTransaction(async (connection) => {
    const [rows] = await connection.query(
      `UPDATE learning_paths
          SET post_status = 'open', post_opened_by = ?, post_opened_at = ${NOW}, updated_at = ${NOW}
       OUTPUT inserted.id
        WHERE id = ? AND post_status = 'draft'`,
      [Number(actorId) || null, Number(pathId)]
    );
    if (rows.length) {
      await connection.query(`UPDATE tutor_assessments SET is_published = 1, updated_at = ${NOW} WHERE id = ?`, [path.post_assessment_id]);
    }
    return rows.length > 0;
  });
  if (!moved) throw new Error('The Post-Assessment was opened already.');
  await notify(path.student_id, {
    type: 'post_assessment_open',
    title: 'Your Post-Assessment is open',
    message: `Your tutor opened your ${path.subject_name} Post-Assessment. You can take it now.`,
    linkUrl: `/student/subjects/${path.subject_id}`,
    refType: 'learning_path',
    refId: path.id
  });
  return { opened: true };
}

/** After the student submits their path's Post-Assessment. */
async function markPathPostTaken(pathId) {
  await query(
    `UPDATE learning_paths SET post_status = 'taken', updated_at = ${NOW} WHERE id = ? AND post_status = 'open'`,
    [Number(pathId)]
  );
}

/**
 * Main admin only: count a module as passed without the assessment — for a
 * broken case, such as an answer key found wrong after the student took it.
 */
async function markModulePassed(pathModuleId, actorId) {
  const row = await getPathModuleById(pathModuleId);
  if (!row || row.status !== 'open') throw new Error('Only the module the student is on can be marked as passed.');
  await withTransaction(async (connection) => {
    await connection.query(
      `UPDATE learning_path_modules
          SET status = 'passed', assessment_status = CASE WHEN assessment_id IS NULL THEN assessment_status ELSE 'passed' END,
              passed_at = ${NOW}, passed_by = ?, updated_at = ${NOW}
        WHERE id = ? AND status = 'open'`,
      [Number(actorId) || null, Number(pathModuleId)]
    );
    await unlockNext(connection, row.path_id);
  });
  kickPath(row.path_id).catch((error) => console.error('[learningPaths] could not queue the path:', error.message));
  return { ok: true };
}

/** Open the next locked module, or — when none is left — make the Post due. */
async function unlockNext(connection, pathId) {
  const [next] = await connection.query(
    `UPDATE learning_path_modules
        SET status = 'open', unlocked_at = ${NOW}, updated_at = ${NOW}
     OUTPUT inserted.id
      WHERE id = (SELECT TOP 1 id FROM learning_path_modules
                   WHERE path_id = ? AND status = 'locked' ORDER BY position ASC, id ASC)`,
    [Number(pathId)]
  );
  if (next.length) return Number(next[0].id);
  await connection.query(
    `UPDATE learning_paths SET post_status = 'pending', updated_at = ${NOW}
      WHERE id = ? AND post_status = 'waiting'
        AND NOT EXISTS (SELECT 1 FROM learning_path_modules WHERE path_id = ? AND status IN ('locked', 'open'))`,
    [Number(pathId), Number(pathId)]
  );
  return null;
}

// ---------------------------------------------------------------------------
// Taking a module's assessment (student)
// ---------------------------------------------------------------------------

/** A small seeded shuffle, so a reload shows a take in the same order. */
function seededOrder(items, seed) {
  let state = (Number(seed) || 1) >>> 0;
  const random = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const list = [...items];
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/**
 * The questions of a take as the student sees them. The first take is in the
 * order the tutor checked; every retake is shuffled — questions and choices —
 * and each choice shows the letter of its new place while its answer stays
 * the original one, so grading is unchanged.
 */
function questionsForTake(questions, assessmentId, takeNumber) {
  if (Number(takeNumber) <= 1) return questions;
  const seed = Number(assessmentId) * 7919 + Number(takeNumber);
  return seededOrder(questions, seed).map((question, index) => {
    if (question.question_type !== 'multiple_choice') return question;
    const options = seededOrder(question.options || [], seed + index + 1)
      .map((option, place) => ({ ...option, display_label: String.fromCharCode(65 + place) }));
    return { ...question, options };
  });
}

/**
 * Grade and record one take. The submission row stays ONE per student — the
 * latest take — so reports count a student once; every take is kept in
 * tutor_assessment_attempts for the tutor and the admin.
 */
async function submitModuleAttempt(input = {}) {
  const { pathModuleId, studentId, answers = [], startedAt = null } = input;
  const data = require('./data');
  const row = await getPathModuleById(pathModuleId);
  if (!row || Number(row.student_id) !== Number(studentId)) throw new Error('Assessment not found.');
  if (takeState(row) !== 'can_take') throw new Error('This assessment is not open for you right now.');
  const assessment = await data.getAssessmentWithQuestions(row.assessment_id);
  if (!assessment || !assessment.questions.length) throw new Error('This assessment has no questions yet.');

  const submitted = new Map(answers.map((a) => [Number(a.question_id), a.student_answer]));
  const graded = assessment.questions.map((question) => {
    const answer = submitted.get(Number(question.id)) ?? '';
    const points = Number(question.points || 1);
    const objective = data.gradeObjectiveAnswer(question, answer) || { isCorrect: false };
    return {
      question,
      student_answer: String(answer ?? '').trim(),
      is_correct: !!objective.isCorrect,
      points_earned: objective.isCorrect ? points : 0
    };
  });
  const totalPoints = assessment.questions.reduce((sum, q) => sum + Number(q.points || 1), 0);
  const score = graded.reduce((sum, g) => sum + g.points_earned, 0);
  const percentage = totalPoints ? Number(((score / totalPoints) * 100).toFixed(2)) : 0;
  const level = determineLevel(percentage);
  const passed = passes(percentage);
  const timeSpent = startedAt ? Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000)) : null;
  const started = startedAt && !Number.isNaN(new Date(startedAt).getTime()) ? new Date(startedAt) : null;

  const outcome = await withTransaction(async (connection) => {
    const [taken] = await connection.query(
      `UPDATE learning_path_modules
          SET takes_used = takes_used + 1, last_percentage = ?, updated_at = ${NOW}
       OUTPUT inserted.takes_used
        WHERE id = ? AND status = 'open' AND assessment_status = 'open' AND takes_used < takes_opened`,
      [percentage, Number(pathModuleId)]
    );
    if (!taken.length) throw new Error('This take was submitted already.');
    const attemptNumber = Number(taken[0].takes_used);

    const [existing] = await connection.query(
      'SELECT TOP 1 id FROM tutor_assessment_submissions WHERE assessment_id = ? AND student_id = ?',
      [row.assessment_id, Number(studentId)]
    );
    let submissionId;
    if (existing.length) {
      submissionId = Number(existing[0].id);
      await connection.query(
        `UPDATE tutor_assessment_submissions
            SET score = ?, total_points = ?, percentage = ?, level = ?, started_at = ?, time_spent_seconds = ?,
                submitted_at = ${NOW}
          WHERE id = ?`,
        [score, totalPoints, percentage, level, started, timeSpent, submissionId]
      );
      await connection.query('DELETE FROM tutor_student_answers WHERE submission_id = ?', [submissionId]);
    } else {
      const [inserted] = await connection.query(
        `INSERT INTO tutor_assessment_submissions
           (assessment_id, student_id, score, total_points, percentage, level, started_at, time_spent_seconds)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.assessment_id, Number(studentId), score, totalPoints, percentage, level, started, timeSpent]
      );
      submissionId = Number(inserted.insertId);
    }
    for (const g of graded) {
      await connection.query(
        `INSERT INTO tutor_student_answers
           (submission_id, question_id, student_answer, correct_answer, is_correct, points_earned, ai_feedback)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        [submissionId, g.question.id, g.student_answer, String(g.question.correct_answer || '').slice(0, 500),
          g.is_correct ? 1 : 0, g.points_earned]
      );
    }

    const [attempt] = await connection.query(
      `INSERT INTO tutor_assessment_attempts
         (assessment_id, student_id, attempt_number, score, total_points, percentage, level, started_at, time_spent_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.assessment_id, Number(studentId), attemptNumber, score, totalPoints, percentage, level, started, timeSpent]
    );
    for (const g of graded) {
      await connection.query(
        `INSERT INTO tutor_assessment_attempt_answers
           (attempt_id, question_id, student_answer, correct_answer, is_correct, points_earned)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [attempt.insertId, g.question.id, g.student_answer, String(g.question.correct_answer || '').slice(0, 500),
          g.is_correct ? 1 : 0, g.points_earned]
      );
    }

    let nextId = null;
    if (passed) {
      await connection.query(
        `UPDATE learning_path_modules
            SET status = 'passed', assessment_status = 'passed', passed_at = ${NOW}, updated_at = ${NOW}
          WHERE id = ?`,
        [Number(pathModuleId)]
      );
      nextId = await unlockNext(connection, row.path_id);
    }
    return { submissionId, attemptNumber, nextId };
  });

  // The classification on record follows the latest measurement, as it does
  // for every other graded submission (gradeAndSubmitAssessment).
  await data.setStudentSubjectLevel({
    student_id: Number(studentId),
    subject_id: row.subject_id,
    level,
    pre_assessment_id: row.assessment_id,
    score: Math.round(score),
    total_points: totalPoints,
    percentage
  }).catch((error) => console.error('[learningPaths] could not save the subject level:', error.message));

  kickPath(row.path_id).catch((error) => console.error('[learningPaths] could not queue the path:', error.message));

  const number = row.order_number || row.position;
  const pct = `${Number(percentage).toFixed(1)}%`;
  await notifyTutorOrOffice(row, passed
    ? {
      type: 'path_assessment_passed',
      title: `${studentName(row)} passed Module ${number} (${pct})`,
      message: outcome.nextId
        ? `${studentName(row)} scored ${pct} on take ${outcome.attemptNumber}. Their next module is open, and its assessment is being written.`
        : `${studentName(row)} scored ${pct} on take ${outcome.attemptNumber}. That was their last module: their Post-Assessment is being written.`,
      refType: 'learning_path_module',
      refId: row.id
    }
    : {
      type: 'path_assessment_retake',
      title: `${studentName(row)} needs another take of Module ${number} (${pct})`,
      message: `${studentName(row)} scored ${pct} on take ${outcome.attemptNumber}. Intermediate (51%) is needed to pass. Open another take when they are ready.`,
      refType: 'learning_path_module',
      refId: row.id,
      severity: 'warning'
    });
  if (outcome.nextId) {
    await notify(row.student_id, {
      type: 'path_module_open',
      title: 'Your next module is open',
      message: `You passed Module ${number}. Your next module is open.`,
      linkUrl: `/student/subjects/${row.subject_id}`,
      refType: 'learning_path_module',
      refId: outcome.nextId
    });
  }

  return {
    ...outcome,
    score,
    totalPoints,
    percentage,
    level,
    passed
  };
}

// ---------------------------------------------------------------------------
// Editing a written assessment before it is opened (tutor / main admin)
// ---------------------------------------------------------------------------

/** Can this personal assessment still be edited? { ok, reason, owner } */
async function editableState(assessmentId) {
  const owner = await getPersonalOwner(assessmentId);
  if (!owner) return { ok: false, reason: 'Only an assessment written for one student can be edited here.' };
  const draft = owner.kind === 'module'
    ? owner.pathModule && owner.pathModule.assessment_status === 'draft'
    : owner.path && owner.path.post_status === 'draft';
  if (!draft) return { ok: false, owner, reason: 'It was opened for the student already, so it can no longer be edited.' };
  const [{ n } = { n: 0 }] = await query(
    'SELECT COUNT(*) AS n FROM tutor_assessment_submissions WHERE assessment_id = ?',
    [Number(assessmentId)]
  );
  if (Number(n) > 0) return { ok: false, owner, reason: 'It has been answered already, so it can no longer be edited.' };
  return { ok: true, owner };
}

/**
 * Check edited questions: the text, a type that is allowed, two to five
 * distinct choices with the key among them, or True / False.
 */
function cleanEditedQuestions(questions, allowedTypes) {
  if (!Array.isArray(questions) || !questions.length) throw new Error('Keep at least one question.');
  if (questions.length > 60) throw new Error('An assessment can have at most 60 questions.');
  return questions.map((raw, index) => {
    const n = index + 1;
    const text = String((raw && raw.question_text) || '').replace(/\s+/g, ' ').trim();
    if (text.length < 5) throw new Error(`Question ${n} needs its text.`);
    const type = String((raw && raw.question_type) || '');
    if (!allowedTypes.includes(type)) {
      throw new Error(`Question ${n}: ${allowedTypes.length === 1 ? 'only Multiple Choice' : 'only Multiple Choice or True or False'} is allowed here.`);
    }
    const base = {
      question_text: text.slice(0, 2000),
      question_type: type,
      points: 1,
      explanation: String((raw && raw.explanation) || '').trim().slice(0, 1000) || null,
      answer_rubric: null,
      source_module_id: Number(raw && raw.source_module_id) || null,
      source_handout_id: Number(raw && raw.source_handout_id) || null,
      choices: [],
      correct_answer: ''
    };
    if (type === 'true_false') {
      const key = String((raw && raw.correct_answer) || '').trim().toLowerCase();
      if (!['true', 'false'].includes(key)) throw new Error(`Question ${n} needs True or False as its answer.`);
      base.correct_answer = key;
      return base;
    }
    const choices = (Array.isArray(raw && raw.choices) ? raw.choices : [])
      .map((choice) => String(typeof choice === 'object' && choice ? choice.text : choice || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (choices.length < 2) throw new Error(`Question ${n} needs at least two choices.`);
    if (choices.length > 5) throw new Error(`Question ${n} can have at most five choices.`);
    const seen = new Set(choices.map((choice) => choice.toLowerCase()));
    if (seen.size !== choices.length) throw new Error(`Question ${n} has two choices that say the same thing.`);
    base.choices = choices.map((choiceText, i) => ({ label: String.fromCharCode(65 + i), text: choiceText.slice(0, 500) }));
    const key = String((raw && raw.correct_answer) || '').trim().toUpperCase();
    if (!base.choices.some((choice) => choice.label === key)) throw new Error(`Question ${n} needs one of its choices as the answer.`);
    base.correct_answer = key;
    return base;
  });
}

/** Replace the questions of a personal assessment that has not been opened yet. */
async function replaceDraftQuestions(assessmentId, questions, actorId) {
  const state = await editableState(assessmentId);
  if (!state.ok) throw new Error(state.reason);
  const allowed = state.owner.kind === 'post' ? ['multiple_choice'] : ['multiple_choice', 'true_false'];
  const clean = cleanEditedQuestions(questions, allowed);
  await withTransaction(async (connection) => {
    await connection.query(
      `DELETE FROM tutor_question_options
        WHERE question_id IN (SELECT id FROM tutor_assessment_questions WHERE assessment_id = ?)`,
      [Number(assessmentId)]
    );
    await connection.query('DELETE FROM tutor_assessment_questions WHERE assessment_id = ?', [Number(assessmentId)]);
    await insertQuestions(connection, Number(assessmentId), clean);
    await connection.query(
      `UPDATE tutor_assessments SET item_count = ?, updated_at = ${NOW} WHERE id = ?`,
      [clean.length, Number(assessmentId)]
    );
    await connection.query(
      'INSERT INTO tutor_assessment_edits (assessment_id, edited_by, summary) VALUES (?, ?, ?)',
      [Number(assessmentId), Number(actorId) || null, `${clean.length} question(s) saved`]
    );
  });
  return { count: clean.length };
}

async function getEdits(assessmentId) {
  return query(
    `SELECT e.*, u.first_name, u.last_name, u.role
       FROM tutor_assessment_edits e
       LEFT JOIN users u ON u.id = e.edited_by
      WHERE e.assessment_id = ?
      ORDER BY e.edited_at DESC, e.id DESC`,
    [Number(assessmentId)]
  );
}

// ---------------------------------------------------------------------------
// The student's copy of a module, as a PDF
// ---------------------------------------------------------------------------

const pdfCache = new Map();
const PDF_CACHE_SIZE = 20;
const PDF_CACHE_MS = 10 * 60 * 1000;

/**
 * The student's module: every page of its handouts, with their added pages
 * after the page each belongs to. Kept for ten minutes, so opening it again
 * does not download the handouts again.
 */
async function buildModulePdf(row) {
  const handouts = await moduleHandoutFiles(row.module_id);
  const key = [
    row.id, row.additions_status, row.updated_at instanceof Date ? row.updated_at.getTime() : String(row.updated_at || ''),
    handouts.map((h) => h.handout_id).join('.')
  ].join('|');
  const cached = pdfCache.get(key);
  if (cached && Date.now() - cached.at < PDF_CACHE_MS) return cached.result;

  const { getFile } = require('./storage');
  const { composeModulePdf } = require('./modulePdf');
  const parts = [];
  for (const handout of handouts) {
    let buffer = null;
    try {
      const file = await getFile(handout.file_path);
      buffer = file && file.buffer ? file.buffer : null;
    } catch (error) {
      console.error('[learningPaths] could not fetch handout', handout.handout_id, error.message);
    }
    const additions = (row.additions || []).filter((a) => Number(a.handout_id) === Number(handout.handout_id)
      || (!a.handout_id && handout === handouts[0]));
    parts.push({ name: handout.file_original_name || 'Handout', buffer, additions });
  }
  const number = row.order_number || row.position;
  const result = await composeModulePdf({
    moduleTitle: `Module ${number}: ${row.module_title || 'Module'}`,
    studentName: studentName(row),
    parts
  });
  pdfCache.set(key, { at: Date.now(), result });
  while (pdfCache.size > PDF_CACHE_SIZE) pdfCache.delete(pdfCache.keys().next().value);
  return result;
}

function pdfFileName(row) {
  const number = row.order_number || row.position;
  const title = String(row.module_title || 'Module').replace(/[^A-Za-z0-9 _-]+/g, '').trim().slice(0, 60) || 'Module';
  return `Module ${number} - ${title}.pdf`;
}

// ---------------------------------------------------------------------------
// What the tutor's and the admin's pages show
// ---------------------------------------------------------------------------

/** Right and wrong per module and handout, as the breakdown page shows topics. */
function weakAreasFromAnswers(answers = []) {
  const groups = new Map();
  for (const answer of answers) {
    const key = `${answer.source_module_id || ''}|${answer.source_handout_id || ''}`;
    if (!groups.has(key)) {
      groups.set(key, {
        module_id: answer.source_module_id || null,
        handout_id: answer.source_handout_id || null,
        order_number: answer.source_order_number || null,
        module_title: answer.source_module_title || 'Unattributed',
        handout_name: answer.source_handout_name || null,
        total: 0,
        correct: 0
      });
    }
    const group = groups.get(key);
    group.total += 1;
    if (answer.is_correct === true || Number(answer.is_correct) === 1) group.correct += 1;
  }
  return [...groups.values()].map((group) => ({
    ...group,
    wrong: group.total - group.correct,
    percentage: group.total ? Number(((group.correct / group.total) * 100).toFixed(1)) : 0,
    is_weak: group.total > 0 && group.correct / group.total < 0.6
  }));
}

/**
 * One entry per subject for the learning-path page: the path when the student
 * has one, otherwise where they stand on the old way (and its Post-Assessment).
 *
 * @param {Array<{ subject_id: number, subject_name: string }>} subjects
 */
async function managePageEntries(studentId, subjects = []) {
  const data = require('./data');
  const entries = [];
  for (const subject of subjects) {
    const subjectId = Number(subject.subject_id);
    const pre = await data.hasCompletedPreAssessment(studentId, subjectId);
    const path = pre ? await getCurrentPath(studentId, subjectId, pre) : null;
    if (path) {
      await syncPath(path, null);
      kickPath(path.id).catch((error) => console.error('[learningPaths] could not queue the path:', error.message));
      entries.push({
        subjectId,
        subjectName: subject.subject_name,
        view: await loadPathView(await getPathById(path.id)),
        completion: null
      });
    } else {
      entries.push({
        subjectId,
        subjectName: subject.subject_name,
        view: null,
        completion: await data.getStudentSubjectCompletion(studentId, subjectId)
      });
    }
  }
  return entries;
}

/** What the check / edit page of a personal assessment needs, or null. */
async function editPageData(assessmentId) {
  const data = require('./data');
  const owner = await getPersonalOwner(assessmentId);
  if (!owner) return null;
  const holder = owner.kind === 'module' ? owner.pathModule : owner.path;
  if (!holder) return null;
  const assessment = await data.getAssessmentWithQuestions(Number(assessmentId));
  if (!assessment) return null;
  const state = await editableState(assessmentId);
  return {
    owner,
    assessment,
    editable: state.ok,
    reason: state.ok ? '' : state.reason,
    allowedTypes: owner.kind === 'post' ? ['multiple_choice'] : ['multiple_choice', 'true_false'],
    edits: await getEdits(assessmentId),
    studentId: Number(holder.student_id),
    subjectId: Number(holder.subject_id),
    studentBranchId: holder.student_branch_id || null,
    studentLabel: studentName(holder)
  };
}

/** One take shaped for the breakdown page (student-assessment-breakdown.ejs), or null. */
async function attemptPageData(attemptId) {
  const detail = await getAttemptDetail(attemptId);
  if (!detail) return null;
  return {
    submission: {
      ...detail,
      id: detail.id,
      title: `${detail.title} — Take ${detail.attempt_number}`
    },
    weakAreas: weakAreasFromAnswers(detail.answers),
    studentId: Number(detail.student_id),
    subjectId: Number(detail.subject_id),
    studentBranchId: detail.student_branch_id || null
  };
}

/**
 * The questions an edit form posted, read from its JSON field. Throws a plain
 * message when the form did not come through as expected.
 */
function readPostedQuestions(body = {}) {
  try {
    const list = JSON.parse(String(body.questions_json || ''));
    if (!Array.isArray(list)) throw new Error('not a list');
    return list;
  } catch (_error) {
    throw new Error('The questions could not be read from the form. Please try again.');
  }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

function studentName(row) {
  return [row && row.first_name, row && row.last_name].filter(Boolean).join(' ') || 'The student';
}

async function notify(userId, input) {
  if (!userId) return null;
  try {
    const { createNotification } = require('./appNotifications');
    return await createNotification({ severity: 'info', ...input, userId: Number(userId) });
  } catch (error) {
    console.error('[learningPaths] could not notify', userId, error.message);
    return null;
  }
}

/**
 * Tell the student's tutor; a student with no tutor has their office told
 * instead, so someone can open their assessments.
 */
async function notifyTutorOrOffice(row, input) {
  try {
    const { findAssignedTutor } = require('./focusHandouts');
    const tutor = await findAssignedTutor(row.student_id, row.subject_id);
    const pathLink = `/students/${Number(row.student_id)}/path/${Number(row.subject_id)}`;
    if (tutor && tutor.tutor_id) {
      return await notify(tutor.tutor_id, { ...input, linkUrl: `/tutor${pathLink}` });
    }
    const { notifyAdminRoles } = require('./appNotifications');
    return await notifyAdminRoles({
      severity: 'info',
      ...input,
      branchId: row.student_branch_id || null,
      linkPath: `/assessment-monitoring/students/${Number(row.student_id)}`
    });
  } catch (error) {
    console.error('[learningPaths] could not notify the tutor:', error.message);
    return null;
  }
}

module.exports = {
  MODULE_ITEM_COUNT,
  MAX_ATTEMPTS,
  ADDED_HEADING,
  isEnabled,
  passes,
  takeState,
  parseAdditions,
  getPathById,
  getPathForPre,
  getCurrentPath,
  getPathsForStudent,
  getPathModules,
  getPathModuleById,
  getPersonalOwner,
  getAttempts,
  getAttemptDetail,
  loadPathView,
  getPathSummaries,
  modulesLeft,
  isPostOpened,
  getPostOpenings,
  openPostForStudent,
  createPathAfterPre,
  syncPath,
  kickPath,
  queueJob,
  retry,
  openModuleAssessment,
  openPathPost,
  markPathPostTaken,
  markModulePassed,
  questionsForTake,
  submitModuleAttempt,
  editableState,
  cleanEditedQuestions,
  replaceDraftQuestions,
  getEdits,
  buildModulePdf,
  pdfFileName,
  weakAreasFromAnswers,
  managePageEntries,
  editPageData,
  attemptPageData,
  readPostedQuestions,
  // for tests and test harnesses: run one job now, outside the queue
  runJobNow: (kind, id, options = {}) => JOBS[kind](id, options),
  additionsSettled,
  wantsAdditions,
  wantsAssessment,
  wantsPost,
  seededOrder,
  preResultsForModule
};
