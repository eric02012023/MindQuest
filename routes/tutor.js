/**
 * ANNOTATED COPY FOR DEFENSE REVIEW
 * File: routes/tutor.js
 * Purpose: Tutor dashboard routes. This file handles assigned students, attendance, resources, assessments, messaging, schedule handling, and tutor profile management.
 * Notes: Comments were added to help explain the system during code defense without changing the original logic.
 */

const express = require('express');
const { authorize, setFlash } = require('../middleware/auth');
const { createUploader } = require('../lib/uploads');
const {
  getTutorDashboardData,
  getTutorAssignments,
  getTutorAssignedSubjects,
  getTutorSubjectsWithStudents,
  getTutorStudentsBySubject,
  getAdminSubjectResources,
  getTutorSharedResources,
  shareAdminResourceToStudents,
  deleteSubjectResource,
  saveAttendance,
  getAttendanceByTutor,
  getAllowedContacts,
  getConversation,
  saveMessage,
  getMessageById,
  updateMessageBody,
  unsendMessage,
  getUserById,
  updateUser,
  getAssessments,
  getAssessmentHistory,
  getAssessmentById,
  getAssessmentTemplates,
  assignAssessmentTemplateToStudents,
  markAssessmentDone,
  recoverAssessment,
  deleteAssessmentPermanently,
  getTutorScheduleNotifications,
  acceptTutorScheduleApplication,
  cancelTutorScheduleApplication,
  finishTutorScheduleApplication,
  getTutorScheduleOverview,
  // Phase 7: AI system imports
  getStudentAnalytics,
  getStudentAssignments,
  // Phase 3: analytics
  getTutorStudentsForAnalytics,
  getAttendanceBySubject,
  // Phase 5: Modules & Assessments
  getModulesBySubject,
  getModuleBySubjectAndLevel,
  createTutorAssessment,
  getTutorAssessmentsByModule,
  getSubmissionsByAssessment,
  getTutorAssessmentById,
  getTutorStudentResults,
  // Module -> Handout -> Assessment overhaul (Phase 6)
  getSubjectModules,
  getSubjectSubmissions,
  getSubmissionWithAnswers,
  getWeakAreasForSubmission,
  // Tutor module assessments (Phase 7)
  getModuleById,
  getModuleHandouts,
  getModuleHandoutTexts,
  // Post-Assessment (Phase 8)
  getPostAssessment,
  getSubjectPrePostComparison,
  getSubjectPostReadiness,
  createPostAssessmentFromPre
} = require('../lib/data');
const { normalizeArray } = require('../lib/utils');
const { generateAssessmentFromHandouts, SPEC_QUESTION_TYPES } = require('../services/aiService');
const { TUTOR_ASSESSMENT_MIN_ITEMS, TUTOR_ASSESSMENT_MAX_ITEMS } = require('../config/assessmentDefaults');

const YEAR_LEVEL_OPTIONS = ['Pre School Level', 'Primary Level', 'Junior High Level', 'Senior High Level'];
const GRADE_LEVEL_MAP = {
  'Pre School Level': ['Nursery', 'Kinder'],
  'Primary Level': ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6'],
  'Junior High Level': ['Grade 7', 'Grade 8', 'Grade 9', 'Grade 10'],
  'Senior High Level': ['Grade 11', 'Grade 12']
};

const router = express.Router();
const profileUploader = createUploader('profiles');
const messageUploader = createUploader('messages');
const resourceUploader = createUploader('resources');

router.use(authorize(['tutor']));

// Function: buildShell

// Role: Handles a reusable server-side operation used by this module.

async function buildShell(req, extra = {}) {
  // Phase 9: the bell used to merge pending assessment_requests in beside the
  // schedule notifications. With the request/approve loop retired there is
  // nothing to act on, and a badge counting rows no page can respond to is worse
  // than no badge.
  const allNotifications = await getTutorScheduleNotifications(req.session.user.id);
  return {
    pageTitle: extra.pageTitle || 'Tutor Dashboard',
    roleName: 'Tutor',
    basePath: '/tutor',
    section: extra.section || 'dashboard',
    contentView: extra.contentView,
    currentUser: req.session.user,
    notificationCount: allNotifications.length,
    inboxNotifications: allNotifications,
    ...extra
  };
}

// Route handler: GET request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.get('/', async (req, res, next) => {
  try {
    const dashboard = await getTutorDashboardData(req.session.user.id);
    const shell = await buildShell(req, {
      pageTitle: 'Tutor Dashboard',
      section: 'dashboard',
      contentView: '../content/tutor-dashboard',
      dashboard
    });
    res.render('shells/dashboard', shell);
  } catch (error) {
    next(error);
  }
});

// Route handler: GET request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.get('/students', async (req, res, next) => {
  try {
    const students = await getTutorStudentsBySubject(req.session.user.id, req.query.subject || null);
    const shell = await buildShell(req, {
      pageTitle: 'My Students',
      section: 'students',
      contentView: '../content/tutor-students',
      students
    });
    res.render('shells/dashboard', shell);
  } catch (error) {
    next(error);
  }
});


// Route handler: GET request


// Purpose: Processes this endpoint and returns the correct view or action result.


