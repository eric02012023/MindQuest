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
  // Phase 3: Assessment requests and analytics
  getAssessmentRequestsForTutor,
  respondToAssessmentRequest,
  getTutorStudentsForAnalytics,
  getAttendanceBySubject
} = require('../lib/data');
const { normalizeArray } = require('../lib/utils');

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
  const [inboxNotifications, assessmentRequests] = await Promise.all([
    getTutorScheduleNotifications(req.session.user.id),
    getAssessmentRequestsForTutor(req.session.user.id)
  ]);
  const pendingAssessmentRequests = assessmentRequests.filter((r) => r.status === 'pending');
  // Merge assessment requests into notifications for the bell
  const allNotifications = [
    ...inboxNotifications,
    ...pendingAssessmentRequests.map((r) => ({
      ...r,
      notification_type: 'assessment_request',
      full_name: `${r.student_first_name} ${r.student_last_name}`,
      created_at: r.requested_at
    }))
  ];
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
      adminResources
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

// Phase 8: Consolidated assessment from ALL admin modules
router.post('/subjects/:subjectId/post-consolidated-assessment', async (req, res, next) => {
  const subjectId = parseInt(req.params.subjectId, 10);
  const tutorUserId = parseInt(req.session.user.id, 10);
  try {
    const { query: dbQuery } = require('../config/db');
    const { generateAssessmentFromModule } = require('../services/aiService');
    const { getSubjectById, logAiGeneration, getActiveLearningCycle, getAdminSubjectResources, advanceLearningCycle } = require('../lib/data');

    if (isNaN(subjectId) || isNaN(tutorUserId)) {
      setFlash(req, 'error', 'Invalid request parameters.');
      return res.redirect(`/tutor/subjects/${req.params.subjectId}`);
    }

    const itemCount = Number(req.body.item_count) || 10;
    if (itemCount < 5 || itemCount > 50) {
      setFlash(req, 'error', 'Please enter a valid number of items (5–50).');
      return res.redirect(`/tutor/subjects/${subjectId}`);
    }

    const subject = await getSubjectById(subjectId);
    if (!subject) {
      setFlash(req, 'error', 'Subject not found.');
      return res.redirect(`/tutor/subjects/${subjectId}`);
    }

    const tutorStudents = await getTutorStudentsBySubject(tutorUserId, subjectId);
    if (!tutorStudents.length) {
      setFlash(req, 'error', 'No students assigned to you in this subject.');
      return res.redirect(`/tutor/subjects/${subjectId}`);
    }

    // Prepare fallback content from Admin Modules
    const adminModules = await getAdminSubjectResources(subjectId);
    const fallbackCombinedContent = adminModules.map((mod) => {
      const content = mod.content_text || mod.description || '';
      return `## Module: ${mod.title}\n${content}`;
    }).join('\n\n---\n\n');
    const fallbackLevelGroup = adminModules.length ? (adminModules[0].type_of_module || 'General') : 'General';
    const fallbackModuleTitles = adminModules.map((m) => m.title).join(', ');

    let generatedCount = 0;
    let skippedCount = 0;

    for (const student of tutorStudents) {
      const studentId = parseInt(student.student_id, 10);

      // Check if student has a pending AI assessment
      const pendingRows = await dbQuery(
        `SELECT a.id FROM assessments a
         LEFT JOIN assessment_results ar ON ar.assessment_id = a.id AND ar.student_id = a.assigned_student_id
         WHERE a.assigned_student_id = ? AND a.subject_id = ? AND a.is_published = 1
           AND a.assessment_origin = 'ai_generated' AND ar.id IS NULL`,
        [studentId, subjectId]
      );
      
      if (pendingRows.length > 0) {
        skippedCount++;
        continue; // Skip this student
      }

      // Determine content to base the assessment on
      let moduleContent = fallbackCombinedContent;
      let levelGroup = fallbackLevelGroup;
      let sourceModuleTitle = fallbackModuleTitles;
      let cycleId = null;

      const activeCycle = await getActiveLearningCycle(studentId, subjectId);
      if (activeCycle && activeCycle.resource_content) {
        moduleContent = activeCycle.resource_content;
        levelGroup = activeCycle.result_level || 'General';
        sourceModuleTitle = activeCycle.resource_title || 'AI Generated Module';
        cycleId = activeCycle.id;
      }

      if (!moduleContent || moduleContent.trim() === '') {
        skippedCount++;
        continue;
      }

      // Generate personalized assessment
      const aiResult = await generateAssessmentFromModule({
        moduleContent,
        subject: subject.name,
        levelGroup,
        questionCount: itemCount
      });

      const title = `AI Assessment: ${subject.name} - ${levelGroup}`;

      const insertResult = await dbQuery(
        `INSERT INTO assessments (title, assessment_type, assigned_student_id, created_by, is_published, subject_id, assessment_origin, source_module_title, cycle_id)
         VALUES (?, 'post', ?, ?, 1, ?, 'ai_generated', ?, ?)`,
        [title, studentId, tutorUserId, subjectId, sourceModuleTitle, cycleId]
      );
      const assessmentId = insertResult.insertId;

      for (const q of aiResult.questions) {
        await dbQuery(
          `INSERT INTO assessment_questions (assessment_id, question_text, choice_a, choice_b, choice_c, choice_d, correct_answer, question_type, points)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [assessmentId, q.question_text, q.choice_a || '', q.choice_b || '', q.choice_c || '', q.choice_d || '', q.correct_answer, q.question_type || 'Multiple Choice', q.points || 1]
        );
      }

      // Advance learning cycle to pending assessment
      if (cycleId) {
        await advanceLearningCycle(cycleId, {
          status: 'assessment_pending',
          assessment_id: assessmentId
        });
      }

      try {
        await logAiGeneration({ student_id: studentId, subject_id: subjectId, generation_type: 'tutor_consolidated_assessment', provider: aiResult.provider, model: aiResult.model, tokens_used: aiResult.tokensUsed });
      } catch(e) { /* non-critical */ }

      generatedCount++;
    }

    if (generatedCount > 0) {
      setFlash(req, 'success', `AI Assessment generated for ${generatedCount} student(s). ${skippedCount > 0 ? `Skipped ${skippedCount} student(s) who already have pending assessments.` : ''}`);
    } else {
      if (skippedCount > 0) {
        setFlash(req, 'info', `No new assessments generated. All ${skippedCount} student(s) already have pending assessments to answer.`);
      } else {
        setFlash(req, 'error', 'Failed to generate assessments. Please check if modules are available.');
      }
    }
    
    res.redirect(`/tutor/subjects/${subjectId}`);
  } catch (error) {
    setFlash(req, 'error', error.message || 'Could not publish assessment.');
    res.redirect(`/tutor/subjects/${subjectId}`);
  }
});



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

// Tutor Analytics & Reports page
router.get('/analytics', async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim();
    const data = await getTutorStudentsForAnalytics(req.session.user.id, search);
    const assessmentRequests = await getAssessmentRequestsForTutor(req.session.user.id);
    const pendingRequests = assessmentRequests.filter((r) => r.status === 'pending');

    const shell = await buildShell(req, {
      pageTitle: 'Analytics & Reports',
      section: 'analytics',
      contentView: '../content/tutor-analytics',
      students: data.students,
      summary: data.summary,
      pendingRequests,
      search
    });
    res.render('shells/dashboard', shell);
  } catch (error) {
    next(error);
  }
});

// Accept assessment request — generates AI assessment based on admin module
router.post('/assessment-requests/:id/accept', async (req, res, next) => {
  try {
    const itemCount = Number(req.body.item_count);
    if (!itemCount || itemCount < 5 || itemCount > 50) {
      setFlash(req, 'error', 'Please enter a valid number of assessment items (5–50).');
      return res.redirect('/tutor/analytics');
    }

    const request = await respondToAssessmentRequest(req.params.id, req.session.user.id, 'accept', req.body.message || '', itemCount);

    // Now generate the AI assessment for the student
    try {
      const { query: dbQuery } = require('../config/db');
      const { generateAssessmentFromModule } = require('../services/aiService');
      const {
        getSubjectById, getUserById, addSubjectResource, logAiGeneration,
        getActiveLearningCycle, createLearningCycle, advanceLearningCycle,
        getAdminSubjectResources
      } = require('../lib/data');

      const subject = await getSubjectById(request.subject_id);
      const student = await getUserById(request.student_id);
      if (!subject || !student) throw new Error('Subject or student not found.');

      // Fetch the module content — trace through source_resource_id chain
      let moduleContent = '';
      let moduleTitle = '';
      let sourceResourceId = request.resource_id;

      if (sourceResourceId) {
        const moduleRows = await dbQuery('SELECT TOP 1 * FROM subject_resources WHERE id = ?', [sourceResourceId]);
        if (moduleRows.length) {
          moduleContent = moduleRows[0].content_text || '';
          moduleTitle = moduleRows[0].title || '';
          // If no content_text, trace through source_resource_id (for tutor_share modules)
          if (!moduleContent && moduleRows[0].source_resource_id) {
            const sourceRows = await dbQuery('SELECT TOP 1 * FROM subject_resources WHERE id = ?', [moduleRows[0].source_resource_id]);
            if (sourceRows.length) {
              moduleContent = sourceRows[0].content_text || sourceRows[0].description || '';
              moduleTitle = sourceRows[0].title || moduleTitle;
            }
          }
          // Use description as fallback
          if (!moduleContent) {
            moduleContent = moduleRows[0].description || '';
          }
        }
      }

      // Fallback: get any admin module with content for this subject
      if (!moduleContent) {
        const adminModules = await getAdminSubjectResources(request.subject_id);
        for (const am of adminModules) {
          const content = am.content_text || am.description || '';
          if (content && content.length >= 10) {
            moduleContent = content;
            moduleTitle = am.title || moduleTitle;
            sourceResourceId = am.id;
            break;
          }
        }
      }

      // Last resort: use title + description as context
      if (!moduleContent || moduleContent.length < 10) {
        if (sourceResourceId) {
          const lastRows = await dbQuery('SELECT TOP 1 title, description FROM subject_resources WHERE id = ?', [sourceResourceId]);
          if (lastRows.length) {
            moduleContent = `${lastRows[0].title || ''}\n${lastRows[0].description || ''}`.trim();
          }
        }
      }

      if (!moduleContent || moduleContent.length < 5) {
        setFlash(req, 'error', 'No module content found for this subject. Please ask admin to add content to the module. The request was accepted but no assessment was generated.');
        return res.redirect('/tutor/analytics');
      }

      const levelGroup = student.education_level_group || student.year_level || '';

      // Generate assessment via AI using admin module content and tutor-specified item count
      const aiResult = await generateAssessmentFromModule({
        moduleContent,
        subject: subject.name,
        levelGroup,
        questionCount: itemCount
      });

      // Log AI generation
      await logAiGeneration({
        generation_type: 'assessment_from_module',
        student_id: request.student_id,
        subject_id: request.subject_id,
        resource_id: sourceResourceId || null,
        input_summary: `Module: ${moduleTitle} | Items: ${itemCount} (tutor-specified)`,
        output_summary: `Generated ${aiResult.questions.length} questions`,
        ai_provider: aiResult.provider,
        ai_model: aiResult.model,
        tokens_used: aiResult.tokensUsed,
        success: true
      });

      // Get or create learning cycle
      let activeCycle = await getActiveLearningCycle(request.student_id, request.subject_id);
      if (!activeCycle && sourceResourceId) {
        const cycleId = await createLearningCycle(request.student_id, request.subject_id, Number(sourceResourceId), 1);
        activeCycle = { id: cycleId, round_number: 1 };
      }

      const round = activeCycle ? activeCycle.round_number : 1;

      // Create assessment in database
      const assessmentTitle = `AI Assessment: ${subject.name} — Round ${round}`;
      const assessmentResult = await dbQuery(
        `INSERT INTO assessments (title, subject_id, assigned_student_id, assessment_type, source_resource_id, assessment_origin, cycle_id, max_violations, time_limit_minutes, is_published)
         VALUES (?, ?, ?, 'post', ?, 'ai_generated', ?, 3, NULL, 1)`,
        [assessmentTitle, request.subject_id, request.student_id, sourceResourceId, activeCycle ? activeCycle.id : null]
      );
      const assessmentId = assessmentResult.insertId;

      // Insert questions
      for (const q of aiResult.questions) {
        await dbQuery(
          `INSERT INTO assessment_questions (assessment_id, question_text, question_type, choice_a, choice_b, choice_c, choice_d, correct_answer, explanation, answer_rubric)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [assessmentId, q.question_text, q.question_type, q.choice_a || '', q.choice_b || '', q.choice_c || '', q.choice_d || '', q.correct_answer, q.explanation || '', q.answer_rubric || '']
        );
      }

      // Update learning cycle
      if (activeCycle) {
        await advanceLearningCycle(activeCycle.id, {
          status: 'assessment_pending',
          assessment_id: assessmentId
        });
      }

      // Emit real-time notification to the student
      const io = req.app.get('io');
      const onlineUsers = req.app.get('onlineUsers');
      if (io && request.student_id) {
        const targetSocketId = onlineUsers.get(String(request.student_id));
        if (targetSocketId) {
          io.to(targetSocketId).emit('assessment-request-update', {
            status: 'accepted',
            subjectId: request.subject_id,
            resourceId: request.resource_id,
            tutorName: `${req.session.user.first_name} ${req.session.user.last_name}`,
            message: req.body.message || `Your assessment request has been approved! A ${aiResult.questions.length}-item assessment has been generated. You can now take it.`
          });
        }
      }

      setFlash(req, 'success', `Assessment request accepted! AI generated ${aiResult.questions.length} questions based on the admin module "${moduleTitle}".`);
    } catch (aiError) {
      console.error('[Tutor Accept] AI assessment generation failed:', aiError.message);
      // Still notify the student that the request was accepted
      const io = req.app.get('io');
      const onlineUsers = req.app.get('onlineUsers');
      if (io && request.student_id) {
        const targetSocketId = onlineUsers.get(String(request.student_id));
        if (targetSocketId) {
          io.to(targetSocketId).emit('assessment-request-update', {
            status: 'accepted',
            subjectId: request.subject_id,
            resourceId: request.resource_id,
            tutorName: `${req.session.user.first_name} ${req.session.user.last_name}`,
            message: 'Your assessment request has been approved. You can now take the assessment!'
          });
        }
      }
      setFlash(req, 'error', `Assessment request accepted but AI generation failed: ${aiError.message}. The student can still generate the assessment manually.`);
    }
    res.redirect('/tutor/analytics');
  } catch (error) {
    setFlash(req, 'error', error.message || 'Could not accept request.');
    res.redirect('/tutor/analytics');
  }
});

// Decline assessment request
router.post('/assessment-requests/:id/decline', async (req, res, next) => {
  try {
    const request = await respondToAssessmentRequest(req.params.id, req.session.user.id, 'decline', req.body.message || '');
    // Emit real-time notification to the student
    const io = req.app.get('io');
    const onlineUsers = req.app.get('onlineUsers');
    if (io && request.student_id) {
      const targetSocketId = onlineUsers.get(String(request.student_id));
      if (targetSocketId) {
        io.to(targetSocketId).emit('assessment-request-update', {
          status: 'declined',
          subjectId: request.subject_id,
          resourceId: request.resource_id,
          tutorName: `${req.session.user.first_name} ${req.session.user.last_name}`,
          message: req.body.message || 'Your assessment request has been declined by your tutor.'
        });
      }
    }
    setFlash(req, 'success', 'Assessment request declined.');
    res.redirect('/tutor/analytics');
  } catch (error) {
    setFlash(req, 'error', error.message || 'Could not decline request.');
    res.redirect('/tutor/analytics');
  }
});

module.exports = router;
