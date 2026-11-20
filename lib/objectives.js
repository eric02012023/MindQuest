/**
 * File: lib/objectives.js
 * Purpose: MindQuest's own learning objectives, per module.
 *
 * The AI drafts three to five from a module's handouts (services/aiService.js,
 * generateModuleObjectives): by itself once a module has a readable handout and
 * no objectives yet, or again when the admin asks. The main admin edits them —
 * rewords, adds, removes, reorders — and approves them. Only approved
 * objectives are used.
 *
 * WHAT THEY ARE USED FOR
 *   - The AI writes each question of a Pre-Assessment, of a module assessment
 *     and of a drafted activity to measure one of its module's approved
 *     objectives (tutor_assessment_questions.objective_id), as evenly as it can.
 *   - A result reads per objective: Mastered at 60% right and above, Not yet
 *     below (MASTERY_FROM).
 *   - A learning path adds lessons for the objectives not mastered yet.
 *   - The Post-Assessment is set against the Pre-Assessment objective by
 *     objective.
 *
 * An objective is never deleted, only archived: the questions that measured it
 * keep pointing at it. Changing an approved list makes it a draft again until
 * the admin approves it once more; approving rebuilds that grade's
 * Pre-Assessment master from the objectives (lib/data.js, the fingerprint).
 */

const { query, withTransaction } = require('../config/db');

const NOW = 'DATEADD(hour, 8, GETUTCDATE())';
const MASTERY_FROM = 60;
const MAX_OBJECTIVES = 8;
const MIN_LENGTH = 8;
const MAX_LENGTH = 300;

/** Mastered: 60% of its questions right or more (with at least one question). */
function isMastered(correct, total) {
  return Number(total) > 0 && (Number(correct) / Number(total)) * 100 >= MASTERY_FROM;
}

/** A module's live objectives, in order. */
async function getObjectives(moduleId) {
  if (!Number(moduleId)) return [];
  return query(
    `SELECT id, module_id, position, objective_text, status, written_by, approved_by, approved_at, updated_at
       FROM module_objectives
      WHERE module_id = ? AND is_archived = 0
      ORDER BY position ASC, id ASC`,
    [Number(moduleId)]
  );
}

/** 'none' | 'draft' | 'approved': a module's objectives are approved when every live one is. */
function statusOf(objectives = []) {
  if (!objectives.length) return 'none';
  return objectives.every((o) => o.status === 'approved') ? 'approved' : 'draft';
}

/** The approved objectives of several modules, as module id -> [{ id, text, position }]. Every id asked for has an entry. */
async function approvedByModule(moduleIds = []) {
  const ids = [...new Set((moduleIds || []).map(Number).filter(Boolean))];
  const result = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return result;
  const rows = await query(
    `SELECT id, module_id, position, objective_text
       FROM module_objectives
      WHERE module_id IN (${ids.map(() => '?').join(', ')}) AND is_archived = 0 AND status = 'approved'
      ORDER BY module_id ASC, position ASC, id ASC`,
    ids
  );
  for (const row of rows) {
    const list = result.get(Number(row.module_id));
    if (list) list.push({ id: Number(row.id), text: row.objective_text, position: Number(row.position) });
  }
  return result;
}

/** Each handout with its module's approved objectives (handout.objectives), for the AI to write questions against. */
async function withObjectives(handouts = []) {
  const byModule = await approvedByModule(handouts.map((h) => h.module_id));
  return handouts.map((h) => ({ ...h, objectives: byModule.get(Number(h.module_id)) || [] }));
}

/**
 * An objective a question may keep: one of its own module's approved
 * objectives, or none. Changes the questions in place.
 *
 * @param {Array<{ source_module_id, objective_id }>} questions
 */
async function keepValidObjectives(questions = []) {
  const byModule = await approvedByModule(questions.map((q) => q.source_module_id));
  for (const q of questions) {
    const allowed = byModule.get(Number(q.source_module_id)) || [];
    if (!allowed.some((o) => o.id === Number(q.objective_id))) q.objective_id = null;
  }
  return questions;
}

/** The list the admin saved, checked: 1 to 8 different objectives, each 8 to 300 letters. */
function cleanList(items) {
  const list = (Array.isArray(items) ? items : [])
    .map((item) => ({
      id: Number(item && item.id) || null,
      text: String((item && item.text) || '').replace(/\s+/g, ' ').trim()
    }))
    .filter((item) => item.text);
  if (!list.length) throw new Error('Keep at least one objective.');
  if (list.length > MAX_OBJECTIVES) throw new Error(`A module can have at most ${MAX_OBJECTIVES} objectives.`);
  const seen = new Set();
  list.forEach((item, index) => {
    const n = index + 1;
    if (item.text.length < MIN_LENGTH) throw new Error(`Objective ${n} is too short.`);
    if (item.text.length > MAX_LENGTH) throw new Error(`Objective ${n} is too long: keep it under ${MAX_LENGTH} characters.`);
    const key = item.text.toLowerCase();
    if (seen.has(key)) throw new Error(`Objective ${n} says the same as another one.`);
    seen.add(key);
  });
  return list;
}