router.get('/students/:studentId', async (req, res, next) => {
  try {
    const { query: dbQuery } = require('../config/db');
    const assignmentCheck = await dbQuery(
      `SELECT usa.student_id, usa.subject_id, s.name AS subject_name
       FROM user_subject_assignments usa
       INNER JOIN subjects s ON s.id = usa.subject_id
       WHERE usa.tutor_id = ? AND usa.student_id = ? AND usa.is_archived = 0`,
      [req.session.user.id, req.params.studentId]
    );
    if (!assignmentCheck.length) {
      setFlash(req, 'error', 'Student not found in your assigned list.');
      return res.redirect('/tutor/students');
    }
    // Get student basic info + attendance + assessments
    const student = await getUserById(req.params.studentId);
    if (!student) {
      setFlash(req, 'error', 'Student not found.');
      return res.redirect('/tutor/students');
    }
    // Get attendance for shared subjects
    const attendanceLogs = [];
    for (const a of assignmentCheck) {
      const logs = await getAttendanceBySubject(req.params.studentId, a.subject_id);
      attendanceLogs.push(...logs.map(l => ({ ...l, subject_name: a.subject_name })));
    }
    // Get assessments for this student
    const [assessments, assessmentHistory] = await Promise.all([
      getAssessments(null),
      getAssessmentHistory(null)
    ]);
    const studentAssessments = assessments.filter(a => Number(a.assigned_student_id) === Number(req.params.studentId));
    const studentAssessmentHistory = assessmentHistory.filter(a => Number(a.assigned_student_id) === Number(req.params.studentId));
    
    const generatedModules = await dbQuery(
      `SELECT * FROM subject_resources WHERE module_origin = 'ai_generated' AND assigned_student_id = ? AND is_archived = 0`,
      [req.params.studentId]
    );

    const shell = await buildShell(req, {
      pageTitle: `${student.first_name} ${student.last_name}`,
      section: 'students',
      contentView: '../content/tutor-student-profile',
      student,
      subjects: assignmentCheck,
      attendanceLogs,
      studentAssessments,
      studentAssessmentHistory,
      generatedModules
    });
    res.render('shells/dashboard', shell);
  } catch (error) { next(error); }
});

// Route handler: POST request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.post('/notifications/:id/accept', async (req, res, next) => {
  try {
    await acceptTutorScheduleApplication(Number(req.params.id), req.session.user.id);
    setFlash(req, 'success', 'Student schedule application accepted.');
    res.redirect('back');
  } catch (error) {
    setFlash(req, 'error', error.message || 'Could not accept application.');
    res.redirect('back');
  }
});

// Route handler: POST request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.post('/notifications/:id/cancel', async (req, res, next) => {
  try {
    await cancelTutorScheduleApplication(Number(req.params.id), req.session.user.id);
    setFlash(req, 'success', 'Schedule application cancelled.');
    res.redirect('back');
  } catch (error) {
    setFlash(req, 'error', error.message || 'Could not cancel application.');
    res.redirect('back');
  }
});

// Route handler: POST request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.post('/schedule/:id/finish', async (req, res, next) => {
  try {
    await finishTutorScheduleApplication(Number(req.params.id), req.session.user.id);
    setFlash(req, 'success', 'Session marked as finished. Time slot is now available.');
    res.redirect('back');
  } catch (error) {
    setFlash(req, 'error', error.message || 'Could not finish session.');
    res.redirect('back');
  }
});

// Route handler: GET request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.get('/subjects', async (req, res, next) => {
  try {
    const [subjects, scheduleOverview] = await Promise.all([getTutorAssignedSubjects(req.session.user.id), getTutorScheduleOverview(req.session.user.id)]);
    const shell = await buildShell(req, {
      pageTitle: 'My Subjects',
      section: 'subjects',
      contentView: '../content/tutor-subjects',
      subjects,
      scheduleOverview
    });
    res.render('shells/dashboard', shell);
  } catch (error) {
    next(error);
  }
});

// Route handler: GET request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.get('/subjects/:subjectId', async (req, res, next) => {
  try {
    const [students, subjectOptions, adminResources] = await Promise.all([
      getTutorStudentsBySubject(req.session.user.id, req.params.subjectId),
      getTutorAssignedSubjects(req.session.user.id),
      getAdminSubjectResources(req.params.subjectId)
    ]);
    const currentSubject = subjectOptions.find((item) => Number(item.subject_id) === Number(req.params.subjectId));
    if (!currentSubject) {
      setFlash(req, 'error', 'Subject not found in your assigned subjects.');
      return res.redirect('/tutor/subjects');
    }
    const shell = await buildShell(req, {
      pageTitle: currentSubject.subject_name || 'Subject Details',
      section: 'subjects',
      contentView: '../content/tutor-subject-detail',
      subjectId: req.params.subjectId,
      students,
      adminResources,
      // Module system (overhaul Phase 6): the modules Admin set up, and how each
      // student did on the generated Pre-Assessment.
      modules: await getSubjectModules(req.params.subjectId),
      preResults: await getSubjectSubmissions(req.params.subjectId, { kind: 'pre_assessment' }),
      // Post-Assessment (Phase 8): who is ready for it, and pre-vs-post once taken.
      postAssessment: await getPostAssessment(req.params.subjectId),
      comparisons: await getSubjectPrePostComparison(req.params.subjectId),
      readiness: await getSubjectPostReadiness(req.params.subjectId)
    });
    res.render('shells/dashboard', shell);
  } catch (error) {
    next(error);
  }
});

