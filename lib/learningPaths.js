/**
 * File: lib/learningPaths.js
 * Purpose: Each student's own learning path in a subject: the modules of their
 *          grade made into THEIR modules, opened one after another as they pass.
 *
 * For a student who takes the Pre-Assessment after this shipped:
 *  1. Every module of their grade becomes their own — the office's handout pages
 *     kept whole, with pages added for each of their WEAK POINTS in it: an idea
 *     behind the Pre-Assessment questions they got wrong there, taught in five
 *     topics, right after the page that teaches it (lib/modulePdf.js).
 *  2. Module 1 is open; the others are locked.
 *  3. When a module opens, an assessment is written for that student from it.
 *     Their tutor or the main admin checks it, may edit it, and opens it. The
 *     tutor can also write activities for that student alone in the module.
 *  4. The student sees only their score. Advance (81%) passes and opens the next
 *     module; below it the next take opens at once, its questions and choices
 *     in a new order, until they pass.
 *  5. After the last module the Post-Assessment is made from the very questions
 *     of their Pre-Assessment, in a new order. Their tutor checks it, may edit
 *     it, and opens it. Pre and Post are then compared, overall and per module.
 *
 * The writing (added pages, assessments) never runs inside a request: it is
 * queued and runs two at a time, like level modules (lib/levelModules.js).
 * A student who sat the Pre-Assessment before this keeps the way they had.
 */

const zlib = require('zlib');
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
const FOCUS_RULE = `At least half of the questions must test the weak points taught in the part headed "${ADDED_HEADING}", with at least one question on every weak point there.`;

/** Characters of the added lessons an assessment is written from, after the module's own text. */
const ADDED_SOURCE_CHARS = 24000;

/** What passes a module, as the pages say it. */
const PASS_LABEL = 'Advance (81%)';

/** LEARNING_PATHS=off turns new paths off; everyone then keeps the old way. */
function isEnabled() {
  return String(process.env.LEARNING_PATHS || 'on').trim().toLowerCase() !== 'off';
}

/** LEARNING_PATH_JOBS=off stops the background writing (test harnesses). */
function jobsEnabled() {
  return String(process.env.LEARNING_PATH_JOBS || 'on').trim().toLowerCase() !== 'off';
}

/** Advance (81% or better) passes a module. */
function passes(percentage) {
  return determineLevel(percentage) === 'Advance';
}

// ---------------------------------------------------------------------------
// What was added to a module: its weak points, five topics each
//
// Stored in learning_path_modules.additions_json as "gz:" + the gzip of
// { v: 2, weak_points: [...] } in base64 — about a third of the plain text, as
// the database is capped at 30 MB. Lessons added before weak points are a plain
// JSON list, read here as one weak point each with one topic.
// ---------------------------------------------------------------------------

const PACKED_PREFIX = 'gz:';

/** The weak points of a module, as stored. */
function packAdditions(weakPoints = []) {
  const json = JSON.stringify({ v: 2, weak_points: weakPoints });
  return PACKED_PREFIX + zlib.gzipSync(Buffer.from(json, 'utf8')).toString('base64');
}

