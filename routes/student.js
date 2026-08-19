/**
 * ANNOTATED COPY FOR DEFENSE REVIEW
 * File: routes/student.js
 * Purpose: Student dashboard routes. This file handles subjects, tutor applications, billing, messaging, assessments, notifications, and profile management for learners.
 * Notes: Comments were added to help explain the system during code defense without changing the original logic.
 */

const express = require('express');
const { authorize, setFlash } = require('../middleware/auth');
const { createUploader } = require('../lib/uploads');
const {
  getStudentDashboardData,
  getStudentAssignments,
  getStudentSubjectsOverview,
  createSubjectEnrollmentRequest,
  getStudentBillingView,
  getAllowedContacts,
  getConversation,
  saveMessage,
  getMessageById,
  updateMessageBody,
  unsendMessage,
  getUserById,
  getSubjectResources,
  updateUser,
  getStudentAssessments,
  getAssessmentById,
  submitAssessment,
  resetAssessmentResult,
  getAttendanceBySubject,
  getTutorAvailabilityForSubject,
  getTutorAvailabilityForStudent,
  createTutorScheduleApplication,
  createTutorScheduleApplicationForAllSubjects,
  getStudentScheduleNotifications,
  markStudentScheduleNotificationRead,
  // Phase 2: AI system imports
  getModulesForStudent,
  markModuleRead,
  getStudentAnalytics,
  createAssessmentAttempt,
  logAntiCheatEvent,
  getAntiCheatViolationCount,
  getActiveLearningCycle,
  createLearningCycle,
  advanceLearningCycle,
  addSubjectResource,
  createOnlinePayment,
  completeOnlinePayment,
  logAiGeneration,
  scoreToLevel,
  getSubjectById,
  // Phase 3: Assessment requests, PayMongo
  createAssessmentRequest,
  getAssessmentRequestsForStudent,
  getAcceptedAssessmentRequest,
  createPayMongoPayment,
  getAdminSubjectResources,
  // Phase 4: Admin pre/post assessments
  getSubjectAssessmentForStudent,
  // Phase 5/6: Module & Level System
  getStudentSubjectLevel,
  setStudentSubjectLevel,
  getModuleBySubjectAndLevel,
  getModulesBySubject,
  getTutorAssessmentsByModule,
  getTutorAssessmentById,
  submitTutorAssessment,
  getStudentSubmissions,
  getStudentProgress,
  // Module -> Handout -> Assessment overhaul (Phases 5-6)
  getOrCreatePreAssessment,
  getAssessmentWithQuestions,
  gradeAndSubmitAssessment,
  hasCompletedPreAssessment,
  getStudentSubjectModules,
  getSubmissionWithAnswers,
  getWeakAreasForSubmission,
  getModuleHandouts,
  getSubjectHandoutTexts,
  moduleTargetsStudent
} = require('../lib/data');
const { determineLevel } = require('../config/levelThresholds');
const { normalizeArray } = require('../lib/utils');
const { generateAssessmentFromModule } = require('../services/aiService');

const router = express.Router();
const profileUploader = createUploader('profiles');
const messageUploader = createUploader('messages');

router.use(authorize(['student']));

// Function: buildShell

// Role: Handles a reusable server-side operation used by this module.

async function buildShell(req, extra = {}) {
  const inboxNotifications = await getStudentScheduleNotifications(req.session.user.id);
  return {
    pageTitle: extra.pageTitle || 'Student Dashboard',
    roleName: 'Student',
    basePath: '/student',
    section: extra.section || 'dashboard',
    contentView: extra.contentView,
    currentUser: req.session.user,
    notificationCount: inboxNotifications.length,
    inboxNotifications,
    ...extra
  };
}

// Route handler: GET request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.get('/', async (req, res, next) => {
  try {
    const dashboard = await getStudentDashboardData(req.session.user.id);
    const shell = await buildShell(req, {
      pageTitle: 'Student Dashboard',
      section: 'dashboard',
      contentView: '../content/student-dashboard',
      dashboard
    });
    res.render('shells/dashboard', shell);
  } catch (error) {
    next(error);
  }
});

// Route handler: GET request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.get('/subjects', async (req, res, next) => {
  try {
    const subjectOverview = await getStudentSubjectsOverview(req.session.user.id);
    // Single unified tutor availability list for all enrolled subjects (Fix C)
    const tutorOptions = await getTutorAvailabilityForStudent(req.session.user.id);
    const shell = await buildShell(req, {
      pageTitle: 'My Subject',
      section: 'subjects',
      contentView: '../content/student-subjects',
      assignments: subjectOverview.enrolledSubjects,
      allSubjects: subjectOverview.allSubjects,
      tutorOptions
    });
    res.render('shells/dashboard', shell);
  } catch (error) {
    next(error);
  }
});

// Route handler: POST request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.post('/subjects/:subjectId/enroll', async (req, res, next) => {
  try {
    await createSubjectEnrollmentRequest(req.session.user.id, Number(req.params.subjectId));
    setFlash(req, 'success', 'Enrollment request sent to admin.');
    res.redirect('/student/subjects');
  } catch (error) {
    setFlash(req, 'error', error.message || 'Could not send enrollment request.');
    res.redirect('/student/subjects');
  }
});

// Route handler: GET request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.get('/tutors/:id', async (req, res, next) => {
  try {
    const tutor = await getUserById(req.params.id);
    if (!tutor || tutor.role !== 'tutor') {
      setFlash(req, 'error', 'Tutor not found.');
      return res.redirect('/student/subjects');
    }
    const shell = await buildShell(req, {
      pageTitle: 'Tutor Profile',
      section: 'subjects',
      contentView: '../content/student-tutor-profile',
      tutor
    });
    return res.render('shells/dashboard', shell);
  } catch (error) { next(error); }
});

