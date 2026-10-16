/**
 * File: lib/handoutAccess.js
 * Purpose: Who may open a module handout file — one rule for every way in.
 *
 * Staff (admin, assistant, tutor) are not gated. A student may open a handout
 * only when they are enrolled in its subject, have finished that subject's
 * Pre-Assessment, and the module is for their grade (spec Section 6: the lock is
 * enforced on the server, not by hiding links). Once their month in the subject
 * is over, a handout or a module added after it ended is not theirs either
 * (lib/postWindow.js, addedInMonth).
 *
 * The rule used to live inside server.js, in front of /uploads/handouts only.
 * /download?path=/uploads/handouts/... served the same file to anyone logged in,
 * with none of these checks — the lock and the grade rule could be walked round
 * by asking for the file through the other door.
 */

const { monthOf, addedInMonth } = require('./postWindow');

/**
 * @param {object} user        the session user
 * @param {string} filePath    '/uploads/handouts/<file>'
 * @returns {Promise<{ok: true} | {ok: false, status: number, message: string}>}
 */
async function checkHandoutAccess(user, filePath) {
  if (!user) return { ok: false, status: 401, message: 'Unauthorized. Please log in to open study material.' };
  if (user.role !== 'student') return { ok: true };

  const {
    getModuleHandoutByPath, getStudentAssignments,
    hasCompletedPreAssessment, moduleTargetsStudent, getUserById
  } = require('./data');

  const handout = await getModuleHandoutByPath(filePath);
  if (!handout) return { ok: false, status: 404, message: 'Handout not found.' };

  const assignments = await getStudentAssignments(user.id);
  const assignment = assignments.find((a) => Number(a.subject_id) === Number(handout.subject_id));
  if (!assignment) {
    return { ok: false, status: 403, message: 'You are not enrolled in this subject.' };
  }
  const month = monthOf(assignment);
  if (!addedInMonth(handout.created_at, month) || !addedInMonth(handout.module_created_at, month)) {
    return { ok: false, status: 404, message: 'Handout not found.' };
  }

  if (!(await hasCompletedPreAssessment(user.id, handout.subject_id))) {
    return { ok: false, status: 403, message: 'Complete the Pre-Assessment for this subject before opening its handouts.' };
  }

  // Read from the database, not the session: the session copy carries no
  // year_level/grade_level, and this check would turn every student away.
  const studentRecord = await getUserById(user.id);
  if (!moduleTargetsStudent(handout, studentRecord)) {
    return { ok: false, status: 403, message: 'This module is not assigned to your year level.' };
  }
  return { ok: true };
}

module.exports = { checkHandoutAccess };
