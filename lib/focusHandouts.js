/**
 * File: lib/focusHandouts.js
 * Purpose: Turn a finished Pre-Assessment into focus material for the tutor.
 *
 * The brief: when a student completes the Pre-Assessment, work out which topics
 * they were weakest in, generate a handout aimed at exactly those topics, label it
 * for the assigned tutor ("this is the focus area for <student>"), and tell the
 * tutor it is there.
 *
 * Two things this deliberately does NOT do:
 *
 *  - it never blocks the student's submit. Generation runs after the result is
 *    saved and its failure is logged, not thrown: a slow or unconfigured AI
 *    provider must not cost the student their attempt.
 *  - it never invents topics. The weak areas come from the stored per-question
 *    grading, grouped by the module and handout each question was generated from,
 *    so "weak in Module 2 — Fractions" traces back to real answers.
 *
 * If the AI is unavailable the handout is still written, from a template built out
 * of the same measured data. A tutor with a plain list of weak topics is far more
 * useful than no handout at all.
 */

const { query } = require('../config/db');

/** Below this share of marks in a topic, the topic counts as weak. */
const WEAK_THRESHOLD = 0.6;

/** At most this many topics in one focus handout — a focus list of nine is not a focus. */
const MAX_TOPICS = 4;

/** Who teaches this student this subject? Null when nobody is assigned yet. */
async function findAssignedTutor(studentId, subjectId) {
  const rows = await query(
    `SELECT TOP 1 usa.tutor_id, u.first_name, u.last_name
     FROM user_subject_assignments usa
     LEFT JOIN users u ON u.id = usa.tutor_id
     WHERE usa.student_id = ? AND usa.subject_id = ? AND usa.is_archived = 0 AND usa.tutor_id IS NOT NULL
     ORDER BY usa.assigned_at DESC, usa.id DESC`,
    [studentId, subjectId]
  );
  return rows[0] || null;
}

/**
 * Rank the weak areas of one submission.
 * Returns the worst-performing topics first, capped at MAX_TOPICS.
 */
function rankWeakAreas(weakAreas = []) {
  return weakAreas
    .filter((area) => Number(area.total || 0) > 0)
    .map((area) => ({
      module_id: area.module_id || null,
      handout_id: area.handout_id || null,
      order_number: area.order_number || null,
      topic: area.handout_name
        ? `${area.module_title} — ${area.handout_name}`
        : area.module_title || 'Unattributed',
      module_title: area.module_title || 'Unattributed',
      handout_name: area.handout_name || null,
      correct: Number(area.correct || 0),
      total: Number(area.total || 0),
      wrong: Number(area.total || 0) - Number(area.correct || 0),
      percentage: Number(area.percentage || 0)
    }))
    .filter((area) => area.correct / area.total < WEAK_THRESHOLD)
    .sort((a, b) => a.percentage - b.percentage || b.wrong - a.wrong)
    .slice(0, MAX_TOPICS);
}

/** The source text behind a set of weak topics, for the generator to work from. */
async function loadTopicSources(topics = []) {
  const handoutIds = topics.map((t) => Number(t.handout_id)).filter(Boolean);
  if (!handoutIds.length) return [];
  const rows = await query(
    `SELECT h.id AS handout_id, h.file_original_name, h.extracted_text,
            m.id AS module_id, m.title AS module_title, m.order_number
     FROM module_handouts h
     JOIN modules m ON m.id = h.module_id
     WHERE h.id IN (${handoutIds.map(() => '?').join(',')})
       AND h.is_archived = 0 AND h.extracted_text IS NOT NULL`,
    handoutIds
  );
  return rows;
}

/**
 * The handout body written without the AI.
 *
 * Not a placeholder: it names each weak topic, what the student actually scored on
 * it, and what to do about it. That is a usable lesson plan on its own.
 */
