/**
 * File: lib/levelModules.js
 * Purpose: The adaptive part of the module system — each of the admin's modules
 *          written again for the level a student reached in the Pre-Assessment.
 *
 * A Beginner in English Grade 4 does not work in the admin's Module 1 any more:
 * they work in Module 1 written for a Beginner, from the same handouts. The
 * tutor's new activities go inside that level module, the student answers them
 * there, and the admin's module stays open to view.
 *
 * Decisions this file holds to:
 *
 *  - One level module per module AND level (level_modules), shared by every
 *    student of that level — not one per student. Three modules make at most
 *    nine level modules, however big the class grows, so the 30 MB database and
 *    the AI bill grow with the modules.
 *  - The level is the one the Pre-Assessment gave (the student's placement).
 *    Every later activity moves the classification on record (gradeAndSubmit),
 *    but the module set a student works in does not move with it: their
 *    activities would vanish into another level's module after one bad score.
 *  - Writing a level module is never done inside a request. It is queued, runs
 *    in the background two at a time, one AI call per handout, and the page shows
 *    "being prepared" until it is ready. A failure is recorded with its reason and
 *    tried again on the next visit, at most MAX_ATTEMPTS times; after that it
 *    waits for the admin's "Make again".
 *  - An activity with no level module (written before level modules existed)
 *    belongs to every level: each student meets it inside their own level module.
 *  - The month rule holds (lib/postWindow.js, addedInMonth): a level module made
 *    after a student's month ended is not theirs, like any module added late.
 */

const crypto = require('crypto');
const { query, withTransaction } = require('../config/db');
const { addedInMonth } = require('./postWindow');
const { studentGradeOf, canonicalGrade } = require('./moduleGrades');

const LEVELS = ['Beginner', 'Intermediate', 'Advance'];

/** Automatic tries before a failed level module waits for the admin. */
const MAX_ATTEMPTS = 3;

/** A build still "generating" after this long is taken to have died with its process. */
const STALE_GENERATING_MINUTES = 15;

/** Level modules written at once, and lessons per level module at once. */
const JOB_CONCURRENCY = 2;
const SECTION_CONCURRENCY = 2;

/** 'Advanced' is an older spelling of 'Advance' that still sits in some rows. */
function normalizeLevel(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'beginner') return 'Beginner';
  if (text === 'intermediate') return 'Intermediate';
  if (text === 'advance' || text === 'advanced') return 'Advance';
  return null;
}

/** The level a Pre-Assessment sitting placed the student at, or null. */
function placementLevelOf(preSubmission) {
  return normalizeLevel(preSubmission && preSubmission.level);
}

/**
 * Is this activity one for a student of `level`? An activity outside any level
 * module is for every level; one inside a level module, only for that level.
 * The activity row carries level_module_id and level_module_level (the joined
 * level_modules.level).
 */
function activityMatchesLevel(activity, level) {
  if (!activity || !activity.level_module_id) return true;
  const wanted = normalizeLevel(level);
  return !!wanted && normalizeLevel(activity.level_module_level) === wanted;
}