function unpackAdditions(stored) {
  const text = String(stored || '').trim();
  if (!text) return null;
  try {
    if (text.startsWith(PACKED_PREFIX)) {
      return JSON.parse(zlib.gunzipSync(Buffer.from(text.slice(PACKED_PREFIX.length), 'base64')).toString('utf8'));
    }
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

/**
 * A module's added part, read both ways:
 *   weakPoints  [{ no, handout_id, after_page, title, focus, questions: [{ q, a }],
 *                  topics: [{ no, title, text }], legacy }]
 *   additions   every topic on its own (handout_id, after_page, title, text,
 *               weak_point_no, weak_point_title, topic_no)
 */
function readAdditions(stored) {
  const doc = unpackAdditions(stored);
  if (doc && !Array.isArray(doc) && Array.isArray(doc.weak_points)) {
    const weakPoints = doc.weak_points
      .map((point, index) => ({
        no: Number(point && point.no) || index + 1,
        handout_id: Number(point && point.handout_id) || null,
        after_page: Number(point && point.after_page) || 1,
        title: String((point && point.title) || '').trim() || `Weak point ${index + 1}`,
        focus: String((point && point.focus) || '').trim(),
        questions: (Array.isArray(point && point.questions) ? point.questions : [])
          .filter((q) => q && String(q.q || '').trim()),
        topics: (Array.isArray(point && point.topics) ? point.topics : [])
          .filter((topic) => topic && String(topic.text || '').trim())
          .map((topic, n) => ({
            no: Number(topic.no) || n + 1,
            title: String(topic.title || '').trim() || `Topic ${n + 1}`,
            text: String(topic.text)
          })),
        legacy: false
      }))
      .filter((point) => point.topics.length);
    const additions = weakPoints.flatMap((point) => point.topics.map((topic) => ({
      handout_id: point.handout_id,
      after_page: point.after_page,
      weak_point_no: point.no,
      weak_point_title: point.title,
      topic_no: topic.no,
      title: topic.title,
      text: topic.text
    })));
    return { weakPoints, additions };
  }
  const list = Array.isArray(doc) ? doc.filter((item) => item && String(item.text || '').trim()) : [];
  return {
    weakPoints: list.map((item, index) => ({
      no: index + 1,
      handout_id: Number(item.handout_id) || null,
      after_page: Number(item.after_page) || 1,
      title: String(item.title || '').trim() || 'Added lesson',
      focus: '',
      questions: [],
      topics: [{ no: 1, title: String(item.title || '').trim() || 'Added lesson', text: String(item.text) }],
      legacy: true
    })),
    additions: list
  };
}

/** Every topic added to a module, one after another (see readAdditions). */
function parseAdditions(stored) {
  return readAdditions(stored).additions;
}

function withAdditions(row) {
  if (!row) return row;
  const { weakPoints, additions } = readAdditions(row.additions_json);
  return { ...row, weakPoints, additions };
}

/** Does this weak point (or lesson) belong to that handout of the module? */
function belongsTo(item, handout, handouts) {
  return Number(item.handout_id) === Number(handout.handout_id) || (!item.handout_id && handout === handouts[0]);
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
 *   can_take        open for them now — after a take that did not pass, the
 *                   next take opens at once
 *   waiting_retake  taken without passing before retakes opened by themselves;
 *                   the tutor opens the next take
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
      `SELECT id, assessment_id, attempt_number, score, total_points, percentage, level, submitted_at
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
    row.weak_point_count = row.weakPoints.filter((point) => !point.legacy).length;
  }
  let post = null;
  if (path.post_assessment_id) {
    const [postRow] = await query(
      `SELECT ta.id, ta.title, ta.instructions, ta.item_count, ta.is_published,
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

/** The weak points added to one handout of a module, as text an assessment is written from. */
function addedLessonsText(weakPoints = []) {
  return weakPoints.map((point) => (point.legacy
    ? `### ${point.title}\n${String(point.topics[0].text || '').trim()}`
    : `### Weak point ${point.no}: ${point.title}\n`
      + point.topics.map((topic) => `#### ${topic.title}\n${String(topic.text || '').trim()}`).join('\n\n')
  )).join('\n\n').slice(0, ADDED_SOURCE_CHARS);
}

/**
 * The text an assessment of this module is written from, per handout: all of
 * the handout's own text, then what was added for this student — every weak
 * point with its topics.
 */
async function assessmentSources(row) {
  const handouts = await moduleHandoutFiles(row.module_id);
  const sources = [];
  for (const handout of handouts) {
    const { pages } = await readHandoutFile(handout);
    const own = pages.length
      ? pages.map((page) => page.text).filter(Boolean).join('\n\n')
      : String(handout.extracted_text || '');
    const added = (row.weakPoints || []).filter((point) => belongsTo(point, handout, handouts));
    let text = own.trim().slice(0, 20000);
    if (added.length) {
      text += `\n\n${ADDED_HEADING}\n${addedLessonsText(added)}`;
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

/**
 * Job: what is added to one module for one student — their weak points in it,
 * five topics each (services/aiService.js, generateModuleAdditions), from the
 * Pre-Assessment questions of that module they got wrong.
 */
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
      const weakPoints = [];
      const errors = [];
      let tokens = 0;
      let corrected = 0;
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
          corrected += Number(written.corrected || 0);
          errors.push(...(written.errors || []));
          for (const point of written.weakPoints) {
            weakPoints.push({ no: weakPoints.length + 1, handout_id: Number(handout.handout_id), ...point });
          }
        } catch (error) {
          errors.push(error.message);
        }
      }
      if (!weakPoints.length) throw new Error(errors[0] || 'The added lessons could not be written.');
      const topicCount = weakPoints.reduce((sum, point) => sum + point.topics.length, 0);
      await query(
        `UPDATE learning_path_modules
            SET additions_status = 'ready', additions_json = ?, pre_total = ?, pre_correct = ?,
                additions_error = ?, updated_at = ${NOW}
          WHERE id = ?`,
        [
          packAdditions(weakPoints), results.total, results.total - results.wrong.length,
          errors.length ? errorText({ message: `Not every weak point could be written: ${errors[0]}` }) : null,
          Number(pathModuleId)
        ]
      );
      logGeneration({
        generation_type: 'learning_path_additions',
        student_id: row.student_id,
        subject_id: row.subject_id,
        input_summary: `path module ${row.id}: module ${row.module_id}, ${results.wrong.length} missed of ${results.total}, ${row.placement_level}`,
        output_summary: `${weakPoints.length} weak point(s), ${topicCount} topic(s)`
          + (corrected ? `, ${corrected} corrected against the module` : ''),
        ...aiModelFields(),
        tokens_used: tokens,
        success: true
      });
      outcome = { ok: true, weakPoints: weakPoints.length, topics: topicCount };
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

    // assessment_id is not passed: ai_generation_logs.assessment_id points at the
    // retired `assessments` table, so a tutor_assessments id breaks its foreign key.
    logGeneration({
      generation_type: 'learning_path_assessment',
      student_id: row.student_id,
      subject_id: row.subject_id,
      input_summary: `path module ${row.id}: module ${row.module_id}, ${row.placement_level}`,
      output_summary: `tutor_assessment #${assessmentId}: ${generated.questions.length} question(s)`,
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

/**
 * The questions of the Pre-Assessment a student sat, with their choices: those
 * of the assessment itself, or — should it be gone — the ones their answers
 * point at.
 */
async function preAssessmentQuestions(path) {
  const data = require('./data');
  const pre = path.pre_assessment_id
    ? await data.getAssessmentWithQuestions(Number(path.pre_assessment_id), { includeArchived: true })
    : null;
  if (pre && pre.questions.length) return pre.questions;
  const questions = await query(
    `SELECT q.* FROM tutor_student_answers a
       JOIN tutor_assessment_questions q ON q.id = a.question_id
      WHERE a.submission_id = ?
      ORDER BY q.id ASC`,
    [Number(path.pre_submission_id)]
  );
  const ids = questions.map((q) => Number(q.id));
  const options = ids.length
    ? await query(
      `SELECT * FROM tutor_question_options WHERE question_id IN (${ids.map(() => '?').join(',')}) ORDER BY option_label ASC`,
      ids
    )
    : [];
  return questions.map((q) => ({ ...q, options: options.filter((o) => Number(o.question_id) === Number(q.id)) }));
}

/**
 * A copy of questions in a new order: the questions shuffled, and the choices
 * of each shuffled and lettered again A, B, C… with the answer key following its
 * choice. A question whose key is not among its choices keeps its choices as
 * they were, so its grading cannot change.
 */
function reshuffledCopy(questions, seed) {
  return seededOrder(questions, seed).map((q, index) => {
    const copy = {
      question_text: q.question_text,
      question_type: q.question_type,
      points: Number(q.points || 1),
      correct_answer: String(q.correct_answer || ''),
      explanation: q.explanation || null,
      answer_rubric: q.answer_rubric || null,
      source_module_id: Number(q.source_module_id) || null,
      source_handout_id: Number(q.source_handout_id) || null,
      choices: []
    };
    if (q.question_type !== 'multiple_choice') return copy;
    const original = [...(q.options || [])].sort((a, b) => String(a.option_label).localeCompare(String(b.option_label)));
    const key = String(q.correct_answer || '').trim().toUpperCase();
    const hasKey = original.some((o) => String(o.option_label).trim().toUpperCase() === key);
    const order = hasKey ? seededOrder(original, seed + index + 1) : original;
    copy.choices = order.map((o, place) => ({ label: String.fromCharCode(65 + place), text: o.option_text }));
    if (hasKey) {
      const at = order.findIndex((o) => String(o.option_label).trim().toUpperCase() === key);
      copy.correct_answer = String.fromCharCode(65 + at);
    }
    return copy;
  });
}

/**
 * Job: the Post-Assessment of one path — the very questions of the student's
 * Pre-Assessment, in a new order, so before and after are the same test. Saved
 * unopened: their tutor (or the main admin) checks it, may edit it, and opens it.
 */
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

    const source = await preAssessmentQuestions(path);
    if (!source.length) {
      throw new Error('The questions of the Pre-Assessment could not be found, so the Post-Assessment cannot be made from them.');
    }
    // A new order for every path; reading it back never needs the seed again.
    const questions = reshuffledCopy(source, Number(path.id) * 7919 + (Date.now() % 104729));

    const assessmentId = await insertPersonalAssessment({
      subject_id: path.subject_id,
      module_id: null,
      title: `Post-Assessment — ${path.subject_name}`,
      instructions: 'The same questions as your Pre-Assessment, in a new order. Answer them so you and your tutor can see how much you have improved.',
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
      input_summary: `path ${path.id}: the questions of Pre-Assessment #${path.pre_assessment_id || '?'} (submission ${path.pre_submission_id})`,
      output_summary: `tutor_assessment #${assessmentId}: ${questions.length} question(s), in a new order`,
      ai_provider: 'none',
      ai_model: 'copy of the Pre-Assessment',
      tokens_used: 0,
      success: true
    });
    await notifyTutorOrOffice({ ...path, path_id: path.id }, {
      type: 'path_post_ready',
      title: `Post-Assessment ready to check — ${studentName(path)}`,
      message: `${studentName(path)} passed every module. Their Post-Assessment — the questions of their Pre-Assessment, in a new order — is ready: check it, edit it if needed, then open it for them.`,
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
 *
 * Advance passes: the module is passed and the next one opens. Below it, the
 * next take opens at once — shown in a new order (questionsForTake) — and the
 * student can take it again until they pass.
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
    let nextTake = null;
    if (passed) {
      await connection.query(
        `UPDATE learning_path_modules
            SET status = 'passed', assessment_status = 'passed', passed_at = ${NOW}, updated_at = ${NOW}
          WHERE id = ?`,
        [Number(pathModuleId)]
      );
      nextId = await unlockNext(connection, row.path_id);
    } else {
      // Not passed: the next take is theirs at once, in a new order.
      nextTake = attemptNumber + 1;
      await connection.query(
        `UPDATE learning_path_modules SET takes_opened = ?, updated_at = ${NOW}
          WHERE id = ? AND status = 'open' AND takes_opened < ?`,
        [nextTake, Number(pathModuleId), nextTake]
      );
    }
    return { submissionId, attemptNumber, nextId, nextTake };
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
        : `${studentName(row)} scored ${pct} on take ${outcome.attemptNumber}. That was their last module: their Post-Assessment is being made from their Pre-Assessment.`,
      refType: 'learning_path_module',
      refId: row.id
    }
    : {
      type: 'path_assessment_retake',
      title: `${studentName(row)} did not pass Module ${number} yet (${pct})`,
      message: `${studentName(row)} scored ${pct} on take ${outcome.attemptNumber}. ${PASS_LABEL} is needed to pass. `
        + `Take ${outcome.nextTake} is open for them now, its questions in a new order.`,
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

/** A weak point as a section of the PDF: its heading, what to learn, its topics. */
function weakPointSection(point) {
  if (point.legacy) {
    return { after_page: point.after_page, heading: point.title, intro: '', topics: [{ title: '', text: point.topics[0].text }] };
  }
  const count = point.topics.length;
  return {
    after_page: point.after_page,
    heading: `Weak point ${point.no}: ${point.title}`,
    intro: point.focus ? `What to learn: ${point.focus}` : '',
    topics: point.topics.map((topic, index) => ({
      title: `Topic ${index + 1} of ${count}: ${topic.title}`,
      text: topic.text
    }))
  };
}

/**
 * The student's module: every page of its handouts, with what was added for
 * them — each weak point and its topics — after the page each belongs to.
 * Kept for ten minutes, so opening it again does not download the handouts again.
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
    const sections = (row.weakPoints || [])
      .filter((point) => belongsTo(point, handout, handouts))
      .map(weakPointSection);
    parts.push({ name: handout.file_original_name || 'Handout', buffer, sections });
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
// Resetting a student's Pre-Assessment (main admin)
// ---------------------------------------------------------------------------

const idList = (ids) => ids.map(() => '?').join(',');

/**
 * Let a student take a subject's Pre-Assessment again — so they start a new
 * learning path. Removed: their Pre-Assessment result in the subject, its focus
 * areas, their classification there, their learning path with the assessments
 * written for them and every take, and an opened Post-Assessment. Kept: the
 * activities they answered, and the level modules (shared by a level).
 *
 * Refused once the Post-Assessment is taken: the before-and-after it compares
 * would lose its "before".
 *
 * @returns {Promise<{ removedSubmissions: number, removedPaths: number, removedAssessments: number }>}
 */
async function resetPreAssessmentFor(studentId, subjectId) {
  const student = Number(studentId);
  const subject = Number(subjectId);
  const preRows = await query(
    `SELECT sub.id FROM tutor_assessment_submissions sub
       JOIN tutor_assessments ta ON ta.id = sub.assessment_id
      WHERE sub.student_id = ? AND ta.subject_id = ? AND ta.assessment_kind = 'pre_assessment'`,
    [student, subject]
  );
  if (!preRows.length) throw new Error('This student has no Pre-Assessment in this subject to reset.');
  const postRows = await query(
    `SELECT TOP 1 sub.id FROM tutor_assessment_submissions sub
       JOIN tutor_assessments ta ON ta.id = sub.assessment_id
      WHERE sub.student_id = ? AND ta.subject_id = ? AND ta.assessment_kind = 'post_assessment'`,
    [student, subject]
  );
  if (postRows.length) {
    throw new Error('The Post-Assessment has been taken, so the Pre-Assessment can no longer be reset: their before-and-after would be lost.');
  }

  const preIds = preRows.map((row) => Number(row.id));
  const pathRows = await query(
    `SELECT id, post_assessment_id FROM learning_paths WHERE student_id = ? AND pre_submission_id IN (${idList(preIds)})`,
    [student, ...preIds]
  );
  const pathIds = pathRows.map((row) => Number(row.id));
  const moduleRows = pathIds.length
    ? await query(
      `SELECT id, assessment_id FROM learning_path_modules WHERE path_id IN (${idList(pathIds)})`,
      pathIds
    )
    : [];
  // Only assessments written for THIS student: never a shared one.
  const candidates = [
    ...moduleRows.map((row) => Number(row.assessment_id)),
    ...pathRows.map((row) => Number(row.post_assessment_id))
  ].filter(Boolean);
  const personal = candidates.length
    ? (await query(
      `SELECT id FROM tutor_assessments WHERE id IN (${idList(candidates)}) AND for_student_id = ?`,
      [...candidates, student]
    )).map((row) => Number(row.id))
    : [];
  const focusRows = await query(
    `SELECT id FROM focus_handouts WHERE submission_id IN (${idList(preIds)})`,
    preIds
  );
  const focusIds = focusRows.map((row) => Number(row.id));
  const pathModuleIds = moduleRows.map((row) => Number(row.id));

  await withTransaction(async (connection) => {
    // The notices about what goes, so no link is left pointing at nothing.
    if (focusIds.length) {
      await connection.query(
        `DELETE FROM app_notifications WHERE ref_type = 'focus_handout' AND ref_id IN (${idList(focusIds)})`,
        focusIds
      );
    }
    if (pathModuleIds.length) {
      await connection.query(
        `DELETE FROM app_notifications WHERE ref_type = 'learning_path_module' AND ref_id IN (${idList(pathModuleIds)})`,
        pathModuleIds
      );
    }
    if (pathIds.length) {
      await connection.query(
        `DELETE FROM app_notifications WHERE ref_type = 'learning_path' AND ref_id IN (${idList(pathIds)})`,
        pathIds
      );
    }

    // The assessments written for them, with every take and answer.
    if (personal.length) {
      const list = idList(personal);
      await connection.query(
        `DELETE FROM tutor_assessment_attempt_answers
          WHERE attempt_id IN (SELECT id FROM tutor_assessment_attempts WHERE assessment_id IN (${list}))`,
        personal
      );
      await connection.query(`DELETE FROM tutor_assessment_attempts WHERE assessment_id IN (${list})`, personal);
      await connection.query(`DELETE FROM assessment_violations WHERE assessment_id IN (${list})`, personal);
      await connection.query(
        `DELETE FROM tutor_student_answers
          WHERE submission_id IN (SELECT id FROM tutor_assessment_submissions WHERE assessment_id IN (${list}))`,
        personal
      );
      await connection.query(`DELETE FROM tutor_assessment_submissions WHERE assessment_id IN (${list})`, personal);
      await connection.query(`DELETE FROM tutor_assessment_edits WHERE assessment_id IN (${list})`, personal);
    }
    // The path itself (its modules go with it).
    if (pathIds.length) {
      await connection.query(`DELETE FROM learning_paths WHERE id IN (${idList(pathIds)})`, pathIds);
    }
    if (personal.length) {
      const list = idList(personal);
      await connection.query(
        `DELETE FROM tutor_question_options
          WHERE question_id IN (SELECT id FROM tutor_assessment_questions WHERE assessment_id IN (${list}))`,
        personal
      );
      await connection.query(`DELETE FROM tutor_assessment_questions WHERE assessment_id IN (${list})`, personal);
      await connection.query(`DELETE FROM tutor_assessments WHERE id IN (${list}) AND for_student_id = ?`, [...personal, student]);
    }

    // The Pre-Assessment result, and what came of it.
    const list = idList(preIds);
    await connection.query(`DELETE FROM focus_handouts WHERE submission_id IN (${list})`, preIds);
    await connection.query(`DELETE FROM assessment_violations WHERE submission_id IN (${list})`, preIds);
    await connection.query(`DELETE FROM tutor_student_answers WHERE submission_id IN (${list})`, preIds);
    await connection.query(`DELETE FROM tutor_assessment_submissions WHERE id IN (${list})`, preIds);
    await connection.query('DELETE FROM student_subject_levels WHERE student_id = ? AND subject_id = ?', [student, subject]);
    await connection.query('DELETE FROM post_openings WHERE student_id = ? AND subject_id = ?', [student, subject]);
  });

  return { removedSubmissions: preIds.length, removedPaths: pathIds.length, removedAssessments: personal.length };
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
      const view = await loadPathView(await getPathById(path.id));
      entries.push({
        subjectId,
        subjectName: subject.subject_name,
        view,
        scores: await getPathScores(view),
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
// Activities a tutor writes for ONE student, inside one of their modules
//
// A tutor_assessments row with purpose 'activity', the module's module_id and
// for_student_id. Like every personal assessment it is left out of the shared
// lists (for_student_id IS NULL); unlike the module's assessment it is answered
// once and its answers are shown.
// ---------------------------------------------------------------------------

const ANSWER_APPLY = `OUTER APPLY (
         SELECT TOP 1 s.id, s.score, s.total_points, s.percentage, s.level, s.submitted_at
           FROM tutor_assessment_submissions s
          WHERE s.assessment_id = ta.id AND s.student_id = ?
          ORDER BY s.submitted_at DESC
       ) sub`;

/**
 * The activities written for this one student in one module, oldest first, each
 * with their answer once they have one.
 *
 * @param {object} [options]
 * @param {boolean} [options.publishedOnly]  only those the student can see
 */
async function getPersonalActivities(studentId, moduleId, options = {}) {
  return query(
    `SELECT ta.id, ta.title, ta.instructions, ta.item_count, ta.created_at, ta.is_published, ta.tutor_id,
            ta.subject_id, ta.module_id,
            u.first_name AS author_first_name, u.last_name AS author_last_name,
            (SELECT COUNT(*) FROM tutor_assessment_questions q WHERE q.assessment_id = ta.id) AS question_count,
            sub.id AS submission_id, sub.score, sub.total_points, sub.percentage, sub.level, sub.submitted_at
       FROM tutor_assessments ta
       LEFT JOIN users u ON u.id = ta.tutor_id
       ${ANSWER_APPLY}
      WHERE ta.for_student_id = ? AND ta.module_id = ? AND ta.purpose = 'activity'
        AND ta.assessment_kind = 'tutor_assessment' AND ta.is_archived = 0${options.publishedOnly ? ' AND ta.is_published = 1' : ''}
      ORDER BY ta.created_at ASC, ta.id ASC`,
    [Number(studentId), Number(studentId), Number(moduleId)]
  );
}

/**
 * The module's activities shared with every student of the student's level
 * (those of no level module, and those of their level's), with their answer.
 */
async function getSharedActivities(row) {
  const rows = await query(
    `SELECT ta.id, ta.title, ta.item_count, ta.created_at, ta.level_module_id, lm.level AS level_module_level,
            (SELECT COUNT(*) FROM tutor_assessment_questions q WHERE q.assessment_id = ta.id) AS question_count,
            sub.id AS submission_id, sub.score, sub.total_points, sub.percentage, sub.level, sub.submitted_at
       FROM tutor_assessments ta
       LEFT JOIN level_modules lm ON lm.id = ta.level_module_id
       ${ANSWER_APPLY}
      WHERE ta.module_id = ? AND ta.for_student_id IS NULL AND ta.purpose = 'activity'
        AND ta.assessment_kind = 'tutor_assessment' AND ta.is_archived = 0 AND ta.is_published = 1
      ORDER BY ta.created_at ASC, ta.id ASC`,
    [Number(row.student_id), Number(row.module_id)]
  );
  const level = normalizeLevel(row.placement_level);
  return rows.filter((activity) => !activity.level_module_id || normalizeLevel(activity.level_module_level) === level);
}

/**
 * The module of their current learning path an activity written for this
 * student belongs to — open or passed — or null when it is not theirs to answer.
 */
async function personalActivityModule(assessment, studentId) {
  if (!assessment || !Number(assessment.for_student_id) || Number(assessment.for_student_id) !== Number(studentId)) return null;
  if (assessment.purpose !== 'activity' || (assessment.assessment_kind || 'tutor_assessment') !== 'tutor_assessment') return null;
  if (Number(assessment.is_archived) || !Number(assessment.is_published) || !assessment.module_id) return null;
  const path = await getCurrentPath(studentId, assessment.subject_id);
  if (!path) return null;
  return (await getPathModules(path.id)).find((row) => Number(row.module_id) === Number(assessment.module_id)
    && (row.status === 'open' || row.status === 'passed')) || null;
}

/** Can an activity be written in this module of a student's path? */
function canWriteActivity(row) {
  return !!row && (row.status === 'open' || row.status === 'passed');
}

/**
 * Save an activity a tutor wrote for this one student in their module, published
 * for them at once, and tell them.
 *
 * @returns {Promise<number>} the new assessment's id
 */
async function createPersonalActivity(pathModuleId, input = {}) {
  const row = await getPathModuleById(pathModuleId);
  if (!canWriteActivity(row)) throw new Error('An activity can be given in a module that is open for the student, or passed.');
  const title = String(input.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!title) throw new Error('Give the activity a title.');
  const questions = Array.isArray(input.questions) ? input.questions : [];
  if (!questions.length) throw new Error('Add at least one question.');
  const { createTutorAssessment } = require('./data');
  const id = await createTutorAssessment({
    subject_id: row.subject_id,
    module_id: row.module_id,
    tutor_id: Number(input.tutorId) || null,
    title,
    instructions: String(input.instructions || '').trim(),
    purpose: 'activity',
    assessment_kind: 'tutor_assessment',
    item_count: questions.length,
    questions,
    for_student_id: Number(row.student_id)
  });
  const number = row.order_number || row.position;
  await notify(row.student_id, {
    type: 'path_activity_new',
    title: `New activity in Module ${number}`,
    message: `Your tutor gave you an activity in Module ${number}: ${title}.`,
    linkUrl: `/student/path-modules/${row.id}`,
    refType: 'learning_path_module',
    refId: row.id
  });
  return id;
}

/** The text of a student's own module — its handouts and what was added — to draft an activity from. */
async function moduleSourcesFor(pathModuleId) {
  const row = await getPathModuleById(pathModuleId);
  return row ? assessmentSources(row) : [];
}

// ---------------------------------------------------------------------------
// Scores: every one of a path, and the Pre against the Post
// ---------------------------------------------------------------------------

/**
 * Every score of a learning path — the Pre-Assessment, each take of each
 * module's assessment, the activities answered in its modules, the
 * Post-Assessment — and the Pre and the Post side by side, overall and module by
 * module (by the module each question came from). For the student, their tutor
 * and the admin alike.
 *
 * @param {object} view  loadPathView(...)
 */
async function getPathScores(view) {
  if (!view || !view.path) return null;
  const path = view.path;
  const studentId = Number(path.student_id);
  const percentOf = (correct, total) => (total ? Number(((correct / total) * 100).toFixed(1)) : null);
  const submissionSelect = `SELECT sub.id, sub.score, sub.total_points, sub.percentage, sub.level, sub.submitted_at, ta.title
       FROM tutor_assessment_submissions sub
       JOIN tutor_assessments ta ON ta.id = sub.assessment_id`;

  const [pre] = await query(`${submissionSelect} WHERE sub.id = ? AND sub.student_id = ?`, [Number(path.pre_submission_id), studentId]);
  const [post] = path.post_assessment_id
    ? await query(`${submissionSelect} WHERE sub.assessment_id = ? AND sub.student_id = ? ORDER BY sub.submitted_at DESC`,
      [Number(path.post_assessment_id), studentId])
    : [];

  const submissionIds = [pre, post].filter(Boolean).map((row) => Number(row.id));
  const tallies = submissionIds.length
    ? await query(
      `SELECT a.submission_id, q.source_module_id AS module_id, COUNT(*) AS total,
              SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END) AS correct
         FROM tutor_student_answers a
         JOIN tutor_assessment_questions q ON q.id = a.question_id
        WHERE a.submission_id IN (${submissionIds.map(() => '?').join(',')})
        GROUP BY a.submission_id, q.source_module_id`,
      submissionIds
    )
    : [];
  const tallyOf = (submission, moduleId) => {
    if (!submission) return null;
    const hit = tallies.find((t) => Number(t.submission_id) === Number(submission.id) && Number(t.module_id) === Number(moduleId));
    return hit ? { correct: Number(hit.correct || 0), total: Number(hit.total || 0) } : null;
  };

  const moduleIds = view.modules.map((m) => Number(m.module_id)).filter(Boolean);
  const activities = moduleIds.length
    ? await query(
      `SELECT sub.id AS submission_id, sub.score, sub.total_points, sub.percentage, sub.level, sub.submitted_at,
              ta.id AS assessment_id, ta.title, ta.module_id, ta.for_student_id
         FROM tutor_assessment_submissions sub
         JOIN tutor_assessments ta ON ta.id = sub.assessment_id
        WHERE sub.student_id = ? AND ta.module_id IN (${moduleIds.map(() => '?').join(',')})
          AND ta.assessment_kind = 'tutor_assessment' AND ta.purpose = 'activity'
        ORDER BY sub.submitted_at ASC, sub.id ASC`,
      [studentId, ...moduleIds]
    )
    : [];

  const modules = view.modules.map((m) => {
    const before = tallyOf(pre, m.module_id);
    const after = tallyOf(post, m.module_id);
    const prePct = before ? percentOf(before.correct, before.total) : null;
    const postPct = after ? percentOf(after.correct, after.total) : null;
    return {
      id: Number(m.id),
      moduleId: Number(m.module_id),
      number: m.order_number || m.position,
      title: m.module_title,
      status: m.status,
      pre: before,
      post: after,
      prePct,
      postPct,
      change: prePct !== null && postPct !== null ? Number((postPct - prePct).toFixed(1)) : null,
      takes: m.attempts.length,
      best: m.attempts.length ? Math.max(...m.attempts.map((take) => Number(take.percentage) || 0)) : null
    };
  });

  const numberOf = new Map(view.modules.map((m) => [Number(m.module_id), m.order_number || m.position]));
  const rows = [];
  if (pre) {
    rows.push({
      kind: 'pre', rank: 0, title: 'Pre-Assessment', module: '', score: pre.score, total: pre.total_points,
      percentage: pre.percentage, level: pre.level, at: pre.submitted_at, submissionId: Number(pre.id)
    });
  }
  for (const m of view.modules) {
    const number = m.order_number || m.position;
    const last = m.attempts[m.attempts.length - 1];
    for (const take of m.attempts) {
      rows.push({
        kind: 'take', rank: 1, title: `Module ${number} Assessment — Take ${take.attempt_number}`, module: m.module_title,
        score: take.score, total: take.total_points, percentage: take.percentage, level: take.level, at: take.submitted_at,
        attemptId: Number(take.id),
        passed: (take === last && m.status === 'passed' && !m.passed_by) || passes(take.percentage)
      });
    }
  }
  for (const activity of activities) {
    const number = numberOf.get(Number(activity.module_id));
    rows.push({
      kind: 'activity', rank: 1, title: activity.title, module: number ? `Module ${number}` : '',
      score: activity.score, total: activity.total_points, percentage: activity.percentage, level: activity.level,
      at: activity.submitted_at, submissionId: Number(activity.submission_id), personal: !!activity.for_student_id
    });
  }
  if (post) {
    rows.push({
      kind: 'post', rank: 2, title: 'Post-Assessment', module: '', score: post.score, total: post.total_points,
      percentage: post.percentage, level: post.level, at: post.submitted_at, submissionId: Number(post.id)
    });
  }
  const time = (value) => {
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  rows.sort((a, b) => a.rank - b.rank || time(a.at) - time(b.at));

  return {
    pre: pre || null,
    post: post || null,
    modules,
    rows,
    comparison: pre && post
      ? {
        prePct: Number(pre.percentage),
        postPct: Number(post.percentage),
        delta: Number((Number(post.percentage) - Number(pre.percentage)).toFixed(1)),
        preLevel: pre.level,
        postLevel: post.level,
        levelChanged: pre.level !== post.level
      }
      : null
  };
}

/**
 * What the tutor's and the admin's page of one student's module needs: the
 * module with its takes, its weak points and topics, the activities written for
 * the student and those shared with their level. Null when there is none.
 */
async function modulePageData(pathModuleId) {
  const row = await getPathModuleById(pathModuleId);
  if (!row || row.status === 'removed') return null;
  const path = await getPathById(row.path_id);
  if (!path) return null;
  const view = await loadPathView(path);
  const current = view.modules.find((m) => Number(m.id) === Number(row.id))
    || { ...row, take_state: takeState(row), attempts: [] };
  const [personal, shared] = await Promise.all([
    getPersonalActivities(row.student_id, row.module_id),
    getSharedActivities(row)
  ]);
  return {
    row: { ...row, ...current, student_id: row.student_id, subject_id: row.subject_id, subject_name: row.subject_name },
    path,
    personalActivities: personal,
    sharedActivities: shared,
    canWriteActivity: canWriteActivity(row),
    studentId: Number(row.student_id),
    subjectId: Number(row.subject_id),
    studentBranchId: row.student_branch_id || null,
    studentLabel: studentName(row)
  };
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
  FOCUS_RULE,
  PASS_LABEL,
  isEnabled,
  passes,
  takeState,
  parseAdditions,
  readAdditions,
  packAdditions,
  weakPointSection,
  reshuffledCopy,
  getPersonalActivities,
  getSharedActivities,
  personalActivityModule,
  canWriteActivity,
  createPersonalActivity,
  moduleSourcesFor,
  getPathScores,
  modulePageData,
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
  resetPreAssessmentFor,
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