// Route handler: POST request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.post('/subjects/:subjectId/resources/share', async (req, res, next) => {
  try {
    const students = await getTutorStudentsBySubject(req.session.user.id, req.params.subjectId);
    const allowed = new Set(students.map((s) => Number(s.student_id || s.id)));
    const selectedIds = Array.isArray(req.body.assigned_student_ids) ? req.body.assigned_student_ids : [req.body.assigned_student_ids];
    const assignedStudentIds = [...new Set(selectedIds.map((value) => Number(value)).filter(Boolean))];
    if (!assignedStudentIds.length || assignedStudentIds.some((id) => !allowed.has(id))) {
      setFlash(req, 'error', 'You can only post modules to your assigned students.');
      return res.redirect(`/tutor/subjects/${req.params.subjectId}`);
    }
    await shareAdminResourceToStudents(req.body.resource_id, req.session.user.id, assignedStudentIds);
    setFlash(req, 'success', 'Admin module posted to selected students.');
    res.redirect(`/tutor/subjects/${req.params.subjectId}`);
  } catch (error) {
    next(error);
  }
});

// Phase 5: Tutor publishes an AI assessment from a module
router.post('/subjects/:subjectId/modules/:resourceId/publish-assessment', async (req, res, next) => {
  const subjectId = parseInt(req.params.subjectId, 10);
  const resourceId = parseInt(req.params.resourceId, 10);
  const tutorUserId = parseInt(req.session.user.id, 10);
  try {
    const { query: dbQuery } = require('../config/db');
    const { generateAssessmentFromModule } = require('../services/aiService');
    const { getSubjectById, logAiGeneration } = require('../lib/data');

    if (isNaN(subjectId) || isNaN(resourceId) || isNaN(tutorUserId)) {
      setFlash(req, 'error', 'Invalid request parameters.');
      return res.redirect(`/tutor/subjects/${req.params.subjectId}`);
    }

    const itemCount = Number(req.body.item_count) || 10;
    if (itemCount < 5 || itemCount > 50) {
      setFlash(req, 'error', 'Please enter a valid number of items (5–50).');
      return res.redirect(`/tutor/subjects/${subjectId}`);
    }

    const moduleRows = await dbQuery('SELECT TOP 1 * FROM subject_resources WHERE id = ?', [resourceId]);
    if (!moduleRows.length) {
      setFlash(req, 'error', 'Module not found.');
      return res.redirect(`/tutor/subjects/${subjectId}`);
    }
    const mod = moduleRows[0];
    let moduleContent = mod.content_text || mod.description || '';
    if (!moduleContent && mod.source_resource_id) {
      const src = await dbQuery('SELECT TOP 1 * FROM subject_resources WHERE id = ?', [parseInt(mod.source_resource_id, 10)]);
      if (src.length) moduleContent = src[0].content_text || src[0].description || '';
    }

    const subject = await getSubjectById(subjectId);
    if (!subject) {
      setFlash(req, 'error', 'Subject not found.');
      return res.redirect(`/tutor/subjects/${subjectId}`);
    }

    const aiResult = await generateAssessmentFromModule({
      moduleContent,
      subject: subject.name,
      levelGroup: mod.type_of_module || 'General',
      questionCount: itemCount
    });

    const tutorStudents = await getTutorStudentsBySubject(tutorUserId, subjectId);
    if (!tutorStudents.length) {
      setFlash(req, 'error', 'No students assigned to you in this subject.');
      return res.redirect(`/tutor/subjects/${subjectId}`);
    }

    const title = `AI Assessment: ${mod.title || subject.name}`;
    for (const student of tutorStudents) {
      const studentId = parseInt(student.student_id, 10);
      const insertResult = await dbQuery(
        `INSERT INTO assessments (title, assessment_type, assigned_student_id, created_by, is_published, subject_id, assessment_origin, source_module_title, source_resource_id)
         VALUES (?, 'post', ?, ?, 1, ?, 'ai_generated', ?, ?)`,
        [title, studentId, tutorUserId, subjectId, mod.title || null, parseInt(mod.id, 10)]
      );
      const assessmentId = insertResult.insertId;
      for (const q of aiResult.questions) {
        await dbQuery(
          `INSERT INTO assessment_questions (assessment_id, question_text, choice_a, choice_b, choice_c, choice_d, correct_answer, question_type, points)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [assessmentId, q.question_text, q.choice_a || '', q.choice_b || '', q.choice_c || '', q.choice_d || '', q.correct_answer, q.question_type || 'Multiple Choice', q.points || 1]
        );
      }
    }

    try {
      await logAiGeneration({ student_id: parseInt(tutorStudents[0].student_id, 10), subject_id: subjectId, generation_type: 'tutor_publish_assessment', provider: aiResult.provider, model: aiResult.model, tokens_used: aiResult.tokensUsed });
    } catch(e) { /* non-critical */ }

    setFlash(req, 'success', `AI Assessment published to ${tutorStudents.length} student(s) with ${aiResult.questions.length} items!`);
    res.redirect(`/tutor/subjects/${subjectId}`);
  } catch (error) {
    setFlash(req, 'error', error.message || 'Could not publish assessment.');
    res.redirect(`/tutor/subjects/${subjectId}`);
  }
});

// --------------------------------------------------------------------------
// Create the Post-Assessment (overhaul Phase 8, acceptance item 12)
//
// It is a verbatim copy of the subject's Pre-Assessment — same questions, same
// choices, same answers, same source attribution — so the pre-vs-post comparison
// measures the student, not a different exam.
// --------------------------------------------------------------------------
router.post('/subjects/:subjectId/create-post-assessment', async (req, res, next) => {
  const subjectId = Number(req.params.subjectId);
  try {
    const assigned = await getTutorAssignedSubjects(req.session.user.id);
    if (!assigned.some((a) => Number(a.subject_id) === subjectId)) {
      setFlash(req, 'error', 'That subject is not assigned to you.');
      return res.redirect('/tutor/subjects');
    }

    // At least one student must have finished the cycle. Opening it for a class
    // where nobody is done would let a student sit the same questions again
    // before doing any of the material in between.
    const readiness = await getSubjectPostReadiness(subjectId);
    if (!readiness.readyCount) {
      setFlash(req, 'error', 'No student has finished all the modules and activities yet.');
      return res.redirect(`/tutor/subjects/${subjectId}`);
    }

    const result = await createPostAssessmentFromPre(subjectId, req.session.user.id);
    setFlash(req, result.created ? 'success' : 'info', result.created
      ? `Post-Assessment created with the same ${result.question_count} items as the Pre-Assessment. ${readiness.readyCount} student(s) can take it now.`
      : 'This subject already has a Post-Assessment.');
    res.redirect(`/tutor/subjects/${subjectId}`);
  } catch (error) {
    setFlash(req, 'error', error.message || 'Could not create the Post-Assessment.');
    res.redirect(`/tutor/subjects/${subjectId}`);
  }
});

// Phase 9: POST /subjects/:id/post-consolidated-assessment was removed.
//
// It generated one AI assessment over every legacy admin resource in a subject and
// pushed it to all students, advancing a student_learning_cycles row. It competed
// directly with the real Post-Assessment from Phase 8, which reuses the
// Pre-Assessment items so the before-and-after actually compares. Two buttons
// called "Post Assessment" doing different things is how the wrong one gets
// clicked during a demo.



// Route handler: POST request




// Purpose: Processes this endpoint and returns the correct view or action result.




router.post('/resources/:resourceId/delete', async (req, res, next) => {
  try {
    await deleteSubjectResource(req.params.resourceId, req.session.user.id);
    setFlash(req, 'success', 'Resource deleted successfully.');
    res.redirect('back');
  } catch (error) {
    next(error);
  }
});

// Route handler: GET request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.get('/attendance', async (req, res, next) => {
  try {
    const [attendanceLogs, tutorSubjects] = await Promise.all([
      getAttendanceByTutor(req.session.user.id),
      getTutorSubjectsWithStudents(req.session.user.id)
    ]);
    const selectedSubjectId = String(req.query.subject_id || '').trim();
    const selectedSubject = tutorSubjects.find((item) => String(item.id) === selectedSubjectId) || null;
    const students = selectedSubject
      ? selectedSubject.students.map((student) => ({ ...student, subject_id: selectedSubject.id, subject_name: selectedSubject.name }))
      : [];
    const shell = await buildShell(req, {
      pageTitle: 'Attendance',
      section: 'attendance',
      contentView: '../content/tutor-attendance',
      attendanceLogs,
      tutorSubjects,
      students,
      selectedSubjectId
    });
    res.render('shells/dashboard', shell);
  } catch (error) { next(error); }
});

// Route handler: POST request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.post('/attendance', async (req, res, next) => {
  try {
    const selectedPairs = Array.isArray(req.body.selected_student) ? req.body.selected_student : [req.body.selected_student];
    const attendanceDate = req.body.attendance_date;
    const selectedSubjectId = String(req.body.subject_id || '').trim();
    if (!selectedPairs.filter(Boolean).length) {
      setFlash(req, 'error', 'Please select at least one student to mark attendance.');
      return res.redirect(selectedSubjectId ? `/tutor/attendance?subject_id=${encodeURIComponent(selectedSubjectId)}` : '/tutor/attendance');
    }
    const statusMap = req.body.status || {};
    for (const pair of selectedPairs.filter(Boolean)) {
      const [studentId, subjectId] = String(pair).split(':');
      await saveAttendance(req.session.user.id, subjectId, attendanceDate, [{ student_id: studentId, status: statusMap[pair] || 'present' }]);
    }
    setFlash(req, 'success', 'Attendance saved successfully.');
    res.redirect(selectedSubjectId ? `/tutor/attendance?subject_id=${encodeURIComponent(selectedSubjectId)}` : '/tutor/attendance');
  } catch (error) { next(error); }
});


// Route handler: GET request


// Purpose: Processes this endpoint and returns the correct view or action result.


router.get('/assessments', async (req, res, next) => {
  try {
    const students = await getTutorStudentsBySubject(req.session.user.id);
    const studentIds = [...new Set(students.map((s) => Number(s.student_id)).filter(Boolean))];
    const subjectIds = [...new Set(students.map((s) => Number(s.subject_id)).filter(Boolean))];
    const [assessments, assessmentHistory, templates] = await Promise.all([
      getAssessments(null),
      getAssessmentHistory(null),
      Promise.all(subjectIds.map((id) => getAssessmentTemplates(id))).then((sets) => sets.flat())
    ]);
    const allowed = new Set(studentIds);
    const uniqueTemplates = Array.from(new Map(templates.map((item) => [item.id, item])).values());
    const shell = await buildShell(req, {
      pageTitle: 'Assessments',
      section: 'assessments',
      contentView: '../content/admin-assessments',
      assessments: assessments.filter((a) => allowed.has(Number(a.assigned_student_id))),
      assessmentHistory: assessmentHistory.filter((a) => allowed.has(Number(a.assigned_student_id))),
      students,
      templates: uniqueTemplates,
      templateStudentMap: {},
      yearLevelOptions: YEAR_LEVEL_OPTIONS,
      gradeLevelMap: GRADE_LEVEL_MAP,
      subjects: [],
      viewOnly: false,
      canCreateTemplate: false,
      tutorBranchName: (await getUserById(req.session.user.id))?.branch_name || ''
    });
    res.render('shells/dashboard', shell);
  } catch (error) { next(error); }
});


// Route handler: GET request


// Purpose: Processes this endpoint and returns the correct view or action result.


router.get('/assessments/:id', async (req, res, next) => {
  try {
    const assessment = await getAssessmentById(req.params.id);
    if (!assessment) {
      setFlash(req, 'error', 'Assessment not found.');
      return res.redirect('/tutor/assessments');
    }
    const students = await getTutorStudentsBySubject(req.session.user.id);
    const allowed = new Set(students.map((s) => Number(s.student_id || s.id)));
    if (!allowed.has(Number(assessment.assigned_student_id))) {
      setFlash(req, 'error', 'You can only view assessments for your assigned students.');
      return res.redirect('/tutor/assessments');
    }
    const shell = await buildShell(req, {
      pageTitle: 'Assessment Details',
      section: 'assessments',
      contentView: '../content/admin-assessment-detail',
      assessment
    });
    res.render('shells/dashboard', shell);
  } catch (error) {
    next(error);
  }
});

// Route handler: POST request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.post('/assessments/templates/:templateId/assign', async (req, res, next) => {
  try {
    const students = await getTutorStudentsBySubject(req.session.user.id);
    const selectedIds = Array.isArray(req.body.assigned_student_ids) ? req.body.assigned_student_ids : [req.body.assigned_student_ids];
    const assignedStudentIds = [...new Set(selectedIds.map((value) => Number(value)).filter(Boolean))];
    const allowed = new Set(students.map((s) => Number(s.student_id || s.id)));
    if (!assignedStudentIds.length || assignedStudentIds.some((id) => !allowed.has(id))) {
      setFlash(req, 'error', 'You can only send assessments to your assigned students.');
      return res.redirect('/tutor/assessments');
    }
    const firstStudent = students.find((s) => Number(s.student_id || s.id) === assignedStudentIds[0]);
    await assignAssessmentTemplateToStudents(req.params.templateId, req.session.user.id, assignedStudentIds, firstStudent?.branch_id || req.session.user.branch_id || null);
    setFlash(req, 'success', 'Admin assessment sent to selected students.');
    res.redirect('/tutor/assessments');
  } catch (error) {
    next(error);
  }
});


// Route handler: POST request


// Purpose: Processes this endpoint and returns the correct view or action result.


router.post('/assessments/:id/done', async (req, res, next) => {
  try {
    const assessment = await getAssessmentById(req.params.id);
    const students = await getTutorStudentsBySubject(req.session.user.id);
    const allowed = new Set(students.map((s) => Number(s.student_id || s.id)));
    if (!assessment || !assessment.result || !allowed.has(Number(assessment.assigned_student_id))) {
      setFlash(req, 'error', 'Only completed assessments for your assigned students can be marked done.');
      return res.redirect('/tutor/assessments');
    }
    await markAssessmentDone(req.params.id);
    setFlash(req, 'success', 'Assessment moved to history.');
    res.redirect('/tutor/assessments');
  } catch (error) {
    next(error);
  }
});

// Route handler: POST request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.post('/assessments/:id/recover', async (req, res, next) => {
  try {
    await recoverAssessment(req.params.id);
    setFlash(req, 'success', 'Assessment recovered successfully.');
    res.redirect('/tutor/assessments');
  } catch (error) {
    next(error);
  }
});

// Route handler: POST request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.post('/assessments/:id/delete', async (req, res, next) => {
  try {
    await deleteAssessmentPermanently(req.params.id);
    setFlash(req, 'success', 'Assessment deleted permanently.');
    res.redirect('/tutor/assessments');
  } catch (error) {
    next(error);
  }
});

// Route handler: GET request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.get('/messages', async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim();
    const contacts = await getAllowedContacts(req.session.user, search);
    const activeContactId = req.query.contact ? Number(req.query.contact) : (search ? null : contacts[0]?.id || null);
    const activeContact = activeContactId ? await getUserById(activeContactId) : null;
    const conversation = activeContactId ? await getConversation(req.session.user.id, activeContactId) : [];
    const shell = await buildShell(req, {
      pageTitle: 'Message',
      section: 'messages',
      contentView: '../content/tutor-messages',
      contacts,
      activeContact,
      conversation,
      search
    });
    res.render('shells/dashboard', shell);
  } catch (error) {
    next(error);
  }
});

// Route handler: POST request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.post('/messages/send', messageUploader.single('attachment'), async (req, res, next) => {
  try {
    const body = String(req.body.body || '').trim();
    if (!body && !req.file) {
      setFlash(req, 'error', 'Type a message or attach a file.');
      return res.redirect(`/tutor/messages?contact=${req.body.receiver_id}`);
    }
    await saveMessage({
      sender_id: req.session.user.id,
      receiver_id: req.body.receiver_id,
      body,
      file_path: req.file ? `/uploads/messages/${req.file.filename}` : null,
      file_original_name: req.file ? req.file.originalname : null,
      file_type: req.file ? req.file.mimetype : ''
    });
    res.redirect(`/tutor/messages?contact=${req.body.receiver_id}`);
  } catch (error) {
    next(error);
  }
});

// Route handler: POST request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.post('/messages/:id/edit', async (req, res, next) => {
  try {
    const message = await getMessageById(req.params.id);
    if (!message || Number(message.sender_id) !== Number(req.session.user.id)) {
      setFlash(req, 'error', 'You can only edit your own message.');
      return res.redirect(`/tutor/messages?contact=${req.body.contact_id || req.query.contact || ''}`);
    }
    await updateMessageBody(message.id, req.body.body);
    res.redirect(`/tutor/messages?contact=${message.receiver_id === req.session.user.id ? message.sender_id : message.receiver_id}`);
  } catch (error) {
    next(error);
  }
});

// Route handler: POST request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.post('/messages/:id/unsend', async (req, res, next) => {
  try {
    const message = await getMessageById(req.params.id);
    if (!message || Number(message.sender_id) !== Number(req.session.user.id)) {
      setFlash(req, 'error', 'You can only unsend your own message.');
      return res.redirect(`/tutor/messages?contact=${req.body.contact_id || req.query.contact || ''}`);
    }
    await unsendMessage(message.id);
    res.redirect(`/tutor/messages?contact=${message.receiver_id === req.session.user.id ? message.sender_id : message.receiver_id}`);
  } catch (error) {
    next(error);
  }
});

// Route handler: GET request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.get('/profile', async (req, res, next) => {
  try {
    const [profileUser, students] = await Promise.all([
      getUserById(req.session.user.id),
      getTutorStudentsBySubject(req.session.user.id)
    ]);
    const shell = await buildShell(req, {
      pageTitle: 'Profile',
      section: 'profile',
      contentView: '../content/tutor-profile',
      profileUser,
      students
    });
    res.render('shells/dashboard', shell);
  } catch (error) {
    next(error);
  }
});

// Route handler: POST request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.post('/profile', profileUploader.single('image'), async (req, res, next) => {
  try {
    const current = await getUserById(req.session.user.id);
    await updateUser(req.session.user.id, {
      ...req.body,
      branch_id: current.branch_id,
      subjects: normalizeArray(req.body.subjects || current.subjects_json),
      supports: normalizeArray(req.body.supports || current.support_json),
      image_path: req.file ? `/uploads/profiles/${req.file.filename}` : null,
      extra: current.extra || {}
    });
    if (req.file) req.session.user.image_path = `/uploads/profiles/${req.file.filename}`;
    req.session.user.first_name = req.body.first_name || req.session.user.first_name;
    setFlash(req, 'success', 'Profile updated successfully.');
    res.redirect('/tutor/profile');
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// Phase 7: AI System — Tutor student analytics
// ============================================================================

// Tutor views student analytics across their shared subjects
router.get('/students/:studentId/analytics', async (req, res, next) => {
  try {
    // Direct DB check: is this student assigned to this tutor?
    const { query: dbQuery } = require('../config/db');
    const assignmentCheck = await dbQuery(
      `SELECT usa.student_id, usa.subject_id FROM user_subject_assignments usa
       WHERE usa.tutor_id = ? AND usa.student_id = ? AND usa.is_archived = 0`,
      [req.session.user.id, req.params.studentId]
    );
    if (!assignmentCheck.length) {
      setFlash(req, 'error', 'Student not found in your assigned list.');
      return res.redirect('/tutor/students');
    }

    // Get the student's assignments to find which subjects overlap
    const studentAssignments = await getStudentAssignments(req.params.studentId);
    const tutorSubjectIds = new Set(assignmentCheck.map((a) => Number(a.subject_id)));

    // Gather analytics for each overlapping subject
    const analyticsData = [];
    for (const assignment of studentAssignments) {
      if (tutorSubjectIds.has(Number(assignment.subject_id))) {
        const analytics = await getStudentAnalytics(req.params.studentId, assignment.subject_id);
        if (analytics) analyticsData.push(analytics);
      }
    }

    // Fallback: try first subject from assignments
    if (!analyticsData.length && studentAssignments.length) {
      const fallback = await getStudentAnalytics(req.params.studentId, studentAssignments[0].subject_id);
      if (fallback) analyticsData.push(fallback);
    }

    const primaryAnalytics = analyticsData[0] || null;
    if (!primaryAnalytics) {
      setFlash(req, 'error', 'No analytics data found for this student.');
      return res.redirect('/tutor/students');
    }

    const shell = await buildShell(req, {
      pageTitle: `Analytics: ${primaryAnalytics.student.first_name} ${primaryAnalytics.student.last_name}`,
      section: 'students',
      contentView: '../content/admin-student-analytics',
      analytics: primaryAnalytics
    });
    res.render('shells/dashboard', shell);
  } catch (error) {
    next(error);
  }
});

// Analytics & Reports used to be its own page. It listed the tutor's students
// and how they were doing — the same question Student Results answers, off the
// same submissions — so the two are one page now and this stays as a URL only.
router.get('/analytics', (req, res) => res.redirect('/tutor/student-results'));

// Phase 9: POST /assessment-requests/:id/accept and .../decline were removed.
//
// They were the tutor half of the Gen 1 loop — a student asked permission for an
// assessment, the tutor approved with an item count, and AI built a one-off exam
// against a legacy resource. The overhauled flow needs no approval step: the
// Pre-Assessment is generated from the subject handouts and served automatically,
// and the tutor writes their own module assessments up front.
// ==========================================================================
// Phase 5: Modules & Assessment Creation
// ==========================================================================

/**
 * Resolve a module the tutor is actually entitled to work on.
 *
 * Every module route below took the id straight from the URL, so any tutor could
 * open — and build an assessment on — any module in the system, including
 * subjects they do not teach. The check mirrors the one on /tutor/results/:id.
 *
 * Returns the module, or null after setting a flash and leaving the caller to
 * redirect.
 */
async function resolveTutorModule(req, moduleId) {
  const mod = await getModuleById(Number(moduleId));
  if (!mod) {
    setFlash(req, 'error', 'Module not found.');
    return null;
  }
  const assigned = await getTutorAssignedSubjects(req.session.user.id);
  if (!assigned.some((a) => Number(a.subject_id) === Number(mod.subject_id))) {
    setFlash(req, 'error', 'That module belongs to a subject you are not assigned to.');
    return null;
  }
  return mod;
}

// Tutor: View all assigned subjects and their modules
router.get('/modules', async (req, res, next) => {
  try {
    const subjects = await getTutorAssignedSubjects(req.session.user.id);
    const subjectsWithModules = [];
    for (const s of subjects) {
      // getSubjectModules, not the legacy getModulesBySubject: this is the
      // overhaul's shape — order_number, target year levels, handout and
      // assessment counts — and it is not capped at three levels per subject.
      subjectsWithModules.push({ ...s, modules: await getSubjectModules(s.subject_id) });
    }
    const shell = await buildShell(req, {
      pageTitle: 'Modules & Assessments',
      section: 'modules',
      contentView: '../content/tutor-modules',
      subjectsWithModules
    });
    res.render('shells/dashboard', shell);
  } catch (error) { next(error); }
});

// Tutor: View a specific module, its handouts and its assessments
router.get('/modules/:id', async (req, res, next) => {
  try {
    const mod = await resolveTutorModule(req, req.params.id);
    if (!mod) return res.redirect('/tutor/modules');

    const shell = await buildShell(req, {
      pageTitle: `Module ${mod.order_number} — ${mod.title}`,
      section: 'modules',
      contentView: '../content/tutor-module-detail',
      mod,
      handouts: await getModuleHandouts(mod.id),
      assessments: await getTutorAssessmentsByModule(mod.id)
    });
    res.render('shells/dashboard', shell);
  } catch (error) { next(error); }
});

// --------------------------------------------------------------------------
// Check the answers on one module assessment.
//
// The last step of the tutor's loop: they write an assessment on a module, the
// student answers it inside that module, and this page is where the tutor checks
// it. Guarded by resolveTutorModule, and the assessment must belong to that
// module — otherwise any assessment id in the URL would open here.
// --------------------------------------------------------------------------
router.get('/modules/:id/assessments/:assessmentId/submissions', async (req, res, next) => {
  try {
    const mod = await resolveTutorModule(req, req.params.id);
    if (!mod) return res.redirect('/tutor/modules');

    const assessments = await getTutorAssessmentsByModule(mod.id);
    const assessment = assessments.find((a) => Number(a.id) === Number(req.params.assessmentId));
    if (!assessment) {
      setFlash(req, 'error', 'That assessment does not belong to this module.');
      return res.redirect(`/tutor/modules/${mod.id}`);
    }

    const shell = await buildShell(req, {
      pageTitle: `${assessment.title} — Answers`,
      section: 'modules',
      contentView: '../content/tutor-assessment-submissions',
      mod,
      assessment,
      submissions: await getSubmissionsByAssessment(assessment.id)
    });
    res.render('shells/dashboard', shell);
  } catch (error) { next(error); }
});

// Tutor: Render assessment creation form
router.get('/modules/:id/create-assessment', async (req, res, next) => {
  try {
    const mod = await resolveTutorModule(req, req.params.id);
    if (!mod) return res.redirect('/tutor/modules');

    const shell = await buildShell(req, await createAssessmentViewData(req, mod));
    res.render('shells/dashboard', shell);
  } catch (error) { next(error); }
});

/**
 * The create-assessment form's data, shared by the empty form and the AI-drafted
 * one. `draftQuestions` prefills the builder; the tutor still edits and saves it
 * themselves, so the AI drafts but never publishes.
 */
async function createAssessmentViewData(req, mod, extra = {}) {
  const handouts = await getModuleHandouts(mod.id);
  return {
    pageTitle: 'Create Assessment',
    section: 'modules',
    contentView: '../content/tutor-create-assessment',
    mod,
    handouts,
    // Drafting needs text, and a scanned handout nobody has run "Read with AI" on
    // has none. Say so on the button rather than failing after the click.
    draftableHandouts: handouts.filter((h) => h.extracted_at && h.extracted_text),
    minItems: TUTOR_ASSESSMENT_MIN_ITEMS,
    maxItems: TUTOR_ASSESSMENT_MAX_ITEMS,
    draftQuestions: null,
    form: {},
    ...extra
  };
}

/**
 * Draft this module's assessment with AI (spec Section 4a, optional path).
 *
 * Reuses Phase 5's generator scoped to one module's handouts — no second
 * generator, no second prompt. The result is rendered back into the builder
 * rather than saved: the tutor reviews, edits and presses Create themselves.
 */
router.post('/modules/:id/draft-assessment', async (req, res, next) => {
  try {
    const mod = await resolveTutorModule(req, req.params.id);
    if (!mod) return res.redirect('/tutor/modules');

    const itemCount = Math.min(
      TUTOR_ASSESSMENT_MAX_ITEMS,
      Math.max(TUTOR_ASSESSMENT_MIN_ITEMS, Number(req.body.item_count) || 10)
    );
    const questionType = SPEC_QUESTION_TYPES.includes(req.body.question_type) ? req.body.question_type : 'mixed';

    const handoutTexts = await getModuleHandoutTexts(mod.id);
    if (!handoutTexts.length) {
      setFlash(req, 'error', 'This module has no handout with readable text yet, so there is nothing to draft from.');
      return res.redirect(`/tutor/modules/${mod.id}/create-assessment`);
    }

    let generated;
    try {
      generated = await generateAssessmentFromHandouts({
        handouts: handoutTexts,
        subject: mod.subject_name,
        itemCount,
        questionType
      });
    } catch (error) {
      setFlash(req, 'error', `Could not draft the assessment: ${error.message}`);
      return res.redirect(`/tutor/modules/${mod.id}/create-assessment`);
    }

    setFlash(req, 'success', `Drafted ${generated.questions.length} question(s). Review and edit them, then press Create Assessment.`);
    const shell = await buildShell(req, await createAssessmentViewData(req, mod, {
      draftQuestions: generated.questions,
      form: {
        title: String(req.body.title || '').trim() || `${mod.title} — Assessment`,
        instructions: String(req.body.instructions || '').trim(),
        question_type: questionType,
        item_count: itemCount
      }
    }));
    res.render('shells/dashboard', shell);
  } catch (error) { next(error); }
});

// Tutor: Submit new assessment (JSON payload)
router.post('/modules/:id/create-assessment', async (req, res, next) => {
  try {
    const mod = await resolveTutorModule(req, req.params.id);
    if (!mod) return res.redirect('/tutor/modules');

    const { title, instructions, questions } = req.body;
    const backToForm = `/tutor/modules/${mod.id}/create-assessment`;

    if (!title || !questions || !questions.length) {
      setFlash(req, 'error', 'A title and at least one question are required.');
      return res.redirect(backToForm);
    }

    let parsedQuestions = questions;
    if (typeof questions === 'string') {
      try { parsedQuestions = JSON.parse(questions); } catch (_e) {
        setFlash(req, 'error', 'Invalid question data format.');
        return res.redirect(backToForm);
      }
    }
    if (!Array.isArray(parsedQuestions) || !parsedQuestions.length) {
      setFlash(req, 'error', 'A title and at least one question are required.');
      return res.redirect(backToForm);
    }

    const questionType = SPEC_QUESTION_TYPES.includes(req.body.question_type) ? req.body.question_type : 'mixed';

    await createTutorAssessment({
      subject_id: mod.subject_id,
      module_id: mod.id,
      tutor_id: req.session.user.id,
      title: String(title).trim(),
      instructions: String(instructions || '').trim(),
      // `purpose` is the legacy column and its CHECK allows pre/activity/post.
      // A tutor's own assessment is always an activity now; pre and post are
      // generated at subject level, so offering them here would have produced a
      // second, competing "Pre-Assessment" for the same subject.
      purpose: 'activity',
      assessment_kind: 'tutor_assessment',
      question_type: questionType,
      item_count: parsedQuestions.length,
      questions: parsedQuestions
    });

    setFlash(req, 'success', `Assessment "${title}" created and published to your students.`);
    res.redirect(`/tutor/modules/${mod.id}`);
  } catch (error) {
    setFlash(req, 'error', error.message || 'Could not create assessment.');
    res.redirect(`/tutor/modules/${req.params.id}`);
  }
});

// Tutor: View student results
//
// This is also the old Analytics & Reports page: the per-student roll-up at the
// top, then every individual attempt underneath. The search box filters the
// roll-up, which is what it filtered on the page it came from.
router.get('/student-results', async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim();
    const results = await getTutorStudentResults(req.session.user.id);
    const analytics = await getTutorStudentsForAnalytics(req.session.user.id, search);

    const shell = await buildShell(req, {
      pageTitle: 'Student Results',
      section: 'student_results',
      contentView: '../content/tutor-student-results',
      results,
      students: analytics.students,
      summary: analytics.summary,
      search
    });
    res.render('shells/dashboard', shell);
  } catch (error) { next(error); }
});

// Tutor: the older per-attempt review.
//
// It is kept as a URL, not as a page. Its query INNER JOINs modules and filters on
// ta.tutor_id, so it could never show a generated Pre-Assessment, and it rendered a
// second, weaker copy of the same information as /tutor/results/:id — no weak areas,
// no source attribution. Redirecting keeps every old link working while leaving one
// review page to maintain.
router.get('/student-results/:id', (req, res) => {
  res.redirect(`/tutor/results/${req.params.id}`);
});


// --------------------------------------------------------------------------
// Result breakdown with weak areas (overhaul Phase 6, acceptance item 8)
//
// A separate route from /student-results/:id because that one INNER JOINs modules
// and filters on ta.tutor_id — both NULL for a generated Pre-Assessment, so it can
// never return one.
// --------------------------------------------------------------------------
router.get('/results/:submissionId', async (req, res, next) => {
  try {
    const submission = await getSubmissionWithAnswers(Number(req.params.submissionId));
    if (!submission) {
      setFlash(req, 'error', 'Result not found.');
      return res.redirect('/tutor/student-results');
    }

    // A tutor may only read results for subjects they are assigned to.
    const assigned = await getTutorAssignedSubjects(req.session.user.id);
    if (!assigned.some((a) => Number(a.subject_id) === Number(submission.subject_id))) {
      setFlash(req, 'error', 'That result belongs to a subject you are not assigned to.');
      return res.redirect('/tutor/student-results');
    }

    const weakAreas = await getWeakAreasForSubmission(submission.id);
    const shell = await buildShell(req, {
      pageTitle: `${submission.first_name} ${submission.last_name || ''} - ${submission.title}`,
      section: 'student_results',
      contentView: '../content/student-assessment-breakdown',
      submission,
      weakAreas,
      viewerRole: 'tutor'
    });
    res.render('shells/dashboard', shell);
  } catch (error) { next(error); }
});

module.exports = router;