/** What a level module was written from: its handouts' ids and their exact text. */
function sourceFingerprint(handouts = []) {
  const parts = handouts
    .map((h) => {
      const text = String(h.extracted_text || '');
      return `${Number(h.handout_id || h.id)}:${crypto.createHash('sha1').update(text).digest('hex')}`;
    })
    .sort();
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The level modules of these modules, every level, with their counts. */
async function getLevelModuleRows(sourceModuleIds = []) {
  const ids = [...new Set(sourceModuleIds.map(Number).filter(Boolean))];
  if (!ids.length) return [];
  const rows = await query(
    `SELECT lm.id, lm.source_module_id, lm.level, lm.title, lm.status, lm.source_fingerprint,
            lm.generated_by, lm.error_message, lm.attempts, lm.generated_at, lm.created_at, lm.updated_at,
            (SELECT COUNT(*) FROM level_module_sections s WHERE s.level_module_id = lm.id) AS section_count,
            (SELECT COUNT(*) FROM tutor_assessments ta WHERE ta.level_module_id = lm.id AND ta.is_archived = 0) AS assessment_count
       FROM level_modules lm
      WHERE lm.source_module_id IN (${ids.map(() => '?').join(',')})`,
    ids
  );
  return rows.map((row) => ({ ...row, level: normalizeLevel(row.level) }));
}

/**
 * Module id -> { Beginner, Intermediate, Advance }: the row of each level, or
 * null for a level not made yet. Every id asked for has an entry.
 */
async function getLevelModulesBySource(sourceModuleIds = []) {
  const map = new Map();
  for (const id of sourceModuleIds.map(Number).filter(Boolean)) {
    map.set(id, { Beginner: null, Intermediate: null, Advance: null });
  }
  for (const row of await getLevelModuleRows(sourceModuleIds)) {
    const entry = map.get(Number(row.source_module_id));
    if (entry && row.level) entry[row.level] = row;
  }
  return map;
}

async function getLevelModuleSections(levelModuleId) {
  return query(
    `SELECT id, level_module_id, source_handout_id, order_number, title, content_text
       FROM level_module_sections
      WHERE level_module_id = ?
      ORDER BY order_number ASC, id ASC`,
    [Number(levelModuleId)]
  );
}

/**
 * One level module with its lesson and the module it was written from — or null
 * when either is gone (a removed module takes its level modules out of sight).
 */
async function getLevelModuleDetail(id) {
  const rows = await query('SELECT * FROM level_modules WHERE id = ?', [Number(id)]);
  const row = rows[0];
  if (!row) return null;
  const { getModuleById } = require('./data');
  const [source, sections] = await Promise.all([
    getModuleById(row.source_module_id),
    getLevelModuleSections(row.id)
  ]);
  if (!source) return null;
  return {
    ...row,
    level: normalizeLevel(row.level),
    source,
    sections,
    // Its handouts changed since it was written: the admin can make it again.
    is_stale: false
  };
}

/** Mark detail.is_stale when the module's handouts changed after it was written. */
async function withStaleFlag(detail) {
  if (!detail || detail.status !== 'ready' || !detail.source_fingerprint) return detail;
  const { getModuleHandoutTexts } = require('./data');
  const handouts = await getModuleHandoutTexts(detail.source_module_id);
  return { ...detail, is_stale: handouts.length > 0 && sourceFingerprint(handouts) !== detail.source_fingerprint };
}

// ---------------------------------------------------------------------------
// Placement: which level a student works at
// ---------------------------------------------------------------------------

/**
 * Student id -> the level their Pre-Assessment in this subject placed them at.
 * The Pre-Assessment that counts is the one of their own grade, or one from
 * before Pre-Assessments were per grade (hasCompletedPreAssessment, for many
 * students at once). Students who have not sat it are left out.
 *
 * @param {Array} students  rows with id (or student_id) and grade_level / year_level
 */
async function getPlacementLevels(subjectId, students = []) {
  const byId = new Map();
  for (const student of students) {
    const id = Number(student.id || student.student_id);
    if (id && !byId.has(id)) byId.set(id, student);
  }
  const placements = new Map();
  if (!byId.size) return placements;
  const ids = [...byId.keys()];
  const rows = await query(
    `SELECT sub.student_id, sub.level, ta.grade_level, sub.submitted_at
       FROM tutor_assessment_submissions sub
       JOIN tutor_assessments ta ON ta.id = sub.assessment_id
      WHERE ta.subject_id = ? AND ta.assessment_kind = 'pre_assessment'
        AND sub.student_id IN (${ids.map(() => '?').join(',')})
      ORDER BY sub.submitted_at DESC`,
    [Number(subjectId), ...ids]
  );
  for (const row of rows) {
    const id = Number(row.student_id);
    if (placements.has(id)) continue;
    const grade = studentGradeOf(byId.get(id));
    const counts = !row.grade_level || (!!grade && canonicalGrade(row.grade_level) === grade);
    const level = normalizeLevel(row.level);
    if (counts && level) placements.set(id, level);
  }
  return placements;
}

// ---------------------------------------------------------------------------
// Making them
// ---------------------------------------------------------------------------

/** The level module of one module and level, created (empty, pending) when missing. */
async function ensureLevelModule(sourceModuleId, level) {
  const wanted = normalizeLevel(level);
  if (!wanted) throw new Error('Choose Beginner, Intermediate or Advance.');
  const find = async () => {
    const rows = await query(
      'SELECT * FROM level_modules WHERE source_module_id = ? AND level = ?',
      [Number(sourceModuleId), wanted]
    );
    return rows[0] ? { ...rows[0], level: normalizeLevel(rows[0].level) } : null;
  };
  const existing = await find();
  if (existing) return existing;
  try {
    await query(
      "INSERT INTO level_modules (source_module_id, level, status) VALUES (?, ?, 'pending')",
      [Number(sourceModuleId), wanted]
    );
  } catch (error) {
    // Two requests asked at the same moment: uq_level_modules_source_level kept
    // one row, and that row is the answer for both.
    if (!/duplicate key|unique/i.test(String(error.message))) throw error;
  }
  return find();
}

/** Should a background build be started for this row? */
function wantsBuild(row) {
  if (!row) return false;
  if (row.status === 'pending' || row.status === 'generating') return true;
  return row.status === 'failed' && Number(row.attempts || 0) < MAX_ATTEMPTS;
}

/**
 * Take the job of writing one level module. The UPDATE is the lock: only one
 * caller — in this process or another — can move a row into 'generating', and
 * a build that died with its process is taken over once it has gone stale.
 */
async function claimLevelModule(id, force = false) {
  const stale = `(status = 'generating' AND updated_at < DATEADD(minute, -${STALE_GENERATING_MINUTES}, DATEADD(hour, 8, GETUTCDATE())))`;
  const open = force
    ? `status IN ('pending', 'failed', 'ready')`
    : `status = 'pending' OR (status = 'failed' AND attempts < ${MAX_ATTEMPTS})`;
  const rows = await query(
    `UPDATE level_modules
        SET status = 'generating', attempts = attempts + 1, error_message = NULL,
            updated_at = DATEADD(hour, 8, GETUTCDATE())
     OUTPUT inserted.id
      WHERE id = ? AND (${open} OR ${stale})`,
    [Number(id)]
  );
  return rows.length > 0;
}

async function runLimited(items, limit, job) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await job(queue.shift());
  });
  await Promise.all(workers);
}