// Route handler: GET request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.get('/subjects/:subjectId', async (req, res, next) => {
  try {
    const assignments = await getStudentAssignments(req.session.user.id);
    const assignment = assignments.find((item) => Number(item.subject_id) === Number(req.params.subjectId));
    if (!assignment) {
      setFlash(req, 'error', 'Subject not found in your account.');
      return res.redirect('/student/subjects');
    }
    const resources = await getSubjectResources(req.params.subjectId, req.session.user.id, { mode: 'student' });
    const modules = await getModulesForStudent(req.session.user.id, req.params.subjectId);
    const activeCycle = await getActiveLearningCycle(req.session.user.id, req.params.subjectId);
    const tutor = assignment.tutor_internal_id ? await getUserById(assignment.tutor_internal_id) : null;
    const attendanceLogs = await getAttendanceBySubject(req.session.user.id, req.params.subjectId);
    const assessmentRequests = await getAssessmentRequestsForStudent(req.session.user.id);

    // Get completed assessments for this subject to show per-module status
    const { query: dbQuery } = require('../config/db');
    const completedAssessments = await dbQuery(
      `SELECT a.id, a.source_resource_id, a.title, ar.score, ar.total_questions, ar.percentage, ar.level, ar.taken_at
       FROM assessments a
       INNER JOIN assessment_results ar ON ar.assessment_id = a.id AND ar.student_id = a.assigned_student_id
       WHERE a.assigned_student_id = ? AND a.subject_id = ? AND ar.taken_at IS NOT NULL
       ORDER BY ar.taken_at DESC`,
      [req.session.user.id, req.params.subjectId]
    );

    // Phase 4: Get pre/post assessments for this student in this subject
    const subjectAssessments = await getSubjectAssessmentForStudent(req.session.user.id, req.params.subjectId);
    const preAssessment = subjectAssessments.find(a => a.assessment_type === 'pre');
    const postAssessment = subjectAssessments.find(a => a.assessment_type === 'post');
    const preAssessmentRequired = !!preAssessment;
    const preAssessmentTaken = !!(preAssessment && preAssessment.taken_at);

    // Admin-module lock logic: admin-uploaded modules are locked until the student
    // takes the subject assessment. AI-generated modules are always unlocked.
    let adminModulesLocked = true;
    let adminModuleLockReason = '';
    const hasAnyPostedAssessment = subjectAssessments.some(a => Number(a.is_published) === 1);
    const hasAnyTakenAssessment = subjectAssessments.some(a => a.taken_at);

    if (!hasAnyPostedAssessment) {
      adminModulesLocked = true;
      adminModuleLockReason = 'waiting'; // Admin hasn't posted an assessment yet
    } else if (!hasAnyTakenAssessment) {
      adminModulesLocked = true;
      adminModuleLockReason = 'not_taken'; // Assessment posted but student hasn't taken it
    } else {
      adminModulesLocked = false;
      adminModuleLockReason = '';
    }

    // Find all pending AI assessments (published but not taken yet by the student)
    let pendingAiAssessments = [];
    if (preAssessmentTaken) {
      pendingAiAssessments = await dbQuery(
        `SELECT a.id, a.title, a.assessment_type,
                (SELECT COUNT(*) FROM assessment_questions aq WHERE aq.assessment_id = a.id) AS question_count
         FROM assessments a
         LEFT JOIN assessment_results ar ON ar.assessment_id = a.id AND ar.student_id = a.assigned_student_id
         WHERE a.assigned_student_id = ? AND a.subject_id = ? AND a.is_published = 1
           AND a.assessment_origin = 'ai_generated' AND ar.id IS NULL
         ORDER BY a.created_at DESC`,
        [req.session.user.id, req.params.subjectId]
      );
    }

    // Phase 6: Module Level System — check if student has a level for this subject
    const studentLevel = await getStudentSubjectLevel(req.session.user.id, Number(req.params.subjectId));
    let assignedModule = null;
    let moduleAssessments = [];
    let moduleSubmissions = [];
    if (studentLevel) {
      assignedModule = await getModuleBySubjectAndLevel(Number(req.params.subjectId), studentLevel.level);
      if (assignedModule) {
        moduleAssessments = await getTutorAssessmentsByModule(assignedModule.id);
        moduleSubmissions = await getStudentSubmissions(req.session.user.id, Number(req.params.subjectId));
      }
    }
    // Check if a tutor pre-assessment exists for this subject (purpose = 'pre')
    const { query: dbQuery2 } = require('../config/db');
    const tutorPreAssessments = await dbQuery2(
      `SELECT ta.id, ta.title, ta.module_id,
              (SELECT COUNT(*) FROM tutor_assessment_questions WHERE assessment_id = ta.id) as question_count
       FROM tutor_assessments ta
       JOIN modules m ON m.id = ta.module_id
       WHERE ta.subject_id = ? AND ta.purpose = 'pre' AND ta.is_published = 1 AND ta.is_archived = 0`,
      [req.params.subjectId]
    );
    const hasTutorPreAssessment = tutorPreAssessments.length > 0;

    // ---- Module system (overhaul Phase 6) --------------------------------
    // The Pre-Assessment gates everything below it. newModules is already
    // filtered to this student's year level.
    const preAssessmentDone = await hasCompletedPreAssessment(req.session.user.id, Number(req.params.subjectId));
    const newModules = await getStudentSubjectModules(req.session.user.id, Number(req.params.subjectId));
    const handoutsReady = (await getSubjectHandoutTexts(Number(req.params.subjectId))).length;

    const shell = await buildShell(req, {
      pageTitle: assignment.subject_name,
      section: 'subjects',
      contentView: '../content/student-subject-detail',
      assignment,
      resources,
      modules,
      newModules,
      preAssessmentDone,
      handoutsReady,
      activeCycle,
      tutor,
      attendanceLogs,
      assessmentRequests,
      completedAssessments,
      subjectAssessments,
      preAssessment,
      postAssessment,
      preAssessmentRequired,
      preAssessmentTaken,
      pendingAiAssessments,
      adminModulesLocked,
      adminModuleLockReason,
      // Phase 6 additions
      studentLevel,
      assignedModule,
      moduleAssessments,
      moduleSubmissions,
      hasTutorPreAssessment,
      tutorPreAssessments
    });
    res.render('shells/dashboard', shell);
  } catch (error) {
    next(error);
  }
});