function buildTemplateContent({ studentName, subjectName, percentage, topics }) {
  const lines = [];
  lines.push(`FOCUS AREAS FOR ${studentName.toUpperCase()}`);
  lines.push(`Subject: ${subjectName}`);
  lines.push(`Pre-Assessment result: ${Number(percentage || 0).toFixed(1)}%`);
  lines.push('');
  lines.push('These are the topics this student scored lowest on in the Pre-Assessment.');
  lines.push('Teach these first.');
  lines.push('');

  topics.forEach((topic, index) => {
    lines.push(`${index + 1}. ${topic.topic}`);
    lines.push(`   Scored ${topic.correct} of ${topic.total} (${topic.percentage}%) — ${topic.wrong} item(s) missed.`);
    lines.push('   Suggested plan:');
    lines.push(`   • Re-teach the core idea of "${topic.module_title}" from the handout before any exercises.`);
    lines.push('   • Work through two or three worked examples together, saying each step out loud.');
    lines.push('   • Set a short practice set on this topic only, then re-check before moving on.');
    lines.push('');
  });

  if (!topics.length) {
    lines.push('No topic fell below the weak threshold — this student is ready for the standard module order.');
    lines.push('');
  }

  lines.push('Full per-question results are in Analytics & Reports.');
  return lines.join('\n');
}

/**
 * Generate and store the focus handout for one Pre-Assessment submission.
 *
 * Safe to call twice for the same submission: the row is keyed on submission_id
 * and is updated rather than duplicated, so a re-run refreshes the material
 * instead of stacking near-identical entries in the tutor's list.
 *
 * @param {object} input
 * @param {number} input.submissionId
 * @param {number} input.studentId
 * @param {number} input.subjectId
 * @param {number} [input.assessmentId]
 * @returns {Promise<object|null>} the stored focus handout, or null if it could not be built
 */
async function generateFocusHandout(input = {}) {
  const { submissionId, studentId, subjectId, assessmentId = null } = input;

  const { getWeakAreasForSubmission } = require('./data');

  const [studentRows, subjectRows, submissionRows] = await Promise.all([
    query('SELECT TOP 1 id, first_name, middle_name, last_name, user_id, year_level, grade_level FROM users WHERE id = ?', [studentId]),
    query('SELECT TOP 1 id, name FROM subjects WHERE id = ?', [subjectId]),
    query('SELECT TOP 1 id, percentage, level, score, total_points FROM tutor_assessment_submissions WHERE id = ?', [submissionId])
  ]);

  const student = studentRows[0];
  const subject = subjectRows[0];
  const submission = submissionRows[0];
  if (!student || !subject || !submission) return null;

  const studentName = [student.first_name, student.last_name].filter(Boolean).join(' ');
  const weakAreas = await getWeakAreasForSubmission(submissionId);
  const topics = rankWeakAreas(weakAreas);

  const tutor = await findAssignedTutor(studentId, subjectId);

  // Try the AI first, fall back to the template. Either way a handout exists.
  let content = null;
  let generatedBy = 'system';
  if (topics.length) {
    try {
      const sources = await loadTopicSources(topics);
      const { generateFocusMaterial, isOpenAIConfigured } = require('../services/aiService');
      if (isOpenAIConfigured() && sources.length) {
        content = await generateFocusMaterial({
          studentName,
          subject: subject.name,
          yearLevel: student.year_level || student.grade_level || '',
          percentage: Number(submission.percentage || 0),
          topics,
          sources
        });
        if (content) generatedBy = 'ai';
      }
    } catch (error) {
      console.error('[focusHandouts] AI generation failed, using the template:', error.message);
    }
  }

  if (!content) {
    content = buildTemplateContent({
      studentName,
      subjectName: subject.name,
      percentage: submission.percentage,
      topics
    });
  }

  const title = topics.length
    ? `Focus areas for ${studentName} — ${subject.name}`
    : `Pre-Assessment review for ${studentName} — ${subject.name}`;

  const summary = topics.length
    ? `Weak points from the Pre-Assessment: ${topics.map((t) => t.topic).join('; ')}.`
    : 'No topic fell below the weak threshold in the Pre-Assessment.';

  const existing = await query('SELECT TOP 1 id FROM focus_handouts WHERE submission_id = ?', [submissionId]);

  if (existing.length) {
    await query(
      `UPDATE focus_handouts
          SET title = ?, summary = ?, content_text = ?, weak_topics_json = ?,
              overall_percentage = ?, tutor_id = ?, generated_by = ?, status = 'active',
              is_archived = 0, updated_at = DATEADD(hour, 8, GETUTCDATE())
        WHERE id = ?`,
      [
        title, summary, content, JSON.stringify(topics),
        Number(submission.percentage || 0), tutor?.tutor_id || null, generatedBy,
        existing[0].id
      ]
    );
    return getFocusHandoutById(existing[0].id);
  }

  const result = await query(
    `INSERT INTO focus_handouts
       (student_id, subject_id, tutor_id, submission_id, assessment_id, title, summary,
        content_text, weak_topics_json, overall_percentage, source, generated_by, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pre_assessment', ?, 'active')`,
    [
      studentId, subjectId, tutor?.tutor_id || null, submissionId, assessmentId,
      title, summary, content, JSON.stringify(topics),
      Number(submission.percentage || 0), generatedBy
    ]
  );

  return getFocusHandoutById(result.insertId);
}