function logGeneration(entry) {
  const { logAiGeneration } = require('./data');
  return logAiGeneration({ generation_type: 'level_module', ...entry })
    .catch((error) => console.error('[levelModules] could not write ai_generation_logs:', error.message));
}

/**
 * Write one level module now: a lesson per handout of its module, for its level.
 * Returns { ok, sections, errors } or { skipped: true } when someone else holds
 * the job (or it is ready and not forced).
 */
async function generateLevelModule(id, options = {}) {
  if (!(await claimLevelModule(id, !!options.force))) return { skipped: true };

  const data = require('./data');
  const { generateLevelLesson, getAiStatus } = require('../services/aiService');
  const rows = await query('SELECT * FROM level_modules WHERE id = ?', [Number(id)]);
  const row = rows[0];
  const level = normalizeLevel(row && row.level);
  let source = null;

  try {
    source = row ? await data.getModuleById(row.source_module_id) : null;
    if (!source) throw new Error('The module this was written from has been removed.');
    const handouts = await data.getModuleHandoutTexts(source.id);
    if (!handouts.length) {
      throw new Error('This module has no handout with readable text yet. Upload one, or use "Read with AI" on a scanned handout.');
    }

    let tokens = 0;
    const written = new Array(handouts.length).fill(null);
    const errors = [];
    await runLimited(handouts.map((handout, index) => ({ handout, index })), SECTION_CONCURRENCY, async ({ handout, index }) => {
      try {
        const lesson = await generateLevelLesson({
          handout,
          level,
          subject: source.subject_name,
          gradeLevel: source.grade_level,
          moduleTitle: source.title
        });
        tokens += Number(lesson.tokensUsed || 0);
        written[index] = {
          source_handout_id: Number(handout.handout_id) || null,
          title: lesson.title || handout.file_original_name || `Part ${index + 1}`,
          content_text: lesson.lesson
        };
      } catch (error) {
        errors.push(error.message);
      }
    });

    const sections = written.filter(Boolean);
    if (!sections.length) throw new Error(errors[0] || 'The lesson could not be written.');
    const note = errors.length
      ? `${errors.length} of ${handouts.length} parts could not be written (${errors[0]}). Make it again to retry them.`.slice(0, 480)
      : null;

    await withTransaction(async (connection) => {
      await connection.query('DELETE FROM level_module_sections WHERE level_module_id = ?', [row.id]);
      for (let i = 0; i < sections.length; i++) {
        await connection.query(
          `INSERT INTO level_module_sections (level_module_id, source_handout_id, order_number, title, content_text)
           VALUES (?, ?, ?, ?, ?)`,
          [row.id, sections[i].source_handout_id, i + 1, sections[i].title, sections[i].content_text]
        );
      }
      await connection.query(
        `UPDATE level_modules
            SET status = 'ready', title = ?, source_fingerprint = ?, generated_by = 'ai', error_message = ?,
                generated_at = DATEADD(hour, 8, GETUTCDATE()), updated_at = DATEADD(hour, 8, GETUTCDATE())
          WHERE id = ?`,
        [String(source.title || '').slice(0, 250), sourceFingerprint(handouts), note, row.id]
      );
    });

    const ai = getAiStatus();
    logGeneration({
      subject_id: source.subject_id,
      input_summary: `level module ${row.id}: Module ${source.order_number} (${source.grade_level}), ${level}, ${handouts.length} handout(s)`,
      output_summary: `${sections.length} section(s) written`,
      ai_provider: ai.provider,
      ai_model: ai.model,
      tokens_used: tokens,
      success: true
    });
    return { ok: true, sections: sections.length, errors };
  } catch (error) {
    await query(
      `UPDATE level_modules
          SET status = 'failed', error_message = ?, updated_at = DATEADD(hour, 8, GETUTCDATE())
        WHERE id = ?`,
      [String(error.message || 'The level module could not be written.').slice(0, 480), Number(id)]
    ).catch((saveError) => console.error('[levelModules] could not record the failure:', saveError.message));
    logGeneration({
      subject_id: source ? source.subject_id : null,
      input_summary: `level module ${id}: ${level || 'unknown level'}`,
      success: false,
      error_message: String(error.message || '').slice(0, 1000)
    });
    console.error(`[levelModules] level module ${id} (${level}) failed:`, error.message);
    return { ok: false, error: error.message };
  }
}