/**
 * Save a module's objectives as the admin left them: the ones kept keep their
 * id (their questions still point at them), new ones are added, and the ones
 * taken out are archived. Any change makes the list a draft until it is
 * approved again; saving it unchanged changes nothing.
 *
 * @param {Array<{ id?: number, text: string }>} items  in order
 * @returns {Promise<{ objectives: Array, changed: boolean }>}
 */
async function saveObjectives(moduleId, items) {
  const list = cleanList(items);
  const current = await getObjectives(moduleId);
  const byId = new Map(current.map((o) => [Number(o.id), o]));
  const same = list.length === current.length
    && list.every((item, i) => item.id === Number(current[i].id) && item.text === current[i].objective_text);
  if (same) return { objectives: current, changed: false };

  await withTransaction(async (connection) => {
    const kept = new Set();
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const existing = item.id ? byId.get(item.id) : null;
      if (existing && !kept.has(Number(existing.id))) {
        kept.add(Number(existing.id));
        await connection.query(
          `UPDATE module_objectives
              SET position = ?, objective_text = ?, written_by = ?, status = 'draft',
                  approved_by = NULL, approved_at = NULL, updated_at = ${NOW}
            WHERE id = ? AND module_id = ? AND is_archived = 0`,
          [
            i + 1, item.text, existing.objective_text === item.text ? existing.written_by : 'admin',
            Number(existing.id), Number(moduleId)
          ]
        );
      } else {
        await connection.query(
          `INSERT INTO module_objectives (module_id, position, objective_text, status, written_by)
           VALUES (?, ?, ?, 'draft', 'admin')`,
          [Number(moduleId), i + 1, item.text]
        );
      }
    }
    for (const objective of current) {
      if (kept.has(Number(objective.id))) continue;
      await connection.query(
        `UPDATE module_objectives SET is_archived = 1, updated_at = ${NOW} WHERE id = ?`,
        [Number(objective.id)]
      );
    }
    // Every live one is a draft now, kept or new.
    await connection.query(
      `UPDATE module_objectives SET status = 'draft', approved_by = NULL, approved_at = NULL, updated_at = ${NOW}
        WHERE module_id = ? AND is_archived = 0`,
      [Number(moduleId)]
    );
  });
  return { objectives: await getObjectives(moduleId), changed: true };
}

/** Approve a module's objectives as they are. */
async function approveObjectives(moduleId, actorId) {
  const current = await getObjectives(moduleId);
  if (!current.length) throw new Error('Write at least one objective first.');
  await query(
    `UPDATE module_objectives
        SET status = 'approved', approved_by = ?, approved_at = ${NOW}, updated_at = ${NOW}
      WHERE module_id = ? AND is_archived = 0`,
    [Number(actorId) || null, Number(moduleId)]
  );
  return getObjectives(moduleId);
}

/**
 * Draft a module's objectives with the AI, from its readable handouts. With
 * `replace`, any objectives it has are archived and the new drafts take their
 * place; without it, a module that has objectives is left alone.
 */
async function draftWithAI(moduleId, options = {}) {
  const data = require('./data');
  const mod = await data.getModuleById(Number(moduleId));
  if (!mod) throw new Error('Module not found.');
  const current = await getObjectives(mod.id);
  if (current.length && !options.replace) return { skipped: true, objectives: current };

  const handouts = (await data.getModuleHandouts(mod.id))
    .filter((h) => h.extracted_at && String(h.extracted_text || '').trim().length > 50);
  if (!handouts.length) throw new Error('This module has no readable handout yet, so its objectives cannot be drafted.');

  const { generateModuleObjectives } = require('../services/aiService');
  let written;
  try {
    written = await generateModuleObjectives({
      subject: mod.subject_name,
      gradeLevel: mod.grade_level,
      moduleTitle: mod.title,
      text: handouts.map((h) => String(h.extracted_text || '').trim()).join('\n\n')
    });
  } catch (error) {
    await data.logAiGeneration({
      generation_type: 'module_objectives',
      subject_id: mod.subject_id,
      input_summary: `module ${mod.id}: ${handouts.length} handout(s)`,
      success: false,
      error_message: error.message
    }).catch(() => {});
    throw error;
  }

  await withTransaction(async (connection) => {
    await connection.query(
      `UPDATE module_objectives SET is_archived = 1, updated_at = ${NOW} WHERE module_id = ? AND is_archived = 0`,
      [Number(mod.id)]
    );
    for (let i = 0; i < written.objectives.length; i++) {
      await connection.query(
        `INSERT INTO module_objectives (module_id, position, objective_text, status, written_by)
         VALUES (?, ?, ?, 'draft', 'ai')`,
        [Number(mod.id), i + 1, written.objectives[i]]
      );
    }
  });
  await data.logAiGeneration({
    generation_type: 'module_objectives',
    subject_id: mod.subject_id,
    input_summary: `module ${mod.id}: ${handouts.length} handout(s)`,
    output_summary: `${written.objectives.length} objective(s) drafted`,
    ai_model: written.model,
    tokens_used: written.tokensUsed,
    success: true
  }).catch(() => {});
  return { skipped: false, objectives: await getObjectives(mod.id) };
}

