

const { query } = require('../config/db');


const MAX_VIOLATIONS = 3;


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


async function recordViolation(input = {}) {
  const {
    assessmentId, studentId, type = 'other', detail = null, sessionKey = null
  } = input;

  const safeType = Object.prototype.hasOwnProperty.call(VIOLATION_TYPES, type) ? type : 'other';

  
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


async function markAutoSubmitted(submissionId, reason) {
  await query(
    'UPDATE tutor_assessment_submissions SET is_auto_submitted = 1, auto_submit_reason = ? WHERE id = ?',
    [String(reason || 'anti_cheat_limit').slice(0, 120), submissionId]
  );
}


async function getViolationsForSubmission(submissionId) {
  return query(
    `SELECT * FROM assessment_violations WHERE submission_id = ? ORDER BY occurred_at ASC, id ASC`,
    [submissionId]
  );
}


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