// One queue for the process: a backlog (say, a class's first visits after this
// ships) is worked through JOB_CONCURRENCY at a time, never all at once.
const queued = new Map();
const waiting = [];
let running = 0;

function pump() {
  while (running < JOB_CONCURRENCY && waiting.length) {
    const job = waiting.shift();
    running++;
    generateLevelModule(job.id, job.options)
      .catch((error) => ({ ok: false, error: error.message }))
      .then((result) => job.resolve(result))
      .finally(() => {
        running--;
        queued.delete(job.id);
        pump();
      });
  }
}

/**
 * Write a level module in the background. Asking twice for the same one while
 * it is queued or being written returns the same promise; nothing here throws
 * into a request.
 */
function queueLevelModule(id, options = {}) {
  const key = Number(id);
  if (!key) return Promise.resolve({ skipped: true });
  if (queued.has(key)) return queued.get(key);
  const promise = new Promise((resolve) => {
    waiting.push({ id: key, options, resolve });
  });
  queued.set(key, promise);
  pump();
  return promise;
}

/**
 * The level modules a student works in for one subject: their placement level's
 * version of every module they can see, made (pending) where missing and queued
 * to be written. Cheap enough for a page load — the writing happens later.
 *
 * Once the student's month is over nothing new is made for them: a level module
 * added after it ended would not be theirs anyway.
 *
 * @returns {Promise<Array<{ module, levelModule }>>} one entry per visible module,
 *          levelModule null where the student has none
 */
async function prepareStudentLevelModules(studentId, subjectId, options = {}) {
  const data = require('./data');
  const placement = options.preSubmission !== undefined
    ? options.preSubmission
    : await data.hasCompletedPreAssessment(studentId, subjectId);
  const level = placementLevelOf(placement);
  if (!level) return [];
  const month = options.month || await data.getSubjectMonth(studentId, subjectId);
  const modules = options.modules || await data.getStudentSubjectModules(studentId, subjectId, { month });
  if (!modules.length) return [];

  const bySource = await getLevelModulesBySource(modules.map((mod) => mod.id));
  const result = [];
  for (const mod of modules) {
    let row = (bySource.get(Number(mod.id)) || {})[level] || null;
    if (!row && !month.isOver) row = await ensureLevelModule(mod.id, level);
    const visible = row && addedInMonth(row.created_at, month) ? row : null;
    if (visible && wantsBuild(visible) && options.queue !== false) queueLevelModule(visible.id);
    result.push({ module: mod, levelModule: visible });
  }
  return result;
}

/**
 * The visible level module of ONE module for a student, or null: their placement
 * level's, made before their month ended.
 */
async function getStudentLevelModuleFor(sourceModuleId, level, month) {
  const wanted = normalizeLevel(level);
  if (!wanted) return null;
  const rows = await query(
    'SELECT * FROM level_modules WHERE source_module_id = ? AND level = ?',
    [Number(sourceModuleId), wanted]
  );
  const row = rows[0];
  return row && addedInMonth(row.created_at, month) ? { ...row, level: wanted } : null;
}

module.exports = {
  LEVELS,
  MAX_ATTEMPTS,
  normalizeLevel,
  placementLevelOf,
  activityMatchesLevel,
  sourceFingerprint,
  getLevelModuleRows,
  getLevelModulesBySource,
  getLevelModuleSections,
  getLevelModuleDetail,
  withStaleFlag,
  getPlacementLevels,
  ensureLevelModule,
  wantsBuild,
  claimLevelModule,
  generateLevelModule,
  queueLevelModule,
  prepareStudentLevelModules,
  getStudentLevelModuleFor
};