/**
 * Draft a module's objectives in the background when it has none yet — after a
 * handout is uploaded or read again. Never throws: a module whose handouts
 * cannot be read simply waits.
 */
function draftIfMissing(moduleId) {
  return draftWithAI(moduleId, { replace: false }).catch((error) => {
    console.log(`[objectives] module ${moduleId}: not drafted — ${error.message}`);
    return { skipped: true, error: error.message };
  });
}

function shapeResult(row) {
  const correct = Number(row.correct) || 0;
  const total = Number(row.total) || 0;
  return {
    id: Number(row.id),
    text: row.objective_text,
    moduleLabel: row.module_title ? `Module ${row.order_number || '?'}: ${row.module_title}` : '',
    moduleOrder: Number(row.order_number) || 0,
    position: Number(row.position) || 0,
    correct,
    total,
    percent: total ? Math.round((correct / total) * 1000) / 10 : null,
    mastered: isMastered(correct, total)
  };
}

/**
 * How a learner did on each learning objective in one submission, or in one
 * take of a module assessment: [{ id, text, moduleLabel, correct, total,
 * percent, mastered }], module by module. Questions with no objective are not
 * counted here.
 */
async function objectiveResultsFor({ submissionId = null, attemptId = null } = {}) {
  const source = Number(submissionId)
    ? { table: 'tutor_student_answers', column: 'submission_id', id: Number(submissionId) }
    : { table: 'tutor_assessment_attempt_answers', column: 'attempt_id', id: Number(attemptId) };
  if (!source.id) return [];
  const rows = await query(
    `SELECT o.id, o.objective_text, o.position, m.order_number, m.title AS module_title,
            COUNT(*) AS total, SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END) AS correct
       FROM ${source.table} a
       JOIN tutor_assessment_questions q ON q.id = a.question_id
       JOIN module_objectives o ON o.id = q.objective_id
       LEFT JOIN modules m ON m.id = o.module_id
      WHERE a.${source.column} = ?
      GROUP BY o.id, o.objective_text, o.position, m.order_number, m.title
      ORDER BY m.order_number ASC, o.position ASC, o.id ASC`,
    [source.id]
  );
  return rows.map(shapeResult);
}

/**
 * The Pre-Assessment against the Post-Assessment, objective by objective:
 * [{ id, text, moduleLabel, pre, post }] — pre / post being that submission's
 * result for the objective, or null.
 */
async function objectiveComparison(preSubmissionId, postSubmissionId = null) {
  const [pre, post] = await Promise.all([
    objectiveResultsFor({ submissionId: preSubmissionId }),
    postSubmissionId ? objectiveResultsFor({ submissionId: postSubmissionId }) : Promise.resolve([])
  ]);
  const byId = new Map();
  for (const result of [...pre, ...post]) {
    if (!byId.has(result.id)) {
      byId.set(result.id, {
        id: result.id, text: result.text, moduleLabel: result.moduleLabel,
        moduleOrder: result.moduleOrder, position: result.position, pre: null, post: null
      });
    }
  }
  for (const result of pre) byId.get(result.id).pre = result;
  for (const result of post) byId.get(result.id).post = result;
  return [...byId.values()].sort((a, b) => a.moduleOrder - b.moduleOrder || a.position - b.position || a.id - b.id);
}

/**
 * The approved objectives a filter can offer: a subject's, in one grade or one
 * module when chosen. [{ id, label }].
 */
async function objectiveOptions({ subjectId, gradeLevel = null, moduleId = null } = {}) {
  if (!Number(subjectId)) return [];
  const params = [Number(subjectId)];
  let narrow = '';
  if (Number(moduleId)) { narrow += ' AND m.id = ?'; params.push(Number(moduleId)); }
  if (gradeLevel) { narrow += ' AND m.grade_level = ?'; params.push(gradeLevel); }
  const rows = await query(
    `SELECT o.id, o.objective_text, o.position, m.order_number
       FROM module_objectives o
       JOIN modules m ON m.id = o.module_id
      WHERE m.subject_id = ? AND m.is_archived = 0 AND o.is_archived = 0 AND o.status = 'approved'${narrow}
      ORDER BY m.order_number ASC, o.position ASC, o.id ASC`,
    params
  );
  return rows.map((row) => ({
    id: Number(row.id),
    label: `M${row.order_number || '?'}.${row.position} ${row.objective_text}`
  }));
}

module.exports = {
  MASTERY_FROM,
  MAX_OBJECTIVES,
  isMastered,
  getObjectives,
  statusOf,
  approvedByModule,
  withObjectives,
  keepValidObjectives,
  cleanList,
  saveObjectives,
  approveObjectives,
  draftWithAI,
  draftIfMissing,
  objectiveResultsFor,
  objectiveComparison,
  objectiveOptions
};
