/**
 * ANNOTATED COPY FOR DEFENSE REVIEW
 * File: routes/student.js
 * Purpose: Student dashboard routes. This file handles subjects, tutor applications, billing, messaging, assessments, notifications, and profile management for learners.
 * Notes: Comments were added to help explain the system during code defense without changing the original logic.
 */

const express = require('express');
const { authorize, setFlash } = require('../middleware/auth');
const { query } = require('../config/db');
const { createUploader } = require('../lib/uploads');
const {
  getStudentDashboardData,
  getStudentAssignments,
  getStudentSubjectsOverview,
  createSubjectEnrollmentRequest,
  getUserById,
  getSubjectResources,
  updateUser,
  getAttendanceBySubject,
  getTutorAvailabilityForSubject,
  getTutorChoicesForStudent,
  keepCurrentTutorForSubject,
  normalizePreferredDays,
  slotKey,
  createTutorScheduleApplication,
  createTutorScheduleApplicationForAllSubjects,
  getStudentScheduleNotifications,
  markStudentScheduleNotificationRead,
  // Phase 2: AI system imports
  getModulesForStudent,
  getStudentAnalytics,
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
  // Post-Assessment (Phase 8): opens on the last day of the enrolment
  recordModuleOpen,
  getStudentSubjectCompletion,
  getStudentPostState,
  getOrCreatePostAssessmentFor,
  getSubjectPrePostComparison,
  moduleTargetsStudent,
  studentGradeOf,
  getModuleById,
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
  runPreAssessmentFollowUp,
  // Payment reminders in the bell (lib/paymentReminders.js)
  getAppNotifications,
  markOwnAppNotificationRead,
  markAllAppNotificationsRead,
  archiveAppNotification,
  recoverAppNotification,
  markAllStudentScheduleNotificationsRead,
  getScheduleRequestHistory
} = require('../lib/data');
const { buildBellItems } = require('../lib/bell');
const { determineLevel } = require('../config/levelThresholds');
const { normalizeArray, formatDateTime } = require('../lib/utils');
// Phase 3: cash is a POS transaction now. The student's side ends at a slip.
const { buildSlipModel, renderSlipPdf, slipFilename, slipCode, formatSlipDate } = require('../lib/paymentSlip');

const router = express.Router();
const profileUploader = createUploader('profiles');

router.use(authorize(['student']));

/**
 * A refused or failed action goes back to the page it came from with the reason
 * as a message. These actions used to hand the error to the error page, so a
 * plain "not allowed" — marking an unpaid bill paid, an email already in use,
 * a student from another branch — showed "Server Error" instead.
 */
function failBack(req, res, error, fallback) {
  setFlash(req, 'error', (error && error.message) || 'That could not be done. Please try again.');
  return res.redirect(req.get('Referer') || fallback);
}

// Function: buildShell

// Role: Handles a reusable server-side operation used by this module.

async function buildShell(req, extra = {}) {
  // The bell carries the tutors' answers to this student's requests and,
  // beside them, the alerts addressed to them — the payment reminders.
  const [inboxNotifications, alerts] = await Promise.all([
    getStudentScheduleNotifications(req.session.user.id),
    getAppNotifications(req.session.user, { unreadOnly: true }).catch(() => [])
  ]);
  const bellItems = buildBellItems({ basePath: '/student', scheduleUpdates: inboxNotifications, alerts });
  return {
    pageTitle: extra.pageTitle || 'Student Dashboard',
    roleName: 'Student',
    basePath: '/student',
    section: extra.section || 'dashboard',
    contentView: extra.contentView,
    currentUser: req.session.user,
    notificationCount: bellItems.length,
    inboxNotifications,
    alerts,
    bellItems,
    ...extra
  };
}