// Single select-tutor route — applies to all enrolled subjects (Fix C)
// Route handler: POST request
// Purpose: Processes this endpoint and returns the correct view or action result.
router.post('/apply-tutor', async (req, res, next) => {
  try {
    await createTutorScheduleApplicationForAllSubjects(
      req.session.user.id,
      Number(req.body.tutor_id),
      String(req.body.time_slot || '').trim()
    );
    setFlash(req, 'success', 'Schedule application sent to tutor for all your enrolled subjects.');
    res.redirect('/student/subjects');
  } catch (error) {
    setFlash(req, 'error', error.message || 'Could not submit schedule application.');
    res.redirect('/student/subjects');
  }
});

// Keep per-subject apply route for backwards compatibility (subject-detail page)
// Route handler: POST request
// Purpose: Processes this endpoint and returns the correct view or action result.
router.post('/subjects/:subjectId/apply', async (req, res, next) => {
  try {
    await createTutorScheduleApplication(req.session.user.id, Number(req.params.subjectId), Number(req.body.tutor_id), String(req.body.time_slot || '').trim());
    setFlash(req, 'success', 'Schedule application sent to tutor.');
    res.redirect(`/student/subjects/${req.params.subjectId}`);
  } catch (error) {
    setFlash(req, 'error', error.message || 'Could not submit schedule application.');
    res.redirect(`/student/subjects/${req.params.subjectId}`);
  }
});

// Route handler: POST request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.post('/notifications/:id/read', async (req, res, next) => {
  try {
    await markStudentScheduleNotificationRead(Number(req.params.id), req.session.user.id);
    setFlash(req, 'success', 'Notification marked as read.');
    res.redirect('back');
  } catch (error) { next(error); }
});

// Route handler: GET request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.get('/billing', async (req, res, next) => {
  try {
    const billingView = await getStudentBillingView(req.session.user.id);
    const shell = await buildShell(req, {
      pageTitle: 'My Billing',
      section: 'billing',
      contentView: '../content/student-billing',
      billingView
    });
    res.render('shells/dashboard', shell);
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
      contentView: '../content/student-messages',
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
      return res.redirect(`/student/messages?contact=${req.body.receiver_id}`);
    }
    await saveMessage({
      sender_id: req.session.user.id,
      receiver_id: req.body.receiver_id,
      body,
      file_path: req.file ? `/uploads/messages/${req.file.filename}` : null,
      file_original_name: req.file ? req.file.originalname : null,
      file_type: req.file ? req.file.mimetype : ''
    });
    res.redirect(`/student/messages?contact=${req.body.receiver_id}`);
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
      return res.redirect(`/student/messages?contact=${req.body.contact_id || req.query.contact || ''}`);
    }
    await updateMessageBody(message.id, req.body.body);
    res.redirect(`/student/messages?contact=${message.receiver_id === req.session.user.id ? message.sender_id : message.receiver_id}`);
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
      return res.redirect(`/student/messages?contact=${req.body.contact_id || req.query.contact || ''}`);
    }
    await unsendMessage(message.id);
    res.redirect(`/student/messages?contact=${message.receiver_id === req.session.user.id ? message.sender_id : message.receiver_id}`);
  } catch (error) {
    next(error);
  }
});


// Route handler: GET request


// Purpose: Processes this endpoint and returns the correct view or action result.


router.get('/assessments', (req, res) => {
  // Assessments are now accessed inside My Subjects only
  res.redirect('/student/subjects');
});

// Route handler: GET request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.get('/assessments/:id', async (req, res, next) => {
  try {
    const assessment = await getAssessmentById(req.params.id, req.session.user.id);
    if (!assessment || Number(assessment.assigned_student_id) !== Number(req.session.user.id)) {
      setFlash(req, 'error', 'Assessment not found.');
      return res.redirect('/student/subjects');
    }
    const shell = await buildShell(req, {
      pageTitle: 'Take Assessment',
      section: 'assessments',
      contentView: '../content/student-assessment-take',
      assessment
    });
    res.render('shells/dashboard', shell);
  } catch (error) {
    next(error);
  }
});

