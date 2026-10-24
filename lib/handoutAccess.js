

const { monthOf, addedInMonth } = require('./postWindow');

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

  
  
  const studentRecord = await getUserById(user.id);
  if (!moduleTargetsStudent(handout, studentRecord)) {
    return { ok: false, status: 403, message: 'This module is not assigned to your year level.' };
  }
  return { ok: true };
}

module.exports = { checkHandoutAccess };