/**
 * Do the whole Pre-Assessment follow-up: build the handout, then tell the tutor.
 * Never throws — the caller is a student's submit handler.
 */
async function runPreAssessmentFollowUp(input = {}) {
  try {
    const handout = await generateFocusHandout(input);
    if (!handout) return null;

    if (handout.tutor_id) {
      const { createNotification } = require('./appNotifications');
      const studentName = [handout.first_name, handout.last_name].filter(Boolean).join(' ');
      await createNotification({
        type: 'focus_handout',
        title: `Focus area ready for ${studentName}`,
        message: `${studentName} finished the ${handout.subject_name} Pre-Assessment `
          + `(${Number(handout.overall_percentage || 0).toFixed(1)}%). `
          + `${handout.summary} Detailed results are in Analytics & Reports.`,
        linkUrl: `/tutor/focus-handouts/${handout.id}`,
        refType: 'focus_handout',
        refId: handout.id,
        userId: handout.tutor_id,
        severity: 'warning'
      }).catch((error) => console.error('[focusHandouts] could not notify the tutor:', error.message));
    }

    return handout;
  } catch (error) {
    console.error('[focusHandouts] follow-up failed:', error.message);
    return null;
  }
}

/** One focus handout with the names a page needs. */
async function getFocusHandoutById(id) {
  const rows = await query(
    `SELECT fh.*, s.name AS subject_name,
            u.first_name, u.middle_name, u.last_name, u.user_id AS student_code,
            u.year_level, u.grade_level, u.branch_id,
            t.first_name AS tutor_first_name, t.last_name AS tutor_last_name
     FROM focus_handouts fh
     JOIN subjects s ON s.id = fh.subject_id
     JOIN users u ON u.id = fh.student_id
     LEFT JOIN users t ON t.id = fh.tutor_id
     WHERE fh.id = ?`,
    [id]
  );
  const row = rows[0];
  if (!row) return null;
  return { ...row, weak_topics: safeTopics(row.weak_topics_json) };
}

