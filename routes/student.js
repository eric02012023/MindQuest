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
  getAllowedContacts,
  getConversation,
  saveMessage,
  getMessageById,
  updateMessageBody,
  unsendMessage,
  getUserById,
  getSubjectResources,
  updateUser,
  getAssessmentById,
  submitAssessment,
  getAttendanceBySubject,
  getTutorAvailabilityForSubject,
  getTutorAvailabilityForStudent,
  createTutorScheduleApplication,
  createTutorScheduleApplicationForAllSubjects,
  getStudentScheduleNotifications,
  markStudentScheduleNotificationRead,
  // Phase 2: AI system imports
  getModulesForStudent,
  getStudentAnalytics,
  logAntiCheatEvent,
  getAntiCheatViolationCount,
  createOnlinePayment,
  completeOnlinePayment,
  reconcilePayMongoPayments,
  // Phase 3: Assessment requests, PayMongo
  createPayMongoPayment,
  getAdminSubjectResources,
  // Phase 4: Admin pre/post assessments
  // Phase 5/6: Module & Level System
  getStudentSubjectLevel,
  getModuleBySubjectAndLevel,
  getModulesBySubject,
  getTutorAssessmentsByModule,
  getTutorAssessmentById,
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
  // Post-Assessment (Phase 8)
  recordModuleOpen,
  getStudentSubjectCompletion,
  getPostAssessment,
  getSubjectPrePostComparison,
  moduleTargetsStudent,
  // --- Management upgrade -------------------------------------------------
  // Merged "Billing Data" (SOA + payment history in one) and the cash Pay flow
  getStudentBillingData,
  STUDENT_PAYMENT_METHODS,
  studentPaymentMethodsFor,
  PAYMENT_PURPOSES,
  createPaymentRequest,
  getStudentPaymentRequests,
  // The Pre-Assessment is gated on the ₱500 down payment (Phase 2.1).
  getDownPaymentStatus,
  downPaymentBlockMessage,
  notifyAdminRoles,
  getBranches,
  // Analytics & Reports, scoped to this student at the query level
  getAnalyticsDashboard,
  getFocusHandoutsForStudent,
  // Anti-cheating
  recordViolation,
  attachViolationsToSubmission,
  markSubmissionAutoSubmitted,
  getViolationSessionCount,
  MAX_VIOLATIONS,
  // Auto weak-topic handout after a Pre-Assessment
  runPreAssessmentFollowUp
} = require('../lib/data');
const { determineLevel } = require('../config/levelThresholds');
const { normalizeArray } = require('../lib/utils');
// Phase 3: cash is a POS transaction now. The student's side ends at a slip.
const { buildSlipModel, renderSlipPdf, slipFilename, slipCode, formatSlipDate } = require('../lib/paymentSlip');

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
    const tutor = assignment.tutor_internal_id ? await getUserById(assignment.tutor_internal_id) : null;
    const attendanceLogs = await getAttendanceBySubject(req.session.user.id, req.params.subjectId);

    // Phase 9: this route used to load three competing answers to "what does this
    // student do next?" — a Gen 1 learning cycle, a Gen 2 admin pre/post pair with
    // its own lock flag, and a Gen 3 level-gated single module — plus the pending
    // AI assessments and tutor pre-assessments that went with them. The view had to
    // guess which one won, which is what produced the stale-data symptom in the
    // audit. One source of truth now: the Pre-Assessment gate, the modules targeted
    // at this student, and the Post-Assessment.
    // ---- Module system (overhaul Phase 6) --------------------------------
    // The Pre-Assessment gates everything below it. newModules is already
    // filtered to this student's year level.
    const preAssessmentDone = await hasCompletedPreAssessment(req.session.user.id, Number(req.params.subjectId));
    const newModules = await getStudentSubjectModules(req.session.user.id, Number(req.params.subjectId));
    const handoutsReady = (await getSubjectHandoutTexts(Number(req.params.subjectId))).length;
    // Phase 2.1: the Pre-Assessment needs the ₱500 down payment. The route
    // enforces it; this is only so the page can say so before they click.
    const downPayment = await getDownPaymentStatus(req.session.user.id);

    // ---- Post-Assessment (Phase 8) ---------------------------------------
    // The student sees how close they are to the end of the cycle, and the
    // pre-vs-post comparison once both attempts exist.
    const completion = await getStudentSubjectCompletion(req.session.user.id, Number(req.params.subjectId));
    const postAssessmentOpen = await getPostAssessment(Number(req.params.subjectId));
    const comparison = (await getSubjectPrePostComparison(Number(req.params.subjectId)))
      .find((row) => Number(row.student_id) === Number(req.session.user.id)) || null;

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
      downPayment,
      completion,
      postAssessmentOpen,
      comparison,
      tutor,
      attendanceLogs
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