// Route handler: POST request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.post('/assessments/:id/submit', async (req, res, next) => {
  try {
    const assessment = await getAssessmentById(req.params.id, req.session.user.id);
    if (!assessment || Number(assessment.assigned_student_id) !== Number(req.session.user.id) || !Number(assessment.is_published)) {
      setFlash(req, 'error', 'Assessment not found.');
      return res.redirect('/student/assessments');
    }

    // Prevent retake: check if already has a result
    if (assessment.result && assessment.result.taken_at) {
      setFlash(req, 'info', 'You have already completed this assessment. Your previous result is shown.');
      return res.redirect(`/student/assessments/${req.params.id}`);
    }

    const result = await submitAssessment(req.params.id, req.session.user.id, req.body || {});

    // Auto-generate a single follow-up module based on ALL admin modules
    try {
      const { generateModuleFromAssessmentResult } = require('../services/aiService');
      const { query: dbQuery } = require('../config/db');

      let subjectName = assessment.subject_name || '';
      const subjectId = assessment.subject_id;

      // Gather ALL admin modules for this subject
      const adminModules = await getAdminSubjectResources(subjectId);
      let originalContent = '';
      let originalTitle = '';

      if (adminModules.length) {
        // Combine all admin module content into one
        originalContent = adminModules.map((mod) => {
          const content = mod.content_text || mod.description || '';
          return `## Module: ${mod.title}\n${content}`;
        }).join('\n\n---\n\n');
        originalTitle = adminModules.map((m) => m.title).join(', ');
      }

      // Fallback: use assessment title
      if (!originalContent || originalContent.length < 10) {
        originalContent = `${assessment.title || ''}`.trim();
        originalTitle = assessment.title || 'Subject Review';
      }

      if (!subjectName && subjectId) {
        const subj = await getSubjectById(subjectId);
        if (subj) subjectName = subj.name;
      }

      const student = await getUserById(req.session.user.id);
      const levelGroup = student?.education_level_group || student?.year_level || '';

      // Get or create learning cycle
      let activeCycle = await getActiveLearningCycle(req.session.user.id, subjectId);
      if (!activeCycle) {
        const cycleId = await createLearningCycle(req.session.user.id, subjectId, adminModules[0]?.id || 0, 1);
        activeCycle = { id: cycleId, round_number: 1 };
      }

      const round = activeCycle ? activeCycle.round_number : 1;

      // Generate the follow-up module
      const aiModule = await generateModuleFromAssessmentResult({
        originalModuleContent: originalContent,
        originalModuleTitle: originalTitle,
        resultLevel: result.level,
        subject: subjectName,
        levelGroup,
        round
      });

      // Save the AI module content as a downloadable HTML file
      const fs = require('fs');
      const path = require('path');
      const aiModulesDir = path.join(__dirname, '..', 'public', 'uploads', 'ai-modules');
      if (!fs.existsSync(aiModulesDir)) fs.mkdirSync(aiModulesDir, { recursive: true });

      const safeTitle = aiModule.title.replace(/[^a-zA-Z0-9_\-]/g, '_').substring(0, 50);
      const fileName = `module_${req.session.user.id}_${Date.now()}_${safeTitle}.html`;
      const filePath = path.join(aiModulesDir, fileName);
      const publicFilePath = `/uploads/ai-modules/${fileName}`;

      // Build a nice HTML file
      const studentName = `${student?.first_name || ''} ${student?.last_name || ''}`.trim();
      const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${aiModule.title}</title>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; line-height: 1.8; color: #333; background: #f9fafb; }
    .header { background: linear-gradient(135deg, #1a5632, #2d8a4e); color: #fff; padding: 30px; border-radius: 12px; margin-bottom: 30px; }
    .header h1 { margin: 0 0 8px; font-size: 24px; }
    .header p { margin: 4px 0; opacity: 0.9; font-size: 14px; }
    .badge { display: inline-block; background: rgba(255,255,255,0.2); padding: 4px 12px; border-radius: 20px; font-size: 12px; margin-top: 8px; }
    .content { background: #fff; padding: 30px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); font-size: 15px; }
    .content h1, .content h2, .content h3 { color: #1a5632; margin-top: 1.5em; }
    .content code { background: #f0f0f0; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
    .content pre code { display: block; padding: 15px; overflow-x: auto; }
    .footer { text-align: center; margin-top: 30px; color: #999; font-size: 12px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>${aiModule.title}</h1>
    <p><strong>Subject:</strong> ${subjectName}</p>
    <p><strong>Created by:</strong> System</p>
    <p><strong>Assessment Score:</strong> ${result.score}/${result.total_questions} (${result.percentage.toFixed(1)}%)</p>
    <span class="badge">${result.level} Level Review</span>
    <span class="badge">Round ${round}</span>
  </div>
  
  <div class="content" id="rendered-content"></div>
  <script type="text/markdown" id="raw-markdown">
${aiModule.content}
  </script>
  <script>
    document.getElementById('rendered-content').innerHTML = marked.parse(document.getElementById('raw-markdown').textContent);
  </script>

  <div class="footer">
    <p>Generated by MindQuest AI Learning System &bull; ${new Date().toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
  </div>
</body>
</html>`;

      fs.writeFileSync(filePath, htmlContent, 'utf8');

      // Save the generated module to subject_resources (with file path)
      await addSubjectResource(req.session.user.id, subjectId, aiModule.title, aiModule.content.substring(0, 500), { path: publicFilePath, mimetype: 'text/html' }, {
        created_by_role: 'ai_generated',
        type_of_module: `${result.level} Level Review`,
        content_text: aiModule.content,
        module_origin: 'ai_generated',
        source_resource_id: null,
        assigned_student_id: req.session.user.id
      });

      // Log AI generation
      await logAiGeneration({
        generation_type: 'module_from_result',
        student_id: req.session.user.id,
        subject_id: subjectId,
        resource_id: null,
        input_summary: `Assessment result: ${result.level} (${result.percentage.toFixed(1)}%)`,
        output_summary: `Generated ${result.level}-level module: ${aiModule.title}`,
        ai_provider: aiModule.provider,
        ai_model: aiModule.model,
        tokens_used: aiModule.tokensUsed,
        success: true
      });

      // Update learning cycle
      if (activeCycle) {
        await advanceLearningCycle(activeCycle.id, {
          status: 'module_generated',
          result_level: result.level,
          assessment_id: req.params.id
        });
      }

      setFlash(req, 'success', `Assessment submitted! Score: ${result.score}/${result.total_questions} (${result.percentage.toFixed(1)}%) — Level: ${result.level}. A new ${result.level}-level review module has been generated for you.`);
    } catch (aiError) {
      console.error('[Assessment Submit] Module generation failed:', aiError.message);
      setFlash(req, 'success', `Assessment submitted! Score: ${result.score}/${result.total_questions} (${result.percentage.toFixed(1)}%) — Level: ${result.level}. (Note: Follow-up module generation encountered an error.)`);
    }

    res.redirect(`/student/assessments/${req.params.id}`);
  } catch (error) {
    next(error);
  }
});

// Route handler: POST request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.post('/assessments/:id/reset', async (req, res, next) => {
  // Assessment retake is disabled — each assessment can only be taken once
  setFlash(req, 'error', 'Assessment retake is not allowed. Each assessment can only be taken once.');
  return res.redirect(`/student/assessments/${req.params.id}`);
});


// Route handler: GET request


// Purpose: Processes this endpoint and returns the correct view or action result.


router.get('/profile', async (req, res, next) => {
  try {
    const user = await getUserById(req.session.user.id);
    const subjectOverview = await getStudentSubjectsOverview(req.session.user.id);
    const shell = await buildShell(req, {
      pageTitle: 'Profile',
      section: 'profile',
      contentView: '../content/student-profile',
      profileUser: user,
      assignments: subjectOverview.enrolledSubjects,
      allSubjects: subjectOverview.allSubjects
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
    if (req.file) {
      req.session.user.image_path = `/uploads/profiles/${req.file.filename}`;
    }
    req.session.user.first_name = req.body.first_name || req.session.user.first_name;
    setFlash(req, 'success', 'Profile updated successfully.');
    res.redirect('/student/profile');
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// Phase 6: AI System — New student routes
// ============================================================================

// Mark a module as read
router.post('/subjects/:subjectId/modules/:resourceId/read', async (req, res, next) => {
  try {
    await markModuleRead(req.session.user.id, req.params.resourceId, req.params.subjectId);
    // Start learning cycle if none active
    const activeCycle = await getActiveLearningCycle(req.session.user.id, req.params.subjectId);
    if (!activeCycle) {
      await createLearningCycle(req.session.user.id, req.params.subjectId, Number(req.params.resourceId), 1);
    }
    setFlash(req, 'success', 'Module marked as read. You can now take the assessment.');
    res.redirect(`/student/subjects/${req.params.subjectId}`);
  } catch (error) {
    setFlash(req, 'error', error.message || 'Could not mark module as read.');
    res.redirect(`/student/subjects/${req.params.subjectId}`);
  }
});

// Request assessment approval from tutor (replaces direct generation)
router.post('/subjects/:subjectId/modules/:resourceId/request-assessment', async (req, res, next) => {
  try {
    const result = await createAssessmentRequest(req.session.user.id, Number(req.params.subjectId), Number(req.params.resourceId));
    // Emit real-time notification to the tutor
    const io = req.app.get('io');
    const onlineUsers = req.app.get('onlineUsers');
    if (io && result.tutorId) {
      const targetSocketId = onlineUsers.get(String(result.tutorId));
      if (targetSocketId) {
        io.to(targetSocketId).emit('new-assessment-request', {
          studentName: `${req.session.user.first_name} ${req.session.user.last_name}`,
          subjectId: req.params.subjectId,
          resourceId: req.params.resourceId,
          message: `${req.session.user.first_name} ${req.session.user.last_name} has requested assessment approval.`
        });
      }
    }
    setFlash(req, 'success', 'Assessment request sent to your tutor. You will be notified when approved.');
    res.redirect(`/student/subjects/${req.params.subjectId}`);
  } catch (error) {
    setFlash(req, 'error', error.message || 'Could not submit assessment request.');
    res.redirect(`/student/subjects/${req.params.subjectId}`);
  }
});

// Generate AI assessment from a module (only when tutor has approved)
router.post('/subjects/:subjectId/modules/:resourceId/generate-assessment', async (req, res, next) => {
  try {
    // Verify tutor has accepted the request
    const accepted = await getAcceptedAssessmentRequest(req.session.user.id, Number(req.params.subjectId), Number(req.params.resourceId));
    if (!accepted) {
      setFlash(req, 'error', 'You need tutor approval before taking this assessment. Please request approval first.');
      return res.redirect(`/student/subjects/${req.params.subjectId}`);
    }

    const { query } = require('../config/db');

    // CHECK: Did the tutor already generate an assessment when accepting?
    // Look for an existing AI assessment for this student + source resource
    const existingAssessment = await query(
      `SELECT TOP 1 id FROM assessments
       WHERE assigned_student_id = ? AND subject_id = ? AND source_resource_id = ?
         AND assessment_origin = 'ai_generated' AND is_published = 1
       ORDER BY created_at DESC`,
      [req.session.user.id, req.params.subjectId, req.params.resourceId]
    );
    if (existingAssessment.length) {
      // Assessment already exists — redirect student to take it
      setFlash(req, 'success', 'Your assessment is ready! Good luck!');
      return res.redirect(`/student/assessments/${existingAssessment[0].id}`);
    }

    // No pre-generated assessment found — generate one now (fallback)
    const subject = await getSubjectById(req.params.subjectId);
    const student = await getUserById(req.session.user.id);
    if (!subject || !student) throw new Error('Subject or student not found.');

    // Get the module content — trace through source_resource_id chain
    const moduleRows = await query('SELECT TOP 1 * FROM subject_resources WHERE id = ?', [req.params.resourceId]);
    const module_ = moduleRows[0];
    if (!module_) throw new Error('Module not found.');

    let moduleContent = module_.content_text || '';
    let moduleTitle = module_.title || '';

    // If no content_text, trace through source_resource_id (for tutor_share modules)
    if (!moduleContent && module_.source_resource_id) {
      const sourceRows = await query('SELECT TOP 1 * FROM subject_resources WHERE id = ?', [module_.source_resource_id]);
      if (sourceRows.length) {
        moduleContent = sourceRows[0].content_text || sourceRows[0].description || '';
        moduleTitle = sourceRows[0].title || moduleTitle;
        // If source is also AI-generated, trace deeper
        if (!moduleContent && sourceRows[0].source_resource_id) {
          const deepRows = await query('SELECT TOP 1 * FROM subject_resources WHERE id = ?', [sourceRows[0].source_resource_id]);
          if (deepRows.length) {
            moduleContent = deepRows[0].content_text || deepRows[0].description || '';
            moduleTitle = deepRows[0].title || moduleTitle;
          }
        }
      }
    }

    // Fallback: get ANY admin module with content for this subject
    if (!moduleContent) {
      const adminModules = await getAdminSubjectResources(req.params.subjectId);
      for (const am of adminModules) {
        const content = am.content_text || am.description || '';
        if (content && content.length >= 10) {
          moduleContent = content;
          moduleTitle = am.title || moduleTitle;
          break;
        }
      }
    }

    // Last resort: use title + description as context
    if (!moduleContent || moduleContent.length < 10) {
      moduleContent = `${module_.title || ''}\n${module_.description || ''}`.trim();
    }

    if (!moduleContent || moduleContent.length < 5) {
      setFlash(req, 'error', 'No module content found for this subject. Please ask admin to add content to the module.');
      return res.redirect(`/student/subjects/${req.params.subjectId}`);
    }

    const levelGroup = student.education_level_group || student.year_level || '';
    const questionCount = 20; // Default fallback; tutor-specified count is used in tutor accept route

    // Generate assessment via AI based on module content
    const aiResult = await generateAssessmentFromModule({
      moduleContent,
      subject: subject.name,
      levelGroup,
      questionCount
    });

    // Log AI generation
    await logAiGeneration({
      generation_type: 'assessment_from_module',
      student_id: req.session.user.id,
      subject_id: req.params.subjectId,
      resource_id: req.params.resourceId,
      input_summary: `Module: ${moduleTitle} | Fallback generation`,
      output_summary: `Generated ${aiResult.questions.length} questions`,
      ai_provider: aiResult.provider,
      ai_model: aiResult.model,
      tokens_used: aiResult.tokensUsed,
      success: true
    });

    // Get or create learning cycle
    let activeCycle = await getActiveLearningCycle(req.session.user.id, req.params.subjectId);
    if (!activeCycle) {
      const cycleId = await createLearningCycle(req.session.user.id, req.params.subjectId, Number(req.params.resourceId), 1);
      activeCycle = { id: cycleId, round_number: 1 };
    }

    // Create assessment in database
    const assessmentTitle = `AI Assessment: ${subject.name} — Round ${activeCycle.round_number}`;
    const assessmentResult = await query(
      `INSERT INTO assessments (title, subject_id, assigned_student_id, assessment_type, source_resource_id, assessment_origin, cycle_id, max_violations, time_limit_minutes)
       VALUES (?, ?, ?, 'post', ?, 'ai_generated', ?, 3, NULL)`,
      [assessmentTitle, req.params.subjectId, req.session.user.id, req.params.resourceId, activeCycle.id]
    );
    const assessmentId = assessmentResult.insertId;

    // Insert questions
    for (const q of aiResult.questions) {
      await query(
        `INSERT INTO assessment_questions (assessment_id, question_text, question_type, choice_a, choice_b, choice_c, choice_d, correct_answer, explanation, answer_rubric)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [assessmentId, q.question_text, q.question_type, q.choice_a || '', q.choice_b || '', q.choice_c || '', q.choice_d || '', q.correct_answer, q.explanation || '', q.answer_rubric || '']
      );
    }

    // Update learning cycle
    await advanceLearningCycle(activeCycle.id, {
      status: 'assessment_pending',
      assessment_id: assessmentId
    });

    setFlash(req, 'success', `AI Assessment generated with ${aiResult.questions.length} questions. Good luck!`);
    res.redirect(`/student/assessments/${assessmentId}`);
  } catch (error) {
    setFlash(req, 'error', error.message || 'Could not generate assessment.');
    res.redirect(`/student/subjects/${req.params.subjectId}`);
  }
});

// Anti-cheat event logging (receives beacon/XHR from client)
router.post('/assessments/:id/anti-cheat', express.json(), async (req, res) => {
  try {
    const result = await logAntiCheatEvent(
      req.params.id,
      req.session.user.id,
      req.body.event_type || 'unknown',
      req.body.event_detail || null
    );
    res.json({ ok: true, violationCount: result.violationCount });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Pay online (supports PayMongo or Mock)
router.post('/billing/pay-online', async (req, res, next) => {
  try {
    const amount = Number(req.body.amount);
    // Backend validation: minimum ₱500
    if (!amount || amount < 500) {
      setFlash(req, 'error', 'Minimum payment amount is ₱500.');
      return res.redirect('/student/billing');
    }
    const student = await getUserById(req.session.user.id);
    const result = await createPayMongoPayment(req.session.user.id, amount, {
      name: `${student.first_name} ${student.last_name}`,
      email: student.email || '',
      phone: student.contact_number || ''
    });

    // If PayMongo returned a checkout URL, redirect to it
    if (result.checkoutUrl) {
      return res.redirect(result.checkoutUrl);
    }

    // Mock payment completed instantly
    setFlash(req, 'success', `Payment of ₱${amount.toFixed(2)} completed. Reference: ${result.providerReference}`);
    res.redirect('/student/billing');
  } catch (error) {
    setFlash(req, 'error', error.message || 'Payment failed.');
    res.redirect('/student/billing');
  }
});

// Analytics & Reports page
router.get('/analytics', async (req, res, next) => {
  try {
    const assignments = await getStudentAssignments(req.session.user.id);
    const subjects = [];
    for (const assignment of assignments) {
      const analytics = await getStudentAnalytics(req.session.user.id, assignment.subject_id);
      if (analytics) subjects.push(analytics);
    }
    const shell = await buildShell(req, {
      pageTitle: 'Analytics & Reports',
      section: 'analytics',
      contentView: '../content/student-analytics',
      subjects
    });
    res.render('shells/dashboard', shell);
  } catch (error) {
    next(error);
  }
});

// ==========================================================================
// Phase 6: Module Level System — Pre-Assessment, Module View, Assessment
// ==========================================================================

// --------------------------------------------------------------------------
// Pre-Assessment (overhaul Phase 6)
//
// The Pre-Assessment is generated from the subject's handouts, not written by a
// tutor. It gates every module and handout in the subject until it is completed.
// --------------------------------------------------------------------------

/**
 * Confirm the student is enrolled in this subject.
 * Returns the assignment, or null after setting a flash + redirect target.
 */
async function requireEnrolment(req, subjectId) {
  const assignments = await getStudentAssignments(req.session.user.id);
  return assignments.find((a) => Number(a.subject_id) === Number(subjectId)) || null;
}

router.get('/subjects/:subjectId/pre-assessment', async (req, res, next) => {
  const subjectId = Number(req.params.subjectId);
  try {
    const assignment = await requireEnrolment(req, subjectId);
    if (!assignment) {
      setFlash(req, 'error', 'Subject not found in your account.');
      return res.redirect('/student/subjects');
    }

    // Already done: send them to their result rather than letting them retake it.
    const done = await hasCompletedPreAssessment(req.session.user.id, subjectId);
    if (done) {
      setFlash(req, 'info', 'You have already completed the Pre-Assessment for this subject.');
      return res.redirect(`/student/results/${done.id}`);
    }

    let assessment;
    try {
      // Size comes from config/assessmentDefaults.js (30), never a literal here.
      const result = await getOrCreatePreAssessment(subjectId);
      assessment = result.assessment;
    } catch (error) {
      // No handouts yet, or generation failed. Say so plainly instead of showing
      // an empty exam.
      setFlash(req, 'error', error.message || 'The Pre-Assessment is not ready yet.');
      return res.redirect(`/student/subjects/${subjectId}`);
    }

    const shell = await buildShell(req, {
      pageTitle: `Pre-Assessment — ${assignment.subject_name}`,
      section: 'subjects',
      contentView: '../content/student-pre-assessment',
      assessment,
      assignment,
      subjectId,
      startedAt: new Date().toISOString()
    });
    res.render('shells/dashboard', shell);
  } catch (error) { next(error); }
});

router.post('/subjects/:subjectId/pre-assessment', async (req, res, next) => {
  const subjectId = Number(req.params.subjectId);
  try {
    const assignment = await requireEnrolment(req, subjectId);
    if (!assignment) {
      setFlash(req, 'error', 'Subject not found in your account.');
      return res.redirect('/student/subjects');
    }

    const assessmentId = Number(req.body.assessment_id);
    const assessment = await getAssessmentWithQuestions(assessmentId);
    if (!assessment || Number(assessment.subject_id) !== subjectId || assessment.assessment_kind !== 'pre_assessment') {
      setFlash(req, 'error', 'That Pre-Assessment does not belong to this subject.');
      return res.redirect(`/student/subjects/${subjectId}`);
    }

    // answer_<questionId> from the form.
    const answers = [];
    for (const key of Object.keys(req.body)) {
      if (!key.startsWith('answer_')) continue;
      answers.push({ question_id: Number(key.slice(7)), student_answer: req.body[key] });
    }

    const result = await gradeAndSubmitAssessment({
      assessment_id: assessmentId,
      student_id: req.session.user.id,
      answers,
      started_at: req.body.started_at || null
    });

    // Record the classification against the subject so tutors see it at a glance.
    await setStudentSubjectLevel({
      student_id: req.session.user.id,
      subject_id: subjectId,
      level: result.level,
      pre_assessment_id: assessmentId,
      score: Math.round(result.score),
      total_points: result.totalPoints,
      percentage: result.percentage
    }).catch((error) => console.error('[pre-assessment] could not save subject level:', error.message));

    setFlash(req, 'success', `Pre-Assessment submitted. Your level: ${result.level} (${result.percentage}%). Your modules are now unlocked.`);
    res.redirect(`/student/results/${result.submissionId}`);
  } catch (error) {
    setFlash(req, 'error', error.message || 'Could not submit the Pre-Assessment.');
    res.redirect(`/student/subjects/${subjectId}`);
  }
});

// Result page: percentage, classification, per-item breakdown and weak areas.
router.get('/results/:submissionId', async (req, res, next) => {
  try {
    const submission = await getSubmissionWithAnswers(Number(req.params.submissionId));
    if (!submission) {
      setFlash(req, 'error', 'Result not found.');
      return res.redirect('/student/subjects');
    }
    // A student may only open their own result.
    if (Number(submission.student_id) !== Number(req.session.user.id)) {
      setFlash(req, 'error', 'You can only view your own results.');
      return res.redirect('/student/subjects');
    }

    const weakAreas = await getWeakAreasForSubmission(submission.id);
    const shell = await buildShell(req, {
      pageTitle: submission.title,
      section: 'subjects',
      contentView: '../content/student-assessment-breakdown',
      submission,
      weakAreas,
      viewerRole: 'student'
    });
    res.render('shells/dashboard', shell);
  } catch (error) { next(error); }
});

// Student: View module detail page
router.get('/modules/:moduleId', async (req, res, next) => {
  try {
    const studentId = req.session.user.id;
    const { query: dbQuery } = require('../config/db');

    const moduleRows = await dbQuery(
      'SELECT m.*, s.name as subject_name FROM modules m JOIN subjects s ON s.id = m.subject_id WHERE m.id = ? AND m.is_archived = 0',
      [req.params.moduleId]
    );
    if (!moduleRows.length) {
      setFlash(req, 'error', 'Module not found.');
      return res.redirect('/student/subjects');
    }
    const mod = moduleRows[0];

    // ---- Lock (spec Section 5, acceptance item 5) -------------------------
    // Enforced here on the server, not by hiding a link: a student who types the
    // URL must be stopped too.
    //
    // Enrolment first, then the Pre-Assessment gate, then year-level targeting.
    const assignments = await getStudentAssignments(studentId);
    if (!assignments.some((a) => Number(a.subject_id) === Number(mod.subject_id))) {
      setFlash(req, 'error', 'You are not enrolled in that subject.');
      return res.redirect('/student/subjects');
    }

    const preDone = await hasCompletedPreAssessment(studentId, mod.subject_id);
    if (!preDone) {
      setFlash(req, 'error', 'Please complete the Pre-Assessment for this subject before opening its modules.');
      return res.redirect(`/student/subjects/${mod.subject_id}`);
    }

    // Year-level targeting. moduleTargetsStudent matches the exact label against
    // year_level AND grade_level — deliberately not the collapsed key, which
    // would treat "Kinder 1" and "Grade 5" as the same audience.
    //
    // The student is loaded from the DB, NOT from req.session.user: neither the
    // login query nor setUserLocals selects year_level/grade_level, so the session
    // copy has neither. Passing it here made the check find no year level at all
    // and lock students out of their own modules.
    const studentRecord = await getUserById(studentId);
    if (!moduleTargetsStudent(mod, studentRecord)) {
      setFlash(req, 'error', 'This module is not assigned to your year level.');
      return res.redirect(`/student/subjects/${mod.subject_id}`);
    }

    const studentLevel = await getStudentSubjectLevel(studentId, mod.subject_id);
    const handouts = await getModuleHandouts(mod.id);

    // Get assessments and submissions for this module
    const assessments = await getTutorAssessmentsByModule(mod.id);
    const submissions = await getStudentSubmissions(studentId, mod.subject_id);

    // Calculate progress
    const activities = assessments.filter(a => a.purpose === 'activity');
    const postAssessments = assessments.filter(a => a.purpose === 'post');
    const completedActivities = activities.filter(a => submissions.some(s => Number(s.assessment_id) === Number(a.id)));
    const completedPost = postAssessments.filter(a => submissions.some(s => Number(s.assessment_id) === Number(a.id)));

    // Progress: handout (always available) + activities + post
    const totalTasks = 1 + activities.length + postAssessments.length; // 1 for handout
    const completedTasks = completedActivities.length + completedPost.length;
    // We count handout as completed if student has viewed it (we'll track via query param)
    const progressPercent = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    const shell = await buildShell(req, {
      pageTitle: `${mod.title} — ${mod.level}`,
      section: 'subjects',
      contentView: '../content/student-module-view',
      mod,
      assessments,
      submissions,
      activities,
      postAssessments,
      completedActivities,
      completedPost,
      progressPercent,
      totalTasks,
      completedTasks,
      studentLevel,
      handouts
    });
    res.render('shells/dashboard', shell);
  } catch (error) { next(error); }
});

// Student: Take a tutor assessment (activity or post)
router.get('/tutor-assessments/:id', async (req, res, next) => {
  try {
    const assessment = await getTutorAssessmentById(Number(req.params.id));
    if (!assessment) {
      setFlash(req, 'error', 'Assessment not found.');
      return res.redirect('/student/subjects');
    }

    // Check enrollment
    const assignments = await getStudentAssignments(req.session.user.id);
    const assignment = assignments.find(a => Number(a.subject_id) === Number(assessment.subject_id));
    if (!assignment) {
      setFlash(req, 'error', 'You are not enrolled in this subject.');
      return res.redirect('/student/subjects');
    }

    // Check if already submitted
    const submissions = await getStudentSubmissions(req.session.user.id, assessment.subject_id);
    const alreadySubmitted = submissions.find(s => Number(s.assessment_id) === Number(assessment.id));
    if (alreadySubmitted) {
      setFlash(req, 'info', 'You have already completed this assessment.');
      return res.redirect(`/student/assessment-result/${alreadySubmitted.id}`);
    }

    const shell = await buildShell(req, {
      pageTitle: assessment.title,
      section: 'subjects',
      contentView: '../content/student-take-tutor-assessment',
      assessment,
      subjectId: assessment.subject_id,
      subjectName: assignment.subject_name,
      isPre: false
    });
    res.render('shells/dashboard', shell);
  } catch (error) { next(error); }
});

// Student: Submit a tutor assessment (activity or post)
router.post('/tutor-assessments/:id/submit', async (req, res, next) => {
  try {
    const assessmentId = Number(req.params.id);
    const studentId = req.session.user.id;

    const assessment = await getTutorAssessmentById(assessmentId);
    if (!assessment) {
      setFlash(req, 'error', 'Assessment not found.');
      return res.redirect('/student/subjects');
    }

    // Build answers from form
    const answers = [];
    for (const key of Object.keys(req.body)) {
      if (key.startsWith('answer_')) {
        const questionId = Number(key.replace('answer_', ''));
        answers.push({ question_id: questionId, student_answer: req.body[key] });
      }
    }

    const result = await submitTutorAssessment({
      assessment_id: assessmentId,
      student_id: studentId,
      answers
    });

    setFlash(req, 'success', `Assessment submitted! Score: ${result.score}/${result.total} (${Number(result.percentage).toFixed(1)}%)`);
    res.redirect(`/student/assessment-result/${result.submissionId}`);
  } catch (error) {
    setFlash(req, 'error', error.message || 'Could not submit assessment.');
    res.redirect('/student/subjects');
  }
});

// Student: View assessment result
router.get('/assessment-result/:submissionId', async (req, res, next) => {
  try {
    const { query: dbQuery } = require('../config/db');
    const submissions = await dbQuery(
      `SELECT tas.*, ta.title as assessment_title, ta.purpose, ta.instructions,
              m.level, m.title as module_title, m.id as module_id, s.name as subject_name
       FROM tutor_assessment_submissions tas
       JOIN tutor_assessments ta ON ta.id = tas.assessment_id
       JOIN modules m ON m.id = ta.module_id
       JOIN subjects s ON s.id = ta.subject_id
       WHERE tas.id = ? AND tas.student_id = ?`,
      [req.params.submissionId, req.session.user.id]
    );
    if (!submissions.length) {
      setFlash(req, 'error', 'Result not found.');
      return res.redirect('/student/subjects');
    }
    const submission = submissions[0];

    const answers = await dbQuery(
      `SELECT tsa.*, taq.question_text, taq.question_type, taq.points, taq.explanation
       FROM tutor_student_answers tsa
       JOIN tutor_assessment_questions taq ON taq.id = tsa.question_id
       WHERE tsa.submission_id = ?
       ORDER BY taq.id ASC`,
      [req.params.submissionId]
    );

    const isPre = req.query.isPre === '1';
    const assignedLevel = req.query.level || null;

    const shell = await buildShell(req, {
      pageTitle: `Result: ${submission.assessment_title}`,
      section: 'subjects',
      contentView: '../content/student-assessment-result',
      submission,
      answers,
      isPre,
      assignedLevel
    });
    res.render('shells/dashboard', shell);
  } catch (error) { next(error); }
});

// Student: Progress page
router.get('/progress', async (req, res, next) => {
  try {
    const progress = await getStudentProgress(req.session.user.id);
    const assignments = await getStudentAssignments(req.session.user.id);

    // For each subject with a level, get submission stats
    const enrichedProgress = [];
    for (const p of progress) {
      const submissions = await getStudentSubmissions(req.session.user.id, p.subject_id);
      const assignedModule = await getModuleBySubjectAndLevel(p.subject_id, p.level);
      enrichedProgress.push({
        ...p,
        submissions,
        assignedModule,
        totalSubmissions: submissions.length,
        avgScore: submissions.length > 0
          ? (submissions.reduce((sum, s) => sum + Number(s.percentage || 0), 0) / submissions.length).toFixed(1)
          : '0.0'
      });
    }

    const shell = await buildShell(req, {
      pageTitle: 'My Progress',
      section: 'progress',
      contentView: '../content/student-progress',
      progress: enrichedProgress,
      assignments
    });
    res.render('shells/dashboard', shell);
  } catch (error) { next(error); }
});

module.exports = router;