function safeTopics(json) {
  try {
    const parsed = JSON.parse(json || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

/** Every focus handout flagged for one tutor. */
async function getFocusHandoutsForTutor(tutorId, filters = {}) {
  const params = [tutorId];
  let searchSql = '';
  const search = String(filters.search || '').trim().toLowerCase();
  if (search) {
    searchSql = `AND (LOWER(CONCAT(COALESCE(u.first_name,''), ' ', COALESCE(u.last_name,''))) LIKE ?
                 OR LOWER(s.name) LIKE ? OR LOWER(fh.title) LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const rows = await query(
    `SELECT fh.*, s.name AS subject_name,
            u.first_name, u.middle_name, u.last_name, u.user_id AS student_code
     FROM focus_handouts fh
     JOIN subjects s ON s.id = fh.subject_id
     JOIN users u ON u.id = fh.student_id
     WHERE fh.tutor_id = ? AND fh.is_archived = 0 ${searchSql}
     ORDER BY fh.tutor_viewed_at ASC, fh.created_at DESC`,
    params
  );
  return rows.map((row) => ({ ...row, weak_topics: safeTopics(row.weak_topics_json) }));
}

/** A student's own focus material, so they can revise the same topics. */
async function getFocusHandoutsForStudent(studentId) {
  const rows = await query(
    `SELECT fh.*, s.name AS subject_name,
            t.first_name AS tutor_first_name, t.last_name AS tutor_last_name
     FROM focus_handouts fh
     JOIN subjects s ON s.id = fh.subject_id
     LEFT JOIN users t ON t.id = fh.tutor_id
     WHERE fh.student_id = ? AND fh.is_archived = 0
     ORDER BY fh.created_at DESC`,
    [studentId]
  );
  return rows.map((row) => ({ ...row, weak_topics: safeTopics(row.weak_topics_json) }));
}

/** Branch- or system-wide list, for the admin analytics view. */
async function getFocusHandouts(scope, filters = {}) {
  const { studentScopeClause } = require('./rbac');
  const scoped = studentScopeClause(scope, 'u');
  const params = [...scoped.params];
  let searchSql = '';
  const search = String(filters.search || '').trim().toLowerCase();
  if (search) {
    searchSql = `AND (LOWER(CONCAT(COALESCE(u.first_name,''), ' ', COALESCE(u.last_name,''))) LIKE ?
                 OR LOWER(s.name) LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`);
  }
  const rows = await query(
    `SELECT fh.*, s.name AS subject_name,
            u.first_name, u.middle_name, u.last_name, u.user_id AS student_code,
            t.first_name AS tutor_first_name, t.last_name AS tutor_last_name
     FROM focus_handouts fh
     JOIN subjects s ON s.id = fh.subject_id
     JOIN users u ON u.id = fh.student_id
     LEFT JOIN users t ON t.id = fh.tutor_id
     WHERE fh.is_archived = 0 ${scoped.sql} ${searchSql}
     ORDER BY fh.created_at DESC`,
    params
  );
  return rows.map((row) => ({ ...row, weak_topics: safeTopics(row.weak_topics_json) }));
}

/** Record that the tutor has actually opened it. */
async function markTutorViewed(id, tutorId) {
  await query(
    `UPDATE focus_handouts
        SET tutor_viewed_at = COALESCE(tutor_viewed_at, DATEADD(hour, 8, GETUTCDATE())),
            updated_at = DATEADD(hour, 8, GETUTCDATE())
      WHERE id = ? AND tutor_id = ?`,
    [id, tutorId]
  );
}

/** How many focus handouts a tutor has not opened yet. */
async function countUnviewedForTutor(tutorId) {
  const rows = await query(
    'SELECT COUNT(*) AS total FROM focus_handouts WHERE tutor_id = ? AND is_archived = 0 AND tutor_viewed_at IS NULL',
    [tutorId]
  );
  return Number(rows[0]?.total || 0);
}

module.exports = {
  WEAK_THRESHOLD,
  MAX_TOPICS,
  rankWeakAreas,
  buildTemplateContent,
  findAssignedTutor,
  generateFocusHandout,
  runPreAssessmentFollowUp,
  getFocusHandoutById,
  getFocusHandoutsForTutor,
  getFocusHandoutsForStudent,
  getFocusHandouts,
  markTutorViewed,
  countUnviewedForTutor
};