/**
 * Billing Data — the merged section.
 *
 * "Posted SOA / Billing" and "Payment History" were two panels answering halves
 * of the same question ("what do I owe, and what have I paid?"), and a student
 * had to add them up themselves. They are now one view built from one call, so
 * the balance shown and the payments listed cannot disagree.
 */
router.get('/billing', async (req, res, next) => {
  try {
    // Back from PayMongo (or with a checkout still open): ask PayMongo whether
    // it was paid and record it now, rather than waiting on the webhook. Done
    // before the page's figures are read, so the balance shown is the new one.
    const returning = req.query.payment === 'success';
    let paymentCheck = null;
    try {
      paymentCheck = await reconcilePayMongoPayments(req.session.user.id);
    } catch (error) {
      console.error('[PayMongo] reconcile failed:', error.message);
    }
    if (paymentCheck && paymentCheck.completed.length) {
      const total = paymentCheck.completed.reduce((sum, value) => sum + value, 0);
      res.locals.flash = { type: 'success', message: `Payment received — ₱${total.toFixed(2)} is now recorded on your account. Thank you!` };
    } else if (returning) {
      res.locals.flash = {
        type: 'info',
        message: 'PayMongo has not confirmed your payment yet. It is recorded here automatically as soon as it is — open Billing Data again in a minute.'
      };
    } else if (req.query.payment === 'cancelled') {
      res.locals.flash = { type: 'info', message: 'Payment cancelled. Nothing was charged.' };
    }

    const [billingData, branches] = await Promise.all([
      getStudentBillingData(req.session.user.id),
      getBranches()
    ]);

    // "Cash Pay (at Main Branch)" — the label names the branch this student may
    // actually pay at, rather than leaving them to guess which one is meant.
    const studentBranch = (branches || []).find((b) => Number(b.id) === Number(req.session.user.branch_id));
    const branchName = studentBranch?.name || '';

    const shell = await buildShell(req, {
      pageTitle: 'Billing Data',
      section: 'billing',
      contentView: '../content/student-billing',
      billingData,
      branches,
      branchName,
      paymentMethods: studentPaymentMethodsFor(branchName),
      paymentPurposes: PAYMENT_PURPOSES,
      openPay: req.query.pay === '1'
    });
    res.render('shells/dashboard', shell);
  } catch (error) {
    next(error);
  }
});

/**
 * Everything one payment slip is built from, for whichever student is asking.
 *
 * Shared by the HTML slip and the PDF so the two cannot show different numbers —
 * the student shows one of them at the counter and the cashier reads the other
 * off the POS, and a disagreement between them is an argument at the desk.
 */
async function loadSlip(req) {
  const [student, branches, assignments] = await Promise.all([
    getUserById(req.session.user.id),
    getBranches(),
    getStudentAssignments(req.session.user.id)
  ]);
  const branch = (branches || []).find((b) => Number(b.id) === Number(student.branch_id));

  // The most recent slip this student has open. A slip is a payment_requests row
  // — see lib/paymentSlip.js for why that table rather than a new one.
  const requests = await getStudentPaymentRequests(req.session.user.id);
  const request = requests.find((r) => r.status === 'pending') || null;

  const model = await buildSlipModel({
    student,
    branchName: branch?.name || '',
    assignments,
    request
  });
  return { model, request, student };
}

