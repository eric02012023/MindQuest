/**
 * File: lib/violations.js
 * Purpose: The anti-cheating log for an assessment sitting.
 *
 * The browser cannot be trusted to count strikes: a student who reloads the page,
 * or edits the counter in devtools, would start again from zero. So the count the
 * warning modals act on is the one this file returns — the server's count of rows
 * for that (assessment, student) pair. The client asks after every event and does
 * what it is told.
 *
 * `session_key` groups the violations of one sitting. It exists so a student who
 * legitimately re-opens an assessment they never submitted is not instantly
 * auto-submitted by yesterday's three strikes; the strike count the modals use is
 * per sitting, while Analytics reports the lifetime total.
 */

const { query } = require('../config/db');

/** How many strikes before the sitting is submitted for them. */
const MAX_VIOLATIONS = 3;

/** The events the client is allowed to report. Anything else is stored as 'other'. */
const VIOLATION_TYPES = {
  tab_switch: 'Switched away from the assessment tab',
  window_blur: 'Left the assessment window',
  fullscreen_exit: 'Left full screen',
  copy: 'Copied text out of the assessment',
  paste: 'Pasted text into the assessment',
  context_menu: 'Opened the right-click menu',
  devtools: 'Tried to open developer tools',
  print: 'Tried to print the assessment',
  other: 'Suspicious activity'
};

function describe(type) {
  return VIOLATION_TYPES[type] || VIOLATION_TYPES.other;
}

/**
 * Record one violation and return the authoritative counts.
 *
 * @param {object} input
 * @param {number} input.assessmentId  tutor_assessments.id
 * @param {number} input.studentId
 * @param {string} input.type
 * @param {string} [input.detail]
 * @param {string} [input.sessionKey]  one sitting
 * @returns {Promise<{sessionCount:number, totalCount:number, limit:number,
 *                    shouldAutoSubmit:boolean, label:string}>}
 */
async function recordViolation(input = {}) {
  const {
    assessmentId, studentId, type = 'other', detail = null, sessionKey = null
  } = input;

  const safeType = Object.prototype.hasOwnProperty.call(VIOLATION_TYPES, type) ? type : 'other';

  // Count first so violation_number on the row is the strike number it was.
  const priorRows = await query(
    `SELECT COUNT(*) AS total
     FROM assessment_violations
     WHERE assessment_id = ? AND student_id = ? AND submission_id IS NULL
       AND (? IS NULL OR session_key = ?)`,
    [assessmentId, studentId, sessionKey, sessionKey]
  );
  const strike = Number(priorRows[0]?.total || 0) + 1;

  await query(
    `INSERT INTO assessment_violations
       (assessment_id, student_id, session_key, violation_type, violation_detail, violation_number)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      assessmentId, studentId,
      sessionKey ? String(sessionKey).slice(0, 80) : null,
      safeType,
      detail ? String(detail).slice(0, 500) : describe(safeType),
      strike
    ]
  );

  const totalRows = await query(
    'SELECT COUNT(*) AS total FROM assessment_violations WHERE assessment_id = ? AND student_id = ?',
    [assessmentId, studentId]
  );

  return {
    sessionCount: strike,
    totalCount: Number(totalRows[0]?.total || 0),
    limit: MAX_VIOLATIONS,
    shouldAutoSubmit: strike >= MAX_VIOLATIONS,
    label: describe(safeType)
  };
}

/**
 * Attach the sitting's violations to the submission it produced.
 * Called right after a submit so the tutor's view can say "3 violations, ended
 * automatically" against that exact attempt.
 */
async function attachToSubmission({ assessmentId, studentId, submissionId, sessionKey = null }) {
  await query(
    `UPDATE assessment_violations
        SET submission_id = ?
      WHERE assessment_id = ? AND student_id = ? AND submission_id IS NULL
        AND (? IS NULL OR session_key = ?)`,
    [submissionId, assessmentId, studentId, sessionKey, sessionKey]
  );

  const rows = await query(
    'SELECT COUNT(*) AS total FROM assessment_violations WHERE submission_id = ?',
    [submissionId]
  );
  const total = Number(rows[0]?.total || 0);

  await query(
    'UPDATE tutor_assessment_submissions SET violation_count = ? WHERE id = ?',
    [total, submissionId]
  );

  return total;
}

/** Mark a submission as one the system ended, with the reason. */
async function markAutoSubmitted(submissionId, reason) {
  await query(
    'UPDATE tutor_assessment_submissions SET is_auto_submitted = 1, auto_submit_reason = ? WHERE id = ?',
    [String(reason || 'anti_cheat_limit').slice(0, 120), submissionId]
  );
}

/** Every violation for one submission, for the result / analytics view. */
async function getViolationsForSubmission(submissionId) {
  return query(
    `SELECT * FROM assessment_violations WHERE submission_id = ? ORDER BY occurred_at ASC, id ASC`,
    [submissionId]
  );
}

/** The open (unsubmitted) strike count for a sitting, so a reload resumes it. */
async function getSessionCount(assessmentId, studentId, sessionKey = null) {
  const rows = await query(
    `SELECT COUNT(*) AS total
     FROM assessment_violations
     WHERE assessment_id = ? AND student_id = ? AND submission_id IS NULL
       AND (? IS NULL OR session_key = ?)`,
    [assessmentId, studentId, sessionKey, sessionKey]
  );
  return Number(rows[0]?.total || 0);
}

module.exports = {
  MAX_VIOLATIONS,
  VIOLATION_TYPES,
  describe,
  recordViolation,
  attachToSubmission,
  markAutoSubmitted,
  getViolationsForSubmission,
  getSessionCount
};