/** A background request from the bell's × wants no page and no flash back. */
function isBackgroundRequest(req) {
  return req.get('X-Requested-With') === 'fetch';
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
    const [subjectOverview, tutorChoices, pendingRequests] = await Promise.all([
      getStudentSubjectsOverview(req.session.user.id),
      // Per subject still without a tutor: who could take it, when each is
      // busy, and which of the student's current tutors also teach it.
      getTutorChoicesForStudent(req.session.user.id),
      query(
        `SELECT tsa.id, tsa.tutor_id, tsa.subject_id, tsa.time_slot, tsa.preferred_days, tsa.created_at,
                u.first_name, u.last_name
           FROM tutor_schedule_applications tsa
           INNER JOIN users u ON u.id = tsa.tutor_id
          WHERE tsa.student_id = ? AND tsa.status = 'pending'`,
        [req.session.user.id]
      )
    ]);
    const shell = await buildShell(req, {
      pageTitle: 'My Subjects',
      section: 'subjects',
      contentView: '../content/student-subjects',
      assignments: subjectOverview.enrolledSubjects,
      allSubjects: subjectOverview.allSubjects,
      tutorChoices,
      pendingRequests
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

/**
 * A tutor's full profile, in the same tab.
 *
 * "View profile" in the Select Tutor dialog opens this page directly — it used to
 * show a short card inside the dialog with an "Open full profile" button that
 * opened yet another tab. When the student came from the dialog, the address
 * carries what they had chosen (subject, days, time), so this page can offer
 * "Select this tutor" right here and "Back to tutors" returns them to the same
 * list. Both are checked against the student's real choices: a hand-edited
 * address only gets the plain profile.
 */
router.get('/tutors/:id', async (req, res, next) => {
  try {
    const tutor = await getUserById(req.params.id);
    if (!tutor || tutor.role !== 'tutor') {
      setFlash(req, 'error', 'Tutor not found.');
      return res.redirect('/student/subjects');
    }

    let pick = null;
    const subjectId = Number(req.query.subject) || 0;
    if (subjectId) {
      const days = normalizePreferredDays(req.query.days);
      const slot = String(req.query.slot || '').trim();
      const choices = await getTutorChoicesForStudent(req.session.user.id);
      const subject = choices.subjects.find((s) => Number(s.subject_id) === subjectId) || null;
      if (subject) {
        const listed = subject.tutors.find((t) => Number(t.id) === Number(tutor.id)) || null;
        const kept = subject.currentTutors.find((t) => Number(t.tutor_id) === Number(tutor.id)) || null;
        // A request already waiting for this subject (the same rule as the
        // Subjects page): nothing more to choose until the tutor answers.
        const pendingRows = await query(
          `SELECT tutor_id, subject_id FROM tutor_schedule_applications WHERE student_id = ? AND status = 'pending'`,
          [req.session.user.id]
        );
        const waiting = pendingRows.some((row) => Number(row.subject_id) === subjectId
          || subject.tutors.some((t) => Number(t.id) === Number(row.tutor_id)));
        const free = !waiting && listed && days && choices.timeSlots.includes(slot)
          && !(listed.blocked || []).includes(slotKey(days, slot));
        const back = new URLSearchParams({ pick: String(subjectId) });
        if (days) back.set('days', days);
        if (slot) back.set('slot', slot);
        pick = {
          subjectId,
          subjectName: subject.subject_name,
          days,
          slot,
          // Picked from the list at these days and time, and still free then.
          canSelect: !!free,
          // One of the student's own tutors, offered as "keep this tutor".
          canKeep: !waiting && req.query.from === 'keep' && !!kept,
          waiting,
          keptSchedule: kept ? [kept.preferred_days, kept.time_slot].filter(Boolean).join(', ') : '',
          alsoTeaches: listed ? (listed.also_teaches || []) : [],
          backUrl: `/student/subjects?${back.toString()}`
        };
      }
    }

    const shell = await buildShell(req, {
      pageTitle: 'Tutor Profile',
      section: 'subjects',
      contentView: '../content/student-tutor-profile',
      tutor,
      pick
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
    // Everything below is THIS student's grade: the modules, the handouts the
    // Pre-Assessment is written from, and so whether it can open at all.
    const studentRecord = await getUserById(req.session.user.id);
    const gradeLevel = studentGradeOf(studentRecord);
    const preAssessmentDone = await hasCompletedPreAssessment(req.session.user.id, Number(req.params.subjectId), gradeLevel);
    const newModules = await getStudentSubjectModules(req.session.user.id, Number(req.params.subjectId));
    const handoutsReady = gradeLevel
      ? (await getSubjectHandoutTexts(Number(req.params.subjectId), gradeLevel)).length
      : 0;
    // Phase 2.1: the Pre-Assessment needs the ₱500 down payment. The route
    // enforces it; this is only so the page can say so before they click.
    const downPayment = await getDownPaymentStatus(req.session.user.id);

    // ---- Post-Assessment (Phase 8) ---------------------------------------
    // It opens at 12:01 AM on the last day of this student's enrolment in the
    // subject. The page says when, and shows pre-vs-post once both exist.
    const completion = await getStudentSubjectCompletion(req.session.user.id, Number(req.params.subjectId));
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
      gradeLevel,
      downPayment,
      completion,
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
    // Days and time come first in the dialog, so a request without them is a
    // stale form rather than a choice.
    const preferredDays = normalizePreferredDays(req.body.preferred_days);
    if (!preferredDays) {
      setFlash(req, 'error', 'Choose Weekdays or Weekend first.');
      return res.redirect('/student/subjects');
    }
    // A tutor takes only the subjects they teach, and only ones with no tutor
    // yet. The request says which; any other subject is picked separately.
    const subjectId = Number(req.body.subject_id) || null;
    const result = await createTutorScheduleApplicationForAllSubjects(
      req.session.user.id,
      Number(req.body.tutor_id),
      String(req.body.time_slot || '').trim(),
      { preferredDays, subjectIds: subjectId ? [subjectId] : [] }
    );
    const covered = (result && result.subjects) || [];
    setFlash(req, 'success', covered.length
      ? `Your request was sent to the tutor for ${covered.join(', ')} (${preferredDays}, ${String(req.body.time_slot || '').trim()}). You will be notified once they accept.`
      : 'Your request was sent to the tutor.');
    res.redirect('/student/subjects');
  } catch (error) {
    setFlash(req, 'error', error.message || 'Could not send your request to the tutor.');
    res.redirect('/student/subjects');
  }
});

// A newly enrolled subject that one of the student's current tutors teaches:
// "keep my tutor" adds it to the sessions they already have together.
router.post('/subjects/:subjectId/keep-tutor', async (req, res) => {
  try {
    const result = await keepCurrentTutorForSubject(
      req.session.user.id,
      Number(req.params.subjectId),
      Number(req.body.tutor_id)
    );
    const when = [result.preferredDays, result.timeSlot].filter(Boolean).join(', ');
    setFlash(req, 'success', `${result.tutorName} is now your ${result.subjectName} tutor too${when ? ` (${when})` : ''}.`);
  } catch (error) {
    setFlash(req, 'error', error.message || 'Could not keep that tutor for this subject.');
  }
  res.redirect('/student/subjects');
});

// Keep per-subject apply route for backwards compatibility (subject-detail page)
// Route handler: POST request
// Purpose: Processes this endpoint and returns the correct view or action result.
router.post('/subjects/:subjectId/apply', async (req, res, next) => {
  try {
    const preferredDays = normalizePreferredDays(req.body.preferred_days);
    if (!preferredDays) throw new Error('Choose Weekdays or Weekend first.');
    await createTutorScheduleApplicationForAllSubjects(
      req.session.user.id, Number(req.body.tutor_id), String(req.body.time_slot || '').trim(),
      { subjectIds: [Number(req.params.subjectId)], preferredDays }
    );
    setFlash(req, 'success', 'Your request was sent to the tutor.');
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
    if (isBackgroundRequest(req)) return res.status(204).end();
    setFlash(req, 'success', 'Notification marked as read.');
    res.redirect(req.get('Referer') || '/student');
  } catch (error) { failBack(req, res, error, '/student/notifications'); }
});

// A payment reminder (or any alert addressed to this student) dismissed from
// the bell. Only ever marks the student's own.
router.post('/alerts/:id/read', async (req, res, next) => {
  try {
    await markOwnAppNotificationRead(Number(req.params.id), req.session.user);
    if (isBackgroundRequest(req)) return res.status(204).end();
    setFlash(req, 'success', 'Notification marked as read.');
    res.redirect(req.get('Referer') || '/student');
  } catch (error) { failBack(req, res, error, '/student/notifications'); }
});

// ---------------------------------------------------------------------------
// Notifications — the bell's "See all", its "Mark all read", and the ☰ menu's
// View Archived Notifications and Notification History.
// ---------------------------------------------------------------------------
router.get('/notifications', async (req, res, next) => {
  try {
    const [scheduleUpdates, alerts] = await Promise.all([
      getStudentScheduleNotifications(req.session.user.id),
      getAppNotifications(req.session.user).catch(() => [])
    ]);
    const shell = await buildShell(req, {
      pageTitle: 'Notifications',
      section: 'notifications',
      contentView: '../content/user-notifications',
      viewerRole: 'student',
      scheduleUpdates,
      scheduleRequests: [],
      allAlerts: alerts
    });
    res.render('shells/dashboard', shell);
  } catch (error) { next(error); }
});

router.post('/notifications/mark-all-read', async (req, res, next) => {
  try {
    await Promise.all([
      markAllStudentScheduleNotificationsRead(req.session.user.id),
      markAllAppNotificationsRead(req.session.user)
    ]);
    setFlash(req, 'success', 'All notifications marked as read.');
    res.redirect(req.get('Referer') || '/student/notifications');
  } catch (error) { failBack(req, res, error, '/student/notifications'); }
});

router.get('/notifications/archive', async (req, res, next) => {
  try {
    const archived = await getAppNotifications(req.session.user, { archivedOnly: true }).catch(() => []);
    const shell = await buildShell(req, {
      pageTitle: 'Archived Notifications',
      section: 'archive_notifications',
      contentView: '../content/user-notification-archive',
      archivedAlerts: archived
    });
    res.render('shells/dashboard', shell);
  } catch (error) { next(error); }
});

router.get('/notifications/history', async (req, res, next) => {
  try {
    const [requests, readAlerts] = await Promise.all([
      getScheduleRequestHistory(req.session.user.id, 'student'),
      getAppNotifications(req.session.user, { readOnly: true, includeArchived: true }).catch(() => [])
    ]);
    const shell = await buildShell(req, {
      pageTitle: 'Notification History',
      section: 'notification_history',
      contentView: '../content/user-notification-history',
      viewerRole: 'student',
      requestHistory: requests,
      readAlerts
    });
    res.render('shells/dashboard', shell);
  } catch (error) { next(error); }
});

router.post('/alerts/:id/archive', async (req, res, next) => {
  try {
    await archiveAppNotification(Number(req.params.id), req.session.user);
    setFlash(req, 'success', 'Notification archived.');
    res.redirect('/student/notifications');
  } catch (error) { failBack(req, res, error, '/student/notifications'); }
});

router.post('/alerts/:id/recover', async (req, res, next) => {
  try {
    await recoverAppNotification(Number(req.params.id), req.session.user);
    setFlash(req, 'success', 'Notification recovered.');
    res.redirect('/student/notifications/archive');
  } catch (error) { failBack(req, res, error, '/student/notifications'); }
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
    // PayMongo's webhook usually records the payment before the student is even
    // back on this page, so "nothing new to complete" does NOT mean "not paid":
    // the student's most recent online payment says which it is.
    let latestOnline = null;
    if (returning) {
      const rows = await query(
        'SELECT TOP 1 id, amount, status FROM online_payments WHERE student_id = ? ORDER BY id DESC',
        [req.session.user.id]
      );
      latestOnline = rows[0] || null;
    }
    const paidNow = paymentCheck && paymentCheck.completed.length
      ? paymentCheck.completed.reduce((sum, value) => sum + value, 0)
      : (latestOnline && latestOnline.status === 'completed' ? Number(latestOnline.amount || 0) : 0);

    if (paidNow > 0) {
      res.locals.flash = {
        type: 'success',
        message: `Payment successful! ₱${paidNow.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} has been received and recorded on your account. Thank you!`
      };
    } else if (returning) {
      res.locals.flash = {
        type: 'info',
        message: 'PayMongo is still confirming your payment. It is recorded here automatically as soon as it is — open Billing Data again in a minute.'
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
      // "Purpose of payment" is no longer asked of the student: what a student
      // pays through Billing Data is their tuition.
      purpose: 'Tuition',
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

// Messages were removed from the system (their sidebar link first, now the
// pages and the actions behind them). An old link or bookmark lands on the
// dashboard with a word of explanation instead of a working chat nobody is
// meant to use.
function retiredMessages(req, res) {
  setFlash(req, 'info', 'Messages are no longer part of MindQuest.');
  res.redirect('/student');
}
router.get('/messages', retiredMessages);
router.post('/messages/send', retiredMessages);
router.post('/messages/:id/edit', retiredMessages);
router.post('/messages/:id/unsend', retiredMessages);


// Route handler: GET request


// Purpose: Processes this endpoint and returns the correct view or action result.


router.get('/assessments', (req, res) => {
  // Assessments are now accessed inside My Subjects only
  res.redirect('/student/subjects');
});

// Route handler: GET request

// Purpose: Processes this endpoint and returns the correct view or action result.

/*
 * The old assessment page (/student/assessments/:id) belonged to the admin's
 * retired "Assessments" templates. No page lists those any more and their table
 * is empty; every assessment a student sits now opens inside its subject. An
 * old link lands there instead of on a page that warned "Leave site?" with the
 * browser's own dialog.
 */
function retiredAssessment(req, res) {
  setFlash(req, 'info', 'That old assessment link no longer works. Your assessments are inside each subject in My Subjects.');
  res.redirect('/student/subjects');
}
router.get('/assessments/:id', retiredAssessment);
router.post('/assessments/:id/submit', retiredAssessment);
router.post('/assessments/:id/reset', retiredAssessment);

// Route handler: GET request


// Purpose: Processes this endpoint and returns the correct view or action result.


router.get('/profile', async (req, res, next) => {
  try {
    const user = await getUserById(req.session.user.id);
    const subjectOverview = await getStudentSubjectsOverview(req.session.user.id);
    const shell = await buildShell(req, {
      pageTitle: 'My Profile',
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
    // The student's own form has no subjects: those change only through an
    // enrolment request the office accepts. So the stored lists go back as
    // they are. They used to be re-read from the raw JSON and split on commas,
    // which turned ["ENGLISH"] into '["ENGLISH"]' — no such subject — and
    // saving a profile unenrolled the student from everything.
    //
    // Nor do the year level, grade level or login email change here. The grade
    // decides which modules and which Pre-Assessment a student gets, and it was
    // a free-text box on this form: a student could type "Grade 12" and open
    // that grade's modules, or mistype "Grade6" and lose every module they had.
    // The office sets all three (User Management); whatever the form posts for
    // them is ignored.
    const { year_level: _y, grade_level: _g, email: _e, ...editable } = req.body || {};
    await updateUser(req.session.user.id, {
      ...editable,
      year_level: current.year_level,
      grade_level: current.grade_level,
      email: current.email,
      branch_id: current.branch_id,
      subjects: current.subjects || [],
      supports: current.supports || [],
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
    // A refused change (an email already in use) is a message, not an error page.
    setFlash(req, 'error', error.message || 'Could not save your profile.');
    res.redirect('/student/profile');
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
// The retired assessment page's anti-cheat log. The live one is /violation below.
router.post('/assessments/:id/anti-cheat', (req, res) => {
  res.status(410).json({ ok: false, error: 'This assessment page was retired.' });
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
    // No filter bar: every subject, every assessment. The score trend is drawn
    // per subject, one bar per assessment taken.
    const filters = { search: '', subjectId: 'all', kind: 'all', from: '', to: '' };

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

    // The Pre-Assessment is the student's own grade's: written from that grade's
    // modules, and not open at all while the grade has none — another grade's
    // modules in the same subject do not count.
    const gradeLevel = studentGradeOf(await getUserById(req.session.user.id));

    // Already done: send them to their result rather than letting them retake it.
    const done = await hasCompletedPreAssessment(req.session.user.id, subjectId, gradeLevel);
    if (done) {
      setFlash(req, 'info', 'You have already completed the Pre-Assessment for this subject.');
      return res.redirect(`/student/results/${done.id}`);
    }

    if (!gradeLevel) {
      setFlash(req, 'error', 'Your grade level is not on your profile yet, so there are no modules or Pre-Assessment for you. Please ask the office to set it.');
      return res.redirect(`/student/subjects/${subjectId}`);
    }
    const gradeModules = await getStudentSubjectModules(req.session.user.id, subjectId);
    if (!gradeModules.length) {
      setFlash(req, 'error', `There are no ${gradeLevel} modules in ${assignment.subject_name} yet, so the Pre-Assessment is not open. It opens once your modules are ready.`);
      return res.redirect(`/student/subjects/${subjectId}`);
    }

    let assessment;
    try {
      // Size comes from config/assessmentDefaults.js (30), never a literal here.
      const result = await getOrCreatePreAssessment(subjectId, gradeLevel);
      assessment = result.assessment;
    } catch (error) {
      // No readable handout for this grade yet, or generation failed. Say so
      // plainly instead of showing an empty exam.
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
    // Archived ones too: a Pre-Assessment rebuilt from new handouts while this
    // student was answering it is graded on the questions they were shown.
    const assessment = await getAssessmentWithQuestions(assessmentId, { includeArchived: true });
    if (!assessment || Number(assessment.subject_id) !== subjectId || assessment.assessment_kind !== 'pre_assessment') {
      setFlash(req, 'error', 'That Pre-Assessment does not belong to this subject.');
      return res.redirect(`/student/subjects/${subjectId}`);
    }
    // ...and it must be this student's grade's.
    const gradeLevel = studentGradeOf(await getUserById(req.session.user.id));
    if (!gradeLevel || assessment.grade_level !== gradeLevel) {
      setFlash(req, 'error', 'That Pre-Assessment is for another grade level.');
      return res.redirect(`/student/subjects/${subjectId}`);
    }
    if (await hasCompletedPreAssessment(req.session.user.id, subjectId, gradeLevel)) {
      setFlash(req, 'info', 'You have already completed the Pre-Assessment for this subject.');
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
      started_at: req.body.started_at || null,
      allowArchived: true
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
// It opens on its own at 12:01 AM on the LAST DAY of the student's enrolment in
// the subject (enrolled 1 January -> open from 12:01 AM on 1 February), and not
// a minute before. It is the same questions as the Pre-Assessment this student
// sat, so that must have been taken. Enforced here, server-side: the button on
// the subject page is only a reflection of it.
// ---------------------------------------------------------------------------

/** Shared guard: returns { assignment, assessment } or null after flashing. */
async function requirePostAssessment(req, subjectId) {
  const assignment = await requireEnrolment(req, subjectId);
  if (!assignment) {
    setFlash(req, 'error', 'Subject not found in your account.');
    return null;
  }

  const state = await getStudentPostState(req.session.user.id, subjectId);
  if (state.status === 'taken') {
    setFlash(req, 'info', 'You have already completed the Post-Assessment for this subject.');
    return { redirectTo: `/student/results/${state.postSubmission.id}` };
  }
  if (state.status === 'needs_pre') {
    setFlash(req, 'error', 'The Post-Assessment repeats your Pre-Assessment, so take the Pre-Assessment first.');
    return null;
  }
  if (state.status !== 'open') {
    setFlash(req, 'error', state.opensAt
      ? `The Post-Assessment opens on ${formatDateTime(state.opensAt)} — the last day of your enrollment in ${assignment.subject_name}.`
      : 'The Post-Assessment opens on the last day of your enrollment.');
    return null;
  }

  // The same questions as the Pre-Assessment this student sat.
  const assessment = await getOrCreatePostAssessmentFor(state.preSubmission.assessment_id);
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

    // The questions on the page came from this exact assessment.
    if (req.body.assessment_id && Number(req.body.assessment_id) !== Number(gate.assessment.id)) {
      setFlash(req, 'error', 'That Post-Assessment does not match yours. Please open it again.');
      return res.redirect(`/student/subjects/${subjectId}`);
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

    // Get assessments and submissions for this module — the published ones; a
    // tutor's draft is not the student's to see.
    const assessments = (await getTutorAssessmentsByModule(mod.id))
      .filter((a) => Number(a.is_published) === 1);
    const submissions = await getStudentSubmissions(studentId, mod.subject_id);

    // Calculate progress
    const activities = assessments.filter(a => a.purpose === 'activity');
    const postAssessments = assessments.filter(a => a.purpose === 'post');
    const completedActivities = activities.filter(a => submissions.some(s => Number(s.assessment_id) === Number(a.id)));
    const completedPost = postAssessments.filter(a => submissions.some(s => Number(s.assessment_id) === Number(a.id)));

    // Progress: the handouts, the activities and the post-test. Reading the
    // handouts is done by being here — the open was recorded above, and it is
    // what the Post-Assessment's completion check counts too. It used to be
    // counted as a task that could never be completed, so a module with one
    // activity, done, still read 50%.
    const handoutTask = handouts.length ? 1 : 0;
    const totalTasks = handoutTask + activities.length + postAssessments.length;
    const completedTasks = handoutTask + completedActivities.length + completedPost.length;
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

/**
 * A module assessment this student may sit: a published one on a module of
 * THEIR grade, in a subject they take, once their Pre-Assessment is done.
 *
 * The GET used to check enrolment only, and the POST checked nothing at all —
 * so a Grade 6 learner could answer a Grade 3 module's assessment, and a
 * Pre- or Post-Assessment could be submitted through this route, past the down
 * payment and the last-day rule.
 *
 * Returns { assessment, assignment, mod }, or { redirectTo } after flashing.
 */
async function requireModuleAssessment(req, assessmentId) {
  const assessment = await getTutorAssessmentById(Number(assessmentId));
  if (!assessment || Number(assessment.is_archived) || !Number(assessment.is_published)
      || (assessment.assessment_kind || 'tutor_assessment') !== 'tutor_assessment') {
    setFlash(req, 'error', 'Assessment not found.');
    return { redirectTo: '/student/subjects' };
  }

  const assignment = await requireEnrolment(req, assessment.subject_id);
  if (!assignment) {
    setFlash(req, 'error', 'You are not enrolled in this subject.');
    return { redirectTo: '/student/subjects' };
  }

  const student = await getUserById(req.session.user.id);
  const mod = assessment.module_id ? await getModuleById(assessment.module_id) : null;
  if (!mod) {
    // getModuleById returns live modules only. A module the office removed
    // takes its assessments with it — say so, rather than "another grade".
    const [gone] = assessment.module_id
      ? await query('SELECT is_archived FROM modules WHERE id = ?', [assessment.module_id])
      : [];
    setFlash(req, 'error', gone && Number(gone.is_archived)
      ? 'That module was removed, so its assessments are closed.'
      : 'Assessment not found.');
    return { redirectTo: `/student/subjects/${assessment.subject_id}` };
  }
  if (!moduleTargetsStudent(mod, student)) {
    setFlash(req, 'error', 'This assessment belongs to a module for another grade level.');
    return { redirectTo: `/student/subjects/${assessment.subject_id}` };
  }

  if (!(await hasCompletedPreAssessment(req.session.user.id, assessment.subject_id, studentGradeOf(student)))) {
    setFlash(req, 'error', 'Please complete the Pre-Assessment for this subject before its module assessments.');
    return { redirectTo: `/student/subjects/${assessment.subject_id}` };
  }
  return { assessment, assignment, mod };
}

// Student: Take a tutor assessment (activity or post)
router.get('/tutor-assessments/:id', async (req, res, next) => {
  try {
    const gate = await requireModuleAssessment(req, req.params.id);
    if (gate.redirectTo) return res.redirect(gate.redirectTo);
    const { assessment, assignment } = gate;

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

    // The same gate as the page: a typed or replayed POST is held to it too.
    const gate = await requireModuleAssessment(req, assessmentId);
    if (gate.redirectTo) return res.redirect(gate.redirectTo);

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
    const assignments = await getStudentAssignments(studentId);

    // One record per enrolled subject, read from what the system records today:
    // the modules opened, every assessment submitted (Pre, module activities,
    // Post), and the level on record. This page used to read the retired
    // first-generation tables, so it showed no progress for anyone.
    const subjects = (await Promise.all(
      assignments.map((assignment) => getStudentAnalytics(studentId, assignment.subject_id)
        .then((analytics) => (analytics ? { ...analytics, assignment } : null)))
    )).filter(Boolean);

    const shell = await buildShell(req, {
      pageTitle: 'My Progress',
      section: 'progress',
      contentView: '../content/student-progress',
      assignments,
      subjects
    });
    res.render('shells/dashboard', shell);
  } catch (error) { next(error); }
});

module.exports = router;