/**
 * The payment slip — "this is what I owe" — as a page.
 *
 * This REPLACED the old cash-payment form. Cash is taken at the counter on the
 * POS now, so nothing here moves money: the student's side of a cash payment
 * ends with a statement they can show, print or save.
 */
router.get('/billing/slip', async (req, res, next) => {
  try {
    const { model, request } = await loadSlip(req);
    const shell = await buildShell(req, {
      pageTitle: 'Payment Slip',
      section: 'billing',
      contentView: '../content/student-payment-slip',
      slip: model,
      slipRequest: request,
      paymentPurposes: PAYMENT_PURPOSES,
      // The slip's own date format, shared with the PDF so the two documents
      // never word the same date differently.
      formatSlipDate
    });
    res.render('shells/dashboard', shell);
  } catch (error) {
    next(error);
  }
});

/** The same slip as a real file, to keep, print, or send to a parent. */
router.get('/billing/slip.pdf', async (req, res, next) => {
  try {
    const { model } = await loadSlip(req);
    const pdf = renderSlipPdf(model);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdf.length);
    // `inline` so a phone opens it in the viewer — the student is going to SHOW
    // this at a counter, and forcing a download first would be in the way. The
    // filename still applies when they choose to save it.
    res.setHeader('Content-Disposition', `inline; filename="${slipFilename(model)}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(pdf);
  } catch (error) {
    next(error);
  }
});

/**
 * Issue a slip: record what the student intends to pay, then show it to them.
 *
 * Still a PaymentRequest row, and still Pending until the counter records the
 * money — the difference from the old flow is what the student is shown
 * afterwards, and that the office completes it from the POS rather than from a
 * notification.
 */
async function issuePaymentSlip(req, res) {
  try {
    const student = await getUserById(req.session.user.id);
    const branches = await getBranches();
    const branch = (branches || []).find((b) => Number(b.id) === Number(student.branch_id));
    const branchId = Number(student.branch_id) || Number(req.body.branch_id) || null;

    const request = await createPaymentRequest({
      student,
      amount: req.body.amount,
      paymentMethod: 'cash',
      purpose: req.body.purpose,
      referenceNote: req.body.reference_note || null,
      branchId,
      branchName: branch?.name || ''
    });

    const studentName = [student.first_name, student.last_name].filter(Boolean).join(' ');
    const branchName = branch?.name || 'Unassigned branch';
    await notifyAdminRoles({
      type: 'payment_slip',
      title: `Pending payment slip — ${studentName}`,
      message: `${studentName} (${student.user_id}) generated ${slipCode(request.id)} for ₱${request.amount.toFixed(2)} `
        + `to pay at ${branchName}. Record it on the POS when they arrive.`,
      linkPath: `/pos?slip=${request.id}`,
      refType: 'payment_request',
      refId: request.id,
      branchId,
      severity: 'info'
    }).catch((error) => console.error('[payment-slip] could not notify staff:', error.message));

    setFlash(req, 'success', `Payment slip ${slipCode(request.id)} is ready. Show it at ${branchName}.`);
    return res.redirect('/student/billing/slip');
  } catch (error) {
    setFlash(req, 'error', error.message || 'Could not generate that payment slip.');
    return res.redirect('/student/billing');
  }
}

router.post('/billing/slip', issuePaymentSlip);

/**
 * The old "reserve a cash payment" endpoint.
 *
 * It is now the slip route under another name. Keeping it as a delegation rather
 * than deleting it means a stale tab, a bookmarked form or a back-button repost
 * still does the right thing instead of 404ing — and, more importantly, there is
 * only ONE piece of code that can open a cash payment. Two endpoints that both
 * created requests would drift, and a student could end up with a request the
 * POS screen never lists.
 */
router.post('/billing/pay-request', issuePaymentSlip);

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

    // The Gen 1 follow-up generator lived here (Phase 9). On every submit it built
    // an AI "review module", wrote it to public/uploads/ai-modules as a standalone
    // HTML page that pulled a markdown parser from a CDN, filed it back into
    // subject_resources, and advanced a student_learning_cycles row. None of that is
    // in the current spec, and the CDN script made those pages the only part of the
    // system that depended on an outside host at view time.
    setFlash(req, 'success', `Assessment submitted. Score: ${result.score}/${result.total_questions} (${result.percentage.toFixed(1)}%) — Level: ${result.level}.`);

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
// Phase 9 note: three routes lived here and are gone.
//
//   POST /subjects/:id/modules/:resourceId/read
//   POST /subjects/:id/modules/:resourceId/request-assessment
//   POST /subjects/:id/modules/:resourceId/generate-assessment
//
// They were the Gen 1 loop: mark a legacy resource read, ask the tutor for
// permission, then have AI build a one-off assessment and advance a
// student_learning_cycles row. The overhauled system answers the same need
// differently and without the round trip — the Pre-Assessment is generated from
// the subject handouts and served automatically, the tutor writes their own
// module assessments, and the Post-Assessment closes the cycle. Keeping both
// live was the duplication behind the stale-data bugs in the original audit.
//
// The tables are untouched, so existing records still read.
// ============================================================================
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

/**
 * The live anti-cheat endpoint (upgrade Section 8).
 *
 * `:id` is a tutor_assessments id — the table every assessment a student
 * actually sits lives in. The older route above writes to
 * assessment_anti_cheat_logs, whose foreign key points at the legacy
 * `assessments` table; it stays for the legacy pages that still call it.
 *
 * The response is what drives the warning modals: the client reports an event
 * and is TOLD which strike it was and whether the sitting is over. Counting on
 * the client would put the number a student sees under their own control.
 */
router.post('/assessments/:id/violation', express.json(), async (req, res) => {
  try {
    const assessmentId = Number(req.params.id);

    // A student may only log violations against an assessment in a subject they
    // are enrolled in — otherwise this endpoint would write rows for any id.
    const assessment = await getTutorAssessmentById(assessmentId);
    if (!assessment) return res.status(404).json({ ok: false, error: 'Assessment not found.' });

    const assignments = await getStudentAssignments(req.session.user.id);
    if (!assignments.some((a) => Number(a.subject_id) === Number(assessment.subject_id))) {
      return res.status(403).json({ ok: false, error: 'Not enrolled in this subject.' });
    }

    const result = await recordViolation({
      assessmentId,
      studentId: req.session.user.id,
      type: req.body.type,
      detail: req.body.detail,
      sessionKey: req.body.session_key
    });

    res.json({
      ok: true,
      count: result.sessionCount,
      total: result.totalCount,
      limit: result.limit,
      autoSubmit: result.shouldAutoSubmit,
      label: result.label
    });
  } catch (error) {
    console.error('[anti-cheat]', error.message);
    res.status(500).json({ ok: false, error: 'Could not record that event.' });
  }
});

// Pay online (supports PayMongo or Mock)
router.post('/billing/pay-online', async (req, res, next) => {
  try {
    const amount = Number(req.body.amount);
    // The ₱500 down payment applies to the first payment only, and that rule is
    // enforced inside createPayMongoPayment — which shares it with the cash path
    // (lib/billing.js) so the two cannot disagree. Only the plainly invalid is
    // worth catching here, before any network call is made.
    if (!amount || amount <= 0) {
      setFlash(req, 'error', 'Enter a payment amount greater than zero.');
      return res.redirect('/student/billing');
    }
    const student = await getUserById(req.session.user.id);
    const studentName = `${student.first_name} ${student.last_name}`.replace(/\s+/g, ' ').trim();
    const result = await createPayMongoPayment(req.session.user.id, amount, {
      name: studentName,
      // The login email, or the parent's when a student has none of their own.
      email: student.email || student.parent_email || '',
      phone: student.contact_number || student.parent_contact_number || '',
      label: `${studentName} (${student.user_id})`
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

/**
 * Analytics & Reports for a student.
 *
 * Required for all four roles, scoped per role. For a student the scope is
 * themselves — and it is applied in the SQL (lib/rbac.js -> studentScopeClause),
 * so there is no request they can craft that returns another learner's rows.
 *
 * This is the scored view: trends over time, weak topics, module completion.
 * My Progress remains the per-subject checklist of what to do next.
 */
router.get('/analytics', async (req, res, next) => {
  try {
    const filters = {
      search: String(req.query.search || '').trim(),
      subjectId: req.query.subject_id || 'all',
      kind: req.query.kind || 'all',
      from: req.query.from || '',
      to: req.query.to || ''
    };

    const [data, focus] = await Promise.all([
      getAnalyticsDashboard(req.session.user, filters),
      getFocusHandoutsForStudent(req.session.user.id).catch(() => [])
    ]);

    const shell = await buildShell(req, {
      pageTitle: 'Analytics & Reports',
      section: 'analytics',
      contentView: '../content/analytics-dashboard',
      analytics: data,
      focusHandouts: focus,
      filters,
      query: req.query,
      viewerRole: 'student'
    });
    res.render('shells/dashboard', shell);
  } catch (error) { next(error); }
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

/** A random key identifying one sitting, for grouping its anti-cheat strikes. */
function newSittingKey() {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Close the anti-cheat record for a sitting: attach its violations to the
 * submission they belong to, and mark the submission if the system ended it.
 *
 * Never throws — a logging failure must not turn a graded submission into an
 * error page for the student.
 */
async function finaliseSitting(req, { assessmentId, submissionId }) {
  const sessionKey = req.body.session_key || null;
  try {
    await attachViolationsToSubmission({
      assessmentId,
      studentId: req.session.user.id,
      submissionId,
      sessionKey
    });
    if (req.body.auto_submitted) {
      await markSubmissionAutoSubmitted(submissionId, String(req.body.auto_submitted));
    }
  } catch (error) {
    console.error('[anti-cheat] could not finalise the sitting:', error.message);
  }
}

router.get('/subjects/:subjectId/pre-assessment', async (req, res, next) => {
  const subjectId = Number(req.params.subjectId);
  try {
    const assignment = await requireEnrolment(req, subjectId);
    if (!assignment) {
      setFlash(req, 'error', 'Subject not found in your account.');
      return res.redirect('/student/subjects');
    }

    // The down-payment gate. Checked here and again on POST, because hiding the
    // button on the subject page is not a gate — this URL can simply be typed.
    const downPayment = await getDownPaymentStatus(req.session.user.id);
    if (!downPayment.satisfied) {
      setFlash(req, 'error', downPaymentBlockMessage(downPayment));
      return res.redirect(`/student/subjects/${subjectId}`);
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

    // One key per sitting, so a reload resumes the same strike count instead of
    // starting again from zero — and yesterday's violations do not carry into
    // today's attempt.
    const sessionKey = newSittingKey();
    const shell = await buildShell(req, {
      pageTitle: `Pre-Assessment — ${assignment.subject_name}`,
      section: 'subjects',
      contentView: '../content/student-pre-assessment',
      assessment,
      assignment,
      subjectId,
      startedAt: new Date().toISOString(),
      antiCheat: {
        endpoint: `/student/assessments/${assessment.id}/violation`,
        sessionKey,
        limit: MAX_VIOLATIONS,
        startCount: 0
      }
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

    // The same gate as the GET. A submission that arrives without a down payment
    // is refused rather than graded: otherwise the page could be opened before a
    // refund or a reversal and submitted afterwards.
    const downPayment = await getDownPaymentStatus(req.session.user.id);
    if (!downPayment.satisfied) {
      setFlash(req, 'error', downPaymentBlockMessage(downPayment));
      return res.redirect(`/student/subjects/${subjectId}`);
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

    await finaliseSitting(req, { assessmentId, submissionId: result.submissionId });

    // The classification is recorded by gradeAndSubmitAssessment itself, for every
    // kind of assessment — see the note there. It used to be done here, which is
    // why the module-assessment route was able to leave it behind.

    // Weak-topic follow-up (upgrade Section 6.3): analyse the topics this student
    // scored lowest on, generate focus material for them, flag it for their
    // assigned tutor and notify that tutor.
    //
    // Awaited rather than fired and forgotten so the tutor's notification is
    // already there when they look, and so a failure is logged against this
    // request. runPreAssessmentFollowUp never throws — the student's result is
    // already saved and must not be put at risk by a slow AI provider.
    const focus = await runPreAssessmentFollowUp({
      submissionId: result.submissionId,
      studentId: req.session.user.id,
      subjectId,
      assessmentId
    });

    setFlash(
      req,
      'success',
      `Pre-Assessment submitted. Your level: ${result.level} (${result.percentage}%). Your modules are now unlocked.`
      + (focus && focus.tutor_id ? ' Your tutor has been sent your focus areas.' : '')
    );
    res.redirect(`/student/results/${result.submissionId}`);
  } catch (error) {
    setFlash(req, 'error', error.message || 'Could not submit the Pre-Assessment.');
    res.redirect(`/student/subjects/${subjectId}`);
  }
});

// ---------------------------------------------------------------------------
// Post-Assessment (overhaul Phase 8, spec Section 4b)
//
// Gated per student, server-side, on the same completion rule the tutor's button
// uses: the Pre-Assessment done, every visible module opened, and every published
// tutor assessment on those modules submitted.
// ---------------------------------------------------------------------------

/** Shared guard: returns { assignment, assessment } or null after flashing. */
async function requirePostAssessment(req, subjectId) {
  const assignment = await requireEnrolment(req, subjectId);
  if (!assignment) {
    setFlash(req, 'error', 'Subject not found in your account.');
    return null;
  }

  const assessment = await getPostAssessment(subjectId);
  if (!assessment) {
    setFlash(req, 'error', 'Your tutor has not opened the Post-Assessment for this subject yet.');
    return null;
  }

  const completion = await getStudentSubjectCompletion(req.session.user.id, subjectId);
  if (!completion.isComplete) {
    setFlash(req, 'error', 'Finish every module and its assessments first — then the Post-Assessment opens.');
    return null;
  }
  if (completion.postTaken) {
    setFlash(req, 'info', 'You have already completed the Post-Assessment for this subject.');
    return { redirectTo: `/student/results/${completion.postSubmission.id}` };
  }

  return { assignment, assessment };
}

router.get('/subjects/:subjectId/post-assessment', async (req, res, next) => {
  const subjectId = Number(req.params.subjectId);
  try {
    const gate = await requirePostAssessment(req, subjectId);
    if (!gate) return res.redirect(`/student/subjects/${subjectId}`);
    if (gate.redirectTo) return res.redirect(gate.redirectTo);

    const shell = await buildShell(req, {
      pageTitle: `Post-Assessment — ${gate.assignment.subject_name}`,
      section: 'subjects',
      contentView: '../content/student-pre-assessment',
      assessment: await getAssessmentWithQuestions(gate.assessment.id),
      assignment: gate.assignment,
      subjectId,
      kind: 'post',
      startedAt: new Date().toISOString(),
      antiCheat: {
        endpoint: `/student/assessments/${gate.assessment.id}/violation`,
        sessionKey: newSittingKey(),
        limit: MAX_VIOLATIONS,
        startCount: 0
      }
    });
    res.render('shells/dashboard', shell);
  } catch (error) { next(error); }
});

router.post('/subjects/:subjectId/post-assessment', async (req, res, next) => {
  const subjectId = Number(req.params.subjectId);
  try {
    const gate = await requirePostAssessment(req, subjectId);
    if (!gate) return res.redirect(`/student/subjects/${subjectId}`);
    if (gate.redirectTo) return res.redirect(gate.redirectTo);

    const answers = [];
    for (const key of Object.keys(req.body)) {
      if (!key.startsWith('answer_')) continue;
      answers.push({ question_id: Number(key.slice(7)), student_answer: req.body[key] });
    }

    const result = await gradeAndSubmitAssessment({
      assessment_id: gate.assessment.id,
      student_id: req.session.user.id,
      answers,
      started_at: req.body.started_at || null
    });

    await finaliseSitting(req, { assessmentId: gate.assessment.id, submissionId: result.submissionId });

    // The classification on record follows the latest measurement, which is the
    // point of sitting the same questions again — recorded by
    // gradeAndSubmitAssessment for every assessment kind, not just this one.

    setFlash(req, 'success', `Post-Assessment submitted. Your level: ${result.level} (${result.percentage}%).`);
    res.redirect(`/student/results/${result.submissionId}`);
  } catch (error) {
    setFlash(req, 'error', error.message || 'Could not submit the Post-Assessment.');
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

    // Reaching this line means the student passed every gate and is looking at
    // the module's handouts, which is what "opened the module" means for the
    // Post-Assessment completion check (Phase 8). Recorded after the guards, never
    // before, so a blocked attempt cannot count as progress.
    await recordModuleOpen(studentId, mod.id, mod.subject_id);

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
      // Overhauled modules have no `level` — that column belongs to the legacy
      // three-level system — so titling the page with it printed "module1 — null".
      pageTitle: `${mod.title} — ${mod.subject_name}`,
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
      isPre: false,
      startedAt: new Date().toISOString(),
      antiCheat: {
        endpoint: `/student/assessments/${assessment.id}/violation`,
        sessionKey: newSittingKey(),
        limit: MAX_VIOLATIONS,
        startCount: 0
      }
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

    // gradeAndSubmitAssessment, not submitTutorAssessment (Phase 7): the old one
    // never destructured its `connection.query` result, so it graded against the
    // rows array itself and produced NaN. It also cannot grade an essay, and the
    // tutor form can now create essay questions. This is the same engine the
    // Pre-Assessment uses, so per-question correctness and AI feedback are stored
    // and the breakdown page works for tutor assessments too.
    const result = await gradeAndSubmitAssessment({
      assessment_id: assessmentId,
      student_id: studentId,
      answers,
      started_at: req.body.started_at || null
    });

    await finaliseSitting(req, { assessmentId, submissionId: result.submissionId });

    setFlash(
      req,
      req.body.auto_submitted ? 'warning' : 'success',
      req.body.auto_submitted
        ? `Your assessment was submitted automatically after 3 violations. `
          + `Score: ${result.score}/${result.totalPoints} (${Number(result.percentage).toFixed(1)}%)`
        : `Assessment submitted! Score: ${result.score}/${result.totalPoints} (${Number(result.percentage).toFixed(1)}%)`
    );
    res.redirect(`/student/results/${result.submissionId}`);
  } catch (error) {
    setFlash(req, 'error', error.message || 'Could not submit assessment.');
    res.redirect('/student/subjects');
  }
});

// Student: View assessment result
// The older result page. Its query INNER JOINs modules, so it cannot show a
// subject-level Pre-Assessment, and it re-derived correctness instead of reading
// the stored per-question grading. /student/results/:id does both properly, so
// this stays only as a working URL for existing links.
router.get('/assessment-result/:submissionId', (req, res) => {
  res.redirect(`/student/results/${req.params.submissionId}`);
});

// Student: Progress page
//
// This is also the old Analytics & Reports page. Both were built from the same
// two sources — the student's level per subject and their submissions — so they
// are one page: a card per subject with the level and score up top, and the
// per-subject counters and attempt history underneath.
router.get('/progress', async (req, res, next) => {
  try {
    const studentId = req.session.user.id;
    const progress = await getStudentProgress(studentId);
    const assignments = await getStudentAssignments(studentId);

    // For each subject with a level, get submission stats
    const enrichedProgress = [];
    for (const p of progress) {
      const submissions = await getStudentSubmissions(studentId, p.subject_id);
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

    // The analytics half: counters and attempt history per enrolled subject.
    const subjects = [];
    for (const assignment of assignments) {
      const analytics = await getStudentAnalytics(studentId, assignment.subject_id);
      if (analytics) subjects.push(analytics);
    }

    const shell = await buildShell(req, {
      pageTitle: 'My Progress',
      section: 'progress',
      contentView: '../content/student-progress',
      progress: enrichedProgress,
      assignments,
      subjects
    });
    res.render('shells/dashboard', shell);
  } catch (error) { next(error); }
});

module.exports = router;
