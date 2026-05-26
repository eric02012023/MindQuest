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
  getSubjectAssessmentForStudent
} = require('../lib/data');
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

    const shell = await buildShell(req, {
      pageTitle: assignment.subject_name,
      section: 'subjects',
      contentView: '../content/student-subject-detail',
      assignment,
      resources,
      modules,
      activeCycle,
      tutor,
      attendanceLogs,
      assessmentRequests,
      completedAssessments,
      subjectAssessments,
      preAssessment,
      postAssessment,
      preAssessmentRequired,
      preAssessmentTaken
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

    // Auto-generate a follow-up module based on the result
    try {
      const { generateModuleFromAssessmentResult } = require('../services/aiService');
      const { query: dbQuery } = require('../config/db');

      // Get the source module content — trace through source_resource_id chain
      const sourceResourceId = assessment.source_resource_id;
      let originalContent = '';
      let originalTitle = '';
      let subjectName = assessment.subject_name || '';
      const subjectId = assessment.subject_id;

      if (sourceResourceId) {
        const moduleRows = await dbQuery('SELECT TOP 1 * FROM subject_resources WHERE id = ?', [sourceResourceId]);
        if (moduleRows.length) {
          originalContent = moduleRows[0].content_text || '';
          originalTitle = moduleRows[0].title || '';
          // If no content_text, trace through source_resource_id (tutor_share or AI modules)
          if (!originalContent && moduleRows[0].source_resource_id) {
            const sourceRows = await dbQuery('SELECT TOP 1 * FROM subject_resources WHERE id = ?', [moduleRows[0].source_resource_id]);
            if (sourceRows.length) {
              originalContent = sourceRows[0].content_text || sourceRows[0].description || '';
              originalTitle = sourceRows[0].title || originalTitle;
              // Trace one more level if needed
              if (!originalContent && sourceRows[0].source_resource_id) {
                const deepRows = await dbQuery('SELECT TOP 1 * FROM subject_resources WHERE id = ?', [sourceRows[0].source_resource_id]);
                if (deepRows.length) {
                  originalContent = deepRows[0].content_text || deepRows[0].description || '';
                  originalTitle = deepRows[0].title || originalTitle;
                }
              }
            }
          }
          // Use description as fallback
          if (!originalContent) {
            originalContent = moduleRows[0].description || '';
          }
        }
      }

      // Fallback: get any admin module with content for this subject
      if (!originalContent && subjectId) {
        const adminModules = await getAdminSubjectResources(subjectId);
        for (const am of adminModules) {
          const content = am.content_text || am.description || '';
          if (content && content.length >= 10) {
            originalContent = content;
            originalTitle = am.title || originalTitle;
            break;
          }
        }
      }

      // Last resort: use title + description
      if (!originalContent || originalContent.length < 10) {
        originalContent = `${originalTitle}\n${assessment.title || ''}`.trim();
      }

      if (!subjectName && subjectId) {
        const subj = await getSubjectById(subjectId);
        if (subj) subjectName = subj.name;
      }

      const student = await getUserById(req.session.user.id);
      const levelGroup = student?.education_level_group || student?.year_level || '';

      // Get or create learning cycle
      let activeCycle = await getActiveLearningCycle(req.session.user.id, subjectId);
      if (!activeCycle && sourceResourceId) {
        const cycleId = await createLearningCycle(req.session.user.id, subjectId, Number(sourceResourceId), 1);
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
    <p><strong>Student:</strong> ${studentName}</p>
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
        source_resource_id: sourceResourceId || null,
        assigned_student_id: req.session.user.id
      });

      // Log AI generation
      await logAiGeneration({
        generation_type: 'module_from_result',
        student_id: req.session.user.id,
        subject_id: subjectId,
        resource_id: sourceResourceId || null,
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

module.exports = router;
