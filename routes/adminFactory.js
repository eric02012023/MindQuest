/**
 * ANNOTATED COPY FOR DEFENSE REVIEW
 * File: routes/adminFactory.js
 * Purpose: Shared route factory used by both admin and admin assistant dashboards. This file contains the largest set of management features: notifications, users, branches, billing, subjects, assignments, resources, and assessments.
 * Notes: Comments were added to help explain the system during code defense without changing the original logic.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const {
  authorize,
  setFlash
} = require('../middleware/auth');
const path = require('path');
const { createUploader, describeUploadRejection } = require('../lib/uploads');
const { extractHandoutText } = require('../services/extractionService');
const { schedulePreAssessmentWarmup, getWarmupState } = require('../lib/preAssessmentWarmup');
const { getFile, deleteFile } = require('../lib/storage');
const {
  getBranches,
  addBranch,
  archiveBranch,
  recoverBranch,
  deleteBranchPermanently,
  getBranchMembers,
  getBranchById,
  getDashboardCounts,
  getRecentSubmissions,
  getNotifications,
  getAdminInboxNotifications,
  acceptSubjectEnrollmentRequest,
  cancelSubjectEnrollmentRequest,
  markNotificationRead,
  declineNotification,
  archiveNotification,
  recoverNotification,
  acceptNotification,
  getUsers,
  getAssistantAccounts,
  getAttendanceBySubject,
  getAvailableAssistantBranches,
  getUserById,
  changeUserPassword,
  updateUser,
  archiveUser,
  recoverUser,
  deleteUserPermanently,
  createAssistantAccount,
  updateAssistantAccount,
  getStudentAssignments,
  getTutorAssignments,
  getBillingRows,
  updateBilling,
  reenrollStudents,
  markBillPaid,
  getPaymentHistory,
  postSoa,
  getSubjects,
  addSubject,
  archiveSubject,
  recoverSubject,
  deleteSubjectPermanently,
  getSubjectMembers,
  addSubjectResource,
  getAdminSubjectResources,
  getSubjectResources,
  assignStudentsToTutor,
  getAssignableStudentsForTutor,
  archiveAssignment,
  recoverAssignment,
  getSubjectArchivedAssignments,
  getSubjectArchivedTutors,
  archiveTutorSubject,
  recoverTutorSubject,
  getAssessments,
  getAssessmentHistory,
  createAssessmentTemplate,
  getAssessmentTemplates,
  getAssessmentTemplateById,
  getStudentsMatchingAssessmentTemplate,
  assignAssessmentTemplateToStudents,
  getAssessmentById,
  markAssessmentDone,
  recoverAssessment,
  deleteAssessmentPermanently,
  archiveSubjectResource,
  recoverSubjectResource,
  getAdminSubjectResourcesWithArchived,
  getStudentAnalytics,
  // Legacy pre/post assessment listing (read-only after Phase 1)
  getSubjectAssessments,
  // Module -> Handout system (overhaul Phase 3)
  getSubjectModules,
  getModuleById,
  createSubjectModule,
  updateSubjectModule,
  MAX_MODULE_NUMBER,
  getModuleHandouts,
  addModuleHandouts,
  archiveModuleHandout,
  getSubjectSubmissions,
  getPreAssessmentStatus,
  getSubmissionWithAnswers,
  getWeakAreasForSubmission,
  // Post-Assessment (Phase 8)
  getPostAssessment,
  getSubjectPrePostComparison,
  saveHandoutExtraction,
  getModuleHandoutById,
  bumpSubjectHandoutVersion,
  getModuleTargetOptions,
  deleteModule,
  getAllTutorAssessmentsAdmin,
  getStudentResultsAdmin,
  // --- Management upgrade -------------------------------------------------
  getUsersPaged,
  countStudentsNeedingTutor,
  // Billing ledger: Billing (1) -> (many) PaymentEntries, append-only
  PAYMENT_METHODS,
  PAYMENT_PURPOSES,
  attachPaymentLedgers,
  getBillingLedger,
  addPaymentEntry,
  getPaymentLedger,
  summarisePaymentLedger,
  // Student cash payment requests
  getPaymentRequests,
  getPaymentRequestById,
  countPendingPaymentRequests,
  completePaymentRequest,
  cancelPaymentRequest,
  // In-app notifications
  getAppNotifications,
  markAppNotificationRead,
  markAppNotificationReferenceRead,
  archiveAppNotification,
  // Analytics & Reports (RBAC-scoped at the query level)
  getAnalyticsDashboard,
  getFocusHandouts,
  getFocusHandoutById,
  resolveScope,
  canActOnBranch,
  // POS (Phase 3): staff-entered payments and the alerts they raise
  notifyAdminRoles,
  // Phase 5: one tutor per student, and an admin-only schedule
  setStudentTutorAndSchedule,
  getAssignedTutorFor,
  FIXED_TIME_SLOTS,
  // Tutor year levels, in the registration form's wording
  TUTOR_YEAR_LEVEL_OPTIONS,
  normalizeTutorYearLevels,
  // Who was under which Assistant Admin
  getAssistantRoster,
  getAssistantRosterCounts,
  // A tutor teaches only the subjects they teach
  tutorTeachesSubject,
  matchesTutorStudentScope,
  // All Subjects -> subject -> Subject Assessments (the live ones)
  getSubjectAssessmentsOverview
} = require('../lib/data');
const { normalizeArray } = require('../lib/utils');
const { normalizeAmount } = require('../lib/billing');
const { slipCode, parseSlipCode } = require('../lib/paymentSlip');
const { query } = require('../config/db');

/** "Jane Cruz (Assistant Admin)" — who took the money, for a notification. */
function displayActor(user) {
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim() || 'Staff';
  const role = user?.role === 'admin' ? 'Admin' : user?.role === 'admin_assistant' ? 'Assistant Admin' : '';
  return role ? `${name} (${role})` : name;
}

const profileUploader = createUploader('profiles');
const resourceUploader = createUploader('resources');

const YEAR_LEVEL_OPTIONS = ['Pre School Level', 'Primary Level', 'Junior High Level', 'Senior High Level'];
const GRADE_LEVEL_MAP = {
  'Pre School Level': ['Kinder 1', 'Kinder 2'],
  'Primary Level': ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6'],
  'Junior High Level': ['Grade 7', 'Grade 8', 'Grade 9', 'Grade 10'],
  'Senior High Level': ['Grade 11', 'Grade 12']
};

// Function: normalizeRouteId

// Role: Provides helper logic for this file.

function normalizeRouteId(value) {
  if (value === undefined || value === null) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  const cleaned = String(raw).trim();
  if (!cleaned) return null;
  if (/^\d+$/.test(cleaned)) return String(Number(cleaned));
  if (/^\d+\.0+$/.test(cleaned)) return String(Number(cleaned));
  const match = cleaned.match(/(\d+)/g);
  if (!match || !match.length) return null;
  return String(Number(match[match.length - 1]));
}

/**
 * Back to the page a form was posted from, on the tab it was posted from.
 * A subject's sections are tabs kept in the address (#tutors); the browser
 * does not send that part in the Referer, so the form names it.
 */
function redirectBackToTab(req, res, fallback) {
  const tab = String(req.body?.return_tab || '').replace(/[^a-z-]/g, '');
  const referer = req.get('Referer');
  if (referer && tab) return res.redirect(`${referer.split('#')[0]}#${tab}`);
  return res.redirect(referer || fallback);
}

// Function: createAdminRouter

// Role: Provides helper logic for this file.

function createAdminRouter(role) {
  const router = express.Router();
  const basePath = role === 'admin' ? '/admin' : '/assistant';
  const allowedRoles = role === 'admin' ? ['admin'] : ['admin_assistant'];

  router.use(authorize(allowedRoles));

  // Function: getScopeBranchId

  // Role: Provides helper logic for this file.

  function getScopeBranchId(req) {
    if (req.session.user.role === 'admin_assistant') {
      return Number(req.session.user.assistant_scope_branch_id);
    }
    if (req.query.branch_id && req.query.branch_id !== 'all') {
      return Number(req.query.branch_id);
    }
    return null;
  }

  // Function: resolveBillingStudentId

  // Role: Provides helper logic for this file.

  function resolveBillingStudentId(req) {
    return normalizeRouteId(
      req.body?.student_id
      || req.body?.billing_student_id
      || req.params?.studentId
      || req.params?.billingId
      || req.query?.student_id
    );
  }

  // Function: resolveExistingBillingStudentId

  // Role: Handles a reusable server-side operation used by this module.

  async function resolveExistingBillingStudentId(req) {
    const directStudentId = resolveBillingStudentId(req);
    if (directStudentId) {
      const directRows = await query('SELECT TOP 1 student_id FROM billing WHERE student_id = ?', [Number(directStudentId)]);
      if (directRows.length) return String(directRows[0].student_id);
    }

    const billingId = normalizeRouteId(req.params?.billingId);
    if (billingId) {
      const billRows = await query('SELECT TOP 1 student_id FROM billing WHERE id = ?', [Number(billingId)]);
      if (billRows.length) return String(billRows[0].student_id);
    }

    const publicUserId = String(req.body?.user_id || '').trim();
    if (publicUserId) {
      const userRows = await query(
        `SELECT TOP 1 b.student_id
         FROM billing b
         INNER JOIN users u ON u.id = b.student_id
         WHERE u.user_id = ?`,
        [publicUserId]
      );
      if (userRows.length) return String(userRows[0].student_id);
    }

    return null;
  }

  // Function: buildShellData

  // Role: Handles a reusable server-side operation used by this module.

  async function buildShellData(req, extra = {}) {
    const scopeBranchId = getScopeBranchId(req);
    const scope = resolveScope(req.session.user, { requestedBranchId: req.query.branch_id });

    // The bell now counts two streams: the registration/enrolment inbox it always
    // showed, plus the payment requests students submit. A pending cash payment
    // that nobody notices is the failure this whole flow exists to avoid, so it
    // is counted in the same badge rather than hidden on its own page.
    const [branches, inboxNotifications, pendingPayments, alerts] = await Promise.all([
      getBranches(),
      getAdminInboxNotifications(scopeBranchId),
      countPendingPaymentRequests(scope).catch(() => 0),
      getAppNotifications(req.session.user, { unreadOnly: true }).catch(() => [])
    ]);

    return {
      pageTitle: extra.pageTitle || 'Dashboard',
      roleName: req.session.user.role === 'admin' ? 'Admin' : 'Admin Assistant',
      basePath,
      section: extra.section || 'dashboard',
      contentView: extra.contentView,
      currentUser: req.session.user,
      branches,
      effectiveBranchId: scopeBranchId,
      notificationCount: inboxNotifications.length + alerts.length,
      inboxNotifications,
      alerts,
      pendingPaymentCount: pendingPayments,
      availableAssistantBranches: [],
      ...extra
    };
  }

  // Route handler: GET request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.get('/', async (req, res, next) => {
    try {
      const scopeBranchId = getScopeBranchId(req);
      const [counts, recentSubmissions, inboxNotifications] = await Promise.all([
        getDashboardCounts(scopeBranchId),
        getRecentSubmissions(scopeBranchId, 6),
        getAdminInboxNotifications(scopeBranchId)
      ]);
      const shell = await buildShellData(req, {
        pageTitle: 'Dashboard',
        section: 'dashboard',
        contentView: '../content/admin-dashboard',
        counts,
        recentSubmissions,
        inboxNotifications
      });
      res.render('shells/dashboard', shell);
    } catch (error) {
      // This used to flash "Could not add subject." and redirect to All
      // Subjects — copied from the add-subject handler — so a dashboard that
      // failed to load sent the admin somewhere unrelated with a wrong reason.
      next(error);
    }
  });

  // Route handler: GET request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.get('/notifications/archive', async (req, res, next) => {
    try {
      const scopeBranchId = getScopeBranchId(req);
      const archivedNotifications = await getNotifications({ scopeBranchId, archived: true, history: false });
      const shell = await buildShellData(req, {
        pageTitle: 'Archived Notifications',
        section: 'archive_notifications',
        contentView: '../content/admin-notification-archives',
        archivedNotifications
      });
      res.render('shells/dashboard', shell);
    } catch (error) {
      next(error);
    }
  });

  // Route handler: GET request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.get('/notifications/history', async (req, res, next) => {
    try {
      const scopeBranchId = getScopeBranchId(req);
      const historyNotifications = await getNotifications({ scopeBranchId, archived: false, history: true });
      const shell = await buildShellData(req, {
        pageTitle: 'Notification History',
        section: 'notification_history',
        contentView: '../content/admin-notification-history',
        historyNotifications
      });
      res.render('shells/dashboard', shell);
    } catch (error) {
      next(error);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  // Registrations and enrolment requests are worked through on the
  // Notifications page, so every decision taken there returns to it — landing
  // on the dashboard after each one meant finding the inbox again every time.
  const inboxPath = `${basePath}/notifications`;

  router.post('/notifications/:id/read', async (req, res, next) => {
    try {
      await markNotificationRead(req.params.id, req.session.user.role === 'admin_assistant' ? req.session.user.assistant_scope_branch_id : null);
      setFlash(req, 'success', 'Notification marked as read.');
      res.redirect(inboxPath);
    } catch (error) {
      next(error);
    }
  });

  /** Turn a registration down: it leaves the inbox and is filed under history. */
  router.post('/notifications/:id/decline', async (req, res) => {
    try {
      const declined = await declineNotification(req.params.id, req.session.user.role === 'admin_assistant' ? req.session.user.assistant_scope_branch_id : null);
      setFlash(req, declined ? 'success' : 'error', declined ? 'Registration declined.' : 'Registration not found.');
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not decline this registration.');
    }
    res.redirect(inboxPath);
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/notifications/:id/archive', async (req, res, next) => {
    try {
      await archiveNotification(req.params.id, req.session.user.role === 'admin_assistant' ? req.session.user.assistant_scope_branch_id : null);
      setFlash(req, 'success', 'Notification archived successfully.');
      res.redirect(inboxPath);
    } catch (error) {
      next(error);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/notifications/:id/recover', async (req, res, next) => {
    try {
      await recoverNotification(req.params.id, req.session.user.role === 'admin_assistant' ? req.session.user.assistant_scope_branch_id : null);
      setFlash(req, 'success', 'Archived notification recovered.');
      res.redirect(`${basePath}/notifications/archive`);
    } catch (error) {
      next(error);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/notifications/:id/accept', async (req, res, next) => {
    try {
      await acceptNotification(req.params.id, req.session.user);
      setFlash(req, 'success', 'Registration accepted successfully.');
      res.redirect(inboxPath);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not accept submission.');
      res.redirect(inboxPath);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/subject-requests/:id/accept', async (req, res, next) => {
    try {
      await acceptSubjectEnrollmentRequest(req.params.id, req.session.user);
      setFlash(req, 'success', 'Subject enrollment request accepted successfully.');
      res.redirect(inboxPath);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not accept enrollment request.');
      res.redirect(inboxPath);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/subject-requests/:id/cancel', async (req, res, next) => {
    try {
      await cancelSubjectEnrollmentRequest(req.params.id, req.session.user);
      setFlash(req, 'success', 'Subject enrollment request cancelled successfully.');
      res.redirect(inboxPath);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not cancel enrollment request.');
      res.redirect(inboxPath);
    }
  });

  // Route handler: GET request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.get('/users', async (req, res, next) => {
    try {
      // An assistant still sees only their own branch; that is a scope, not a
      // filter, and is enforced here rather than offered as a choice.
      const scopeBranchId = req.session.user.role === 'admin_assistant'
        ? Number(req.session.user.assistant_scope_branch_id)
        : null;
      // The "Needs a tutor" folder: students with a subject that has no tutor
      // yet, so the office can find everyone still waiting for one.
      const folder = req.query.folder === 'needs-tutor' ? 'needs-tutor' : 'all';
      const selectedRole = folder === 'needs-tutor' ? 'student' : 'all';

      // Every user, on one page. The search, branch, role and status filters
      // and the page numbers are gone: the list shows ten rows and scrolls, and
      // the search icon beside "All users" finds anyone in it — by name, ID,
      // email, branch, role or status — without a round trip.
      // (public/js/mq-tables.js)
      const [page, needsTutorCount, archivedUsers, assistantAccounts, archivedAssistantAccounts, availableAssistantBranches, rosterCounts] = await Promise.all([
        getUsersPaged({
          scopeBranchId,
          role: selectedRole,
          archived: false,
          needsTutor: folder === 'needs-tutor',
          all: true
        }),
        countStudentsNeedingTutor(scopeBranchId),
        getUsers({ scopeBranchId, role: 'all', archived: true }),
        req.session.user.role === 'admin' ? getAssistantAccounts(null, false) : Promise.resolve([]),
        req.session.user.role === 'admin' ? getAssistantAccounts(null, true) : Promise.resolve([]),
        req.session.user.role === 'admin' ? getAvailableAssistantBranches() : Promise.resolve([]),
        // How many tutors and students each assistant has today — and has ever
        // had, which is what survives the assistant being replaced.
        req.session.user.role === 'admin' ? getAssistantRosterCounts().catch(() => new Map()) : Promise.resolve(new Map())
      ]);

      const shell = await buildShellData(req, {
        pageTitle: 'User Management',
        section: 'users',
        contentView: '../content/admin-users',
        users: page.rows,
        query: req.query,
        archivedUsers,
        assistantAccounts,
        archivedAssistantAccounts,
        availableAssistantBranches,
        rosterCounts,
        folder,
        needsTutorCount
      });
      res.render('shells/dashboard', shell);
    } catch (error) {
      next(error);
    }
  });

  /**
   * Student Profiles and Tutor Profiles used to be their own pages: the same
   * row list over the same query with the role pinned. User Management already
   * lists every user, and its search finds a role as readily as a name.
   *
   * Kept as redirects so older links and bookmarks land on User Management
   * rather than a 404.
   */
  router.get('/students', (req, res) => res.redirect(`${basePath}/users`));
  router.get('/tutors', (req, res) => res.redirect(`${basePath}/users`));

  // Route handler: GET request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.get('/profile/:id', async (req, res, next) => {
    try {
      const user = await getUserById(req.params.id);
      if (!user) {
        setFlash(req, 'error', 'User not found.');
        return res.redirect(`${basePath}/users`);
      }

      /*
       * An Assistant Admin's profile is an account plus a ROSTER: every tutor and
       * student who has been under them, current and former, with the dates.
       * The former half is the point — once an assistant is replaced, their
       * branch belongs to someone else, and this is the only place left that
       * says who they were responsible for. It used to render the student/tutor
       * form (year level, subjects, "Manage subjects") and be titled "Tutor
       * Profile".
       *
       * The admin can open any assistant, archived or not. An assistant can open
       * only their own.
       */
      if (user.role === 'admin_assistant') {
        const isSelf = Number(user.id) === Number(req.session.user.id);
        if (req.session.user.role !== 'admin' && !isSelf) {
          setFlash(req, 'error', 'You can only view your own account.');
          return res.redirect(`${basePath}/users`);
        }
        const [roster, allBranches] = await Promise.all([
          getAssistantRoster(user, {
            role: req.query.role,
            period: req.query.period,
            search: req.query.search,
            page: req.query.page
          }),
          getBranches()
        ]);
        const shell = await buildShellData(req, {
          pageTitle: isSelf ? 'My Profile' : 'Assistant Admin Profile',
          section: isSelf ? 'profile' : 'users',
          contentView: '../content/admin-assistant-profile',
          profileUser: user,
          roster,
          assistantBranches: allBranches,
          query: req.query
        });
        return res.render('shells/dashboard', shell);
      }

      const isOwnAdminProfile = Number(user.id) === Number(req.session.user.id) && ['admin', 'admin_assistant'].includes(user.role);
      if (!isOwnAdminProfile && req.session.user.role === 'admin_assistant' && Number(user.branch_id) !== Number(req.session.user.assistant_scope_branch_id)) {
        setFlash(req, 'error', 'You can only view profiles from your branch.');
        return res.redirect(`${basePath}/users`);
      }
      const [studentAssignments, tutorAssignments, subjectOptions] = await Promise.all([
        user.role === 'student' ? getStudentAssignments(user.id) : Promise.resolve([]),
        user.role === 'tutor' ? getTutorAssignments(user.id) : Promise.resolve([]),
        getSubjects(false)
      ]);

      // The admin's tutor/schedule editor needs, for EACH of the student's
      // subjects, the tutors who teach that subject at this student's branch
      // (home branch or a second branch they serve), and which of the centre's
      // slots each tutor already has taken.
      let assignableTutors = [];
      let tutorsBySubject = {};
      if (user.role === 'student') {
        const branchOf = (tutor) => new Set([tutor.branch_id, ...normalizeArray(tutor.extra?.branch_ids || [])]
          .map((id) => Number(id)).filter(Boolean));
        assignableTutors = (await getUsers({ role: 'tutor' }))
          .filter((tutor) => !user.branch_id || branchOf(tutor).has(Number(user.branch_id)))
          .map((tutor) => ({ ...tutor, matchesLevel: matchesTutorStudentScope(tutor, user).yearLevelMatch }));
        tutorsBySubject = Object.fromEntries(studentAssignments.map((assignment) => [
          String(assignment.subject_id),
          assignableTutors
            .filter((tutor) => tutorTeachesSubject(tutor, assignment.subject_name))
            .sort((a, b) => Number(b.matchesLevel) - Number(a.matchesLevel))
        ]));
      }
      const currentTutor = user.role === 'student' ? await getAssignedTutorFor(user.id) : null;
      const tutorSlotUsage = user.role === 'student'
        ? await query(
            `SELECT usa.tutor_id, usa.time_slot, usa.student_id, usa.subject_id
               FROM user_subject_assignments usa
              WHERE usa.is_archived = 0 AND usa.tutor_id IS NOT NULL AND usa.time_slot IS NOT NULL`
          )
        : [];

      const shell = await buildShellData(req, {
        pageTitle: isOwnAdminProfile ? 'Admin Profile' : `${user.role === 'student' ? 'Student' : 'Tutor'} Profile`,
        section: isOwnAdminProfile ? 'profile' : 'users',
        contentView: '../content/admin-profile',
        profileUser: user,
        studentAssignments,
        tutorAssignments,
        subjectOptions,
        assignableTutors,
        tutorsBySubject,
        currentTutor,
        tutorSlotUsage,
        // A tutor's levels are offered in the words the tutor registered with,
        // and whatever is stored is read through the same normaliser, so an
        // older "Pre School Level" still shows up ticked as "Preschool".
        tutorYearLevelOptions: TUTOR_YEAR_LEVEL_OPTIONS,
        tutorYearLevels: user.role === 'tutor'
          ? normalizeTutorYearLevels([user.year_level || '', ...normalizeArray(user.extra?.year_levels || [])])
          : [],
        timeSlots: FIXED_TIME_SLOTS,
        supportOptions: ['Exam Preparation & Reviews','Homework Assistance','Project Guidance']
      });
      res.render('shells/dashboard', shell);
    } catch (error) {
      next(error);
    }
  });

  /**
   * Set a student's tutor and time schedule.
   *
   * A tutor is written only to the subjects they teach (setStudentTutorAndSchedule
   * enforces it). Posted with `subject_ids`, it sets the tutor for those subjects
   * — one row of the profile's per-subject editor; without, for every subject of
   * the student that the tutor teaches, and the flash names any subject left
   * needing another tutor.
   */
  router.post('/profile/:id/tutor', async (req, res, next) => {
    const backTo = `${basePath}/profile/${req.params.id}#tutor-schedule`;
    try {
      const student = await getUserById(req.params.id);
      if (!student || student.role !== 'student') {
        setFlash(req, 'error', 'Student not found.');
        return res.redirect(`${basePath}/users`);
      }
      if (!canActOnBranch(req.session.user, student.branch_id)) {
        setFlash(req, 'error', 'You can only manage students from your branch.');
        return res.redirect(`${basePath}/users`);
      }

      const result = await setStudentTutorAndSchedule(
        student.id,
        { tutorId: req.body.tutor_id, timeSlot: req.body.time_slot, subjectIds: normalizeArray(req.body.subject_ids) },
        req.session.user
      );

      const subjects = (result.subjectNames || []).join(', ');
      let message;
      if (result.tutorId) {
        message = `${result.tutorName} is now the tutor for ${subjects}${result.timeSlot ? `, at ${result.timeSlot}` : ''}.`;
        if ((result.skippedSubjects || []).length) {
          message += ` ${result.tutorName} does not teach ${result.skippedSubjects.join(', ')} — `
            + `choose another tutor for ${result.skippedSubjects.length === 1 ? 'it' : 'them'} below.`;
        }
      } else {
        message = `Tutor and schedule cleared for ${subjects}.`;
      }
      setFlash(req, 'success', message);
      return res.redirect(backTo);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not update the tutor or schedule.');
      return res.redirect(backTo);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/profile/:id/password', async (req, res, next) => {
    try {
      const profileUser = await getUserById(req.params.id);
      if (!profileUser) {
        setFlash(req, 'error', 'User not found.');
        return res.redirect(`${basePath}/users`);
      }
      if (Number(req.session.user.id) !== Number(profileUser.id)) {
        setFlash(req, 'error', 'You can only change your own password.');
        return res.redirect(`${basePath}/profile/${req.params.id}`);
      }

      const currentPassword = String(req.body.current_password || '');
      const newPassword = String(req.body.new_password || '');
      const confirmPassword = String(req.body.confirm_password || '');

      if (!currentPassword || !newPassword || !confirmPassword) {
        setFlash(req, 'error', 'Please complete all password fields.');
        return res.redirect(`${basePath}/profile/${req.params.id}`);
      }
      if (newPassword !== confirmPassword) {
        setFlash(req, 'error', 'New password and confirm password do not match.');
        return res.redirect(`${basePath}/profile/${req.params.id}`);
      }
      if (currentPassword === newPassword) {
        setFlash(req, 'error', 'New password must be different from the current password.');
        return res.redirect(`${basePath}/profile/${req.params.id}`);
      }

      await changeUserPassword(profileUser.id, currentPassword, newPassword);
      setFlash(req, 'success', 'Password changed successfully. Please use the new password on your next login.');
      return res.redirect(`${basePath}/profile/${req.params.id}`);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not change password.');
      return res.redirect(`${basePath}/profile/${req.params.id}`);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/profile/:id', profileUploader.single('image'), async (req, res, next) => {
    try {
      const profileUser = await getUserById(req.params.id);
      if (!profileUser) {
        setFlash(req, 'error', 'User not found.');
        return res.redirect(`${basePath}/users`);
      }
      if (req.session.user.role === 'admin_assistant' && Number(profileUser.branch_id) !== Number(req.session.user.assistant_scope_branch_id)) {
        setFlash(req, 'error', 'You can only update users from your branch.');
        return res.redirect(`${basePath}/users`);
      }
      // An assistant account is not a learner record: it is edited through
      // /assistant-accounts/:id/update, which keeps its branch scope in step.
      if (profileUser.role === 'admin_assistant') {
        setFlash(req, 'error', 'Assistant accounts are edited from the Account panel on their profile.');
        return res.redirect(`${basePath}/profile/${profileUser.id}`);
      }
      const archivedSubjects = normalizeArray(profileUser.extra?.archived_subjects || []);
      const existingSubjects = Array.isArray(profileUser.subjects) ? profileUser.subjects : normalizeArray(profileUser.subjects_json || '');
      const existingSupports = Array.isArray(profileUser.supports) ? profileUser.supports : normalizeArray(profileUser.support_json || '');
      const existingBranchIds = [Number(profileUser.branch_id || 0), ...normalizeArray(profileUser.extra?.branch_ids || []).map((value) => Number(value)).filter(Boolean)].filter(Boolean);
      const existingYearLevels = [...new Set([...(String(profileUser.year_level || '').split(',').map((value) => value.trim()).filter(Boolean)), ...normalizeArray(profileUser.extra?.year_levels || [])])];
      const nextSubjectsRaw = normalizeArray(req.body.subjects);
      const nextSubjects = (nextSubjectsRaw.length ? nextSubjectsRaw : existingSubjects).filter((name) => !archivedSubjects.includes(name));
      const nextBranchIdsRaw = normalizeArray(req.body.branch_ids).map((value) => Number(value)).filter(Boolean);
      const nextBranchIds = nextBranchIdsRaw.length ? nextBranchIdsRaw : existingBranchIds;
      const nextYearLevelsRaw = normalizeArray(req.body.year_levels);
      const nextYearLevels = nextYearLevelsRaw.length ? nextYearLevelsRaw : existingYearLevels;
      const nextSupportsRaw = normalizeArray(req.body.supports);
      const nextSupports = nextSupportsRaw.length ? nextSupportsRaw : existingSupports;
      await updateUser(req.params.id, {
        ...req.body,
        branch_id: req.body.branch_id || nextBranchIds[0] || profileUser.branch_id,
        branch_ids: nextBranchIds,
        year_levels: nextYearLevels,
        subjects: nextSubjects,
        supports: nextSupports,
        updated_by: req.session.user.id,
        image_path: req.file ? `/uploads/profiles/${req.file.filename}` : null,
        extra: {
          ...profileUser.extra,
          note: req.body.note || profileUser.extra?.note || '',
          preferred_schedule: req.body.preferred_schedule || profileUser.extra?.preferred_schedule || '',
          target_goals: req.body.target_goals || profileUser.extra?.target_goals || '',
          archived_subjects: archivedSubjects
        }
      });
      // Your own new photo shows in the topbar straight away, not at next login.
      if (req.file && Number(profileUser.id) === Number(req.session.user.id)) {
        req.session.user.image_path = `/uploads/profiles/${req.file.filename}`;
      }
      setFlash(req, 'success', 'Profile updated successfully.');
      res.redirect(`${basePath}/profile/${req.params.id}`);
    } catch (error) {
      next(error);
    }
  });

  /**
   * An Assistant Admin's profile photo. Registration no longer asks for a
   * photo — everyone sets their own once logged in — and the assistant's
   * account is edited from its roster page, which had no way to add one.
   * The assistant may change their own; the main admin, any assistant's.
   */
  router.post('/profile/:id/photo', profileUploader.single('image'), async (req, res) => {
    const backTo = `${basePath}/profile/${Number(req.params.id)}`;
    try {
      const profileUser = await getUserById(req.params.id);
      if (!profileUser || profileUser.role !== 'admin_assistant') {
        setFlash(req, 'error', 'Account not found.');
        return res.redirect(`${basePath}/users`);
      }
      const isSelf = Number(profileUser.id) === Number(req.session.user.id);
      if (!isSelf && req.session.user.role !== 'admin') {
        setFlash(req, 'error', 'You can only change your own photo.');
        return res.redirect(backTo);
      }
      if (!req.file) {
        setFlash(req, 'error', describeUploadRejection(req) || 'Choose a photo first.');
        return res.redirect(backTo);
      }
      const imagePath = `/uploads/profiles/${req.file.filename}`;
      await query('UPDATE users SET image_path = ?, updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?', [imagePath, profileUser.id]);
      if (isSelf) req.session.user.image_path = imagePath;
      setFlash(req, 'success', 'Profile photo updated.');
      return res.redirect(backTo);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not save the photo.');
      return res.redirect(backTo);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/users/:id/archive', async (req, res, next) => {
    try {
      const scope = req.session.user.role === 'admin_assistant' ? req.session.user.assistant_scope_branch_id : null;
      await archiveUser(req.params.id, scope);
      setFlash(req, 'success', 'User archived successfully.');
      res.redirect(`${basePath}/users`);
    } catch (error) {
      next(error);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/users/:id/recover', async (req, res, next) => {
    try {
      const scope = req.session.user.role === 'admin_assistant' ? req.session.user.assistant_scope_branch_id : null;
      await recoverUser(req.params.id, scope);
      setFlash(req, 'success', 'User recovered successfully.');
      res.redirect(`${basePath}/users`);
    } catch (error) {
      next(error);
    }
  });


  // Route handler: POST request


  // Purpose: Processes this endpoint and returns the correct view or action result.


  router.post('/assistant-accounts', async (req, res, next) => {
    try {
      if (req.session.user.role !== 'admin') {
        setFlash(req, 'error', 'Only the main admin can manage assistant accounts.');
        return res.redirect(`${basePath}/users`);
      }
      await createAssistantAccount(req.body.branch_id, req.body.email, req.body.password, req.session.user, req.body.assistant_name || '');
      setFlash(req, 'success', 'Branch admin assistant account created.');
      res.redirect(`${basePath}/users`);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not create assistant account.');
      res.redirect(`${basePath}/users`);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  /*
   * The three actions below change an assistant account, and only the main admin
   * manages those. They had no role check at all, so an assistant could post
   * here to move their own account to another branch — widening what they are
   * allowed to see — or archive another branch's assistant.
   *
   * Each returns to the assistant's profile when that is where it was sent from,
   * so an edit made there lands back on the roster rather than the user list.
   */
  function assistantAccountReturn(req) {
    return req.body?.return_to === 'profile' ? `${basePath}/profile/${Number(req.params.id)}` : `${basePath}/users`;
  }

  function refuseUnlessAdmin(req, res) {
    if (req.session.user.role === 'admin') return false;
    setFlash(req, 'error', 'Only the main admin can manage assistant accounts.');
    res.redirect(`${basePath}/users`);
    return true;
  }

  router.post('/assistant-accounts/:id/update', async (req, res) => {
    if (refuseUnlessAdmin(req, res)) return;
    try {
      await updateAssistantAccount(req.params.id, req.body);
      setFlash(req, 'success', 'Assistant account updated.');
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not update assistant account.');
    }
    res.redirect(assistantAccountReturn(req));
  });

  router.post('/assistant-accounts/:id/archive', async (req, res, next) => {
    if (refuseUnlessAdmin(req, res)) return;
    try {
      await archiveUser(req.params.id);
      setFlash(req, 'success', 'Assistant account archived. Their tutors and students stay on record in their profile.');
      res.redirect(assistantAccountReturn(req));
    } catch (error) { next(error); }
  });

  router.post('/assistant-accounts/:id/recover', async (req, res, next) => {
    if (refuseUnlessAdmin(req, res)) return;
    try {
      await recoverUser(req.params.id);
      setFlash(req, 'success', 'Assistant account recovered successfully.');
      res.redirect(assistantAccountReturn(req));
    } catch (error) { next(error); }
  });


  // Route handler: POST request


  // Purpose: Processes this endpoint and returns the correct view or action result.


  router.post('/users/:id/delete', async (req, res, next) => {
    try {
      const scope = req.session.user.role === 'admin_assistant' ? req.session.user.assistant_scope_branch_id : null;
      await deleteUserPermanently(req.params.id, scope);
      setFlash(req, 'success', 'User deleted permanently.');
      res.redirect(`${basePath}/users`);
    } catch (error) {
      next(error);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/assistant-accounts', async (req, res, next) => {
    try {
      if (req.session.user.role !== 'admin') {
        setFlash(req, 'error', 'Only the main admin can create branch assistant accounts.');
        return res.redirect(`${basePath}/users`);
      }
      await createAssistantAccount(req.body.branch_id, req.body.email, req.body.password, req.session.user, req.body.assistant_name || '');
      setFlash(req, 'success', 'Admin assistant account created successfully.');
      res.redirect(`${basePath}/users`);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not create admin assistant account.');
      res.redirect(`${basePath}/users`);
    }
  });

  // Route handler: GET request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.get('/branches', async (req, res, next) => {
    try {
      if (req.session.user.role !== 'admin') {
        setFlash(req, 'error', 'Only the main admin can manage branches.');
        return res.redirect(basePath);
      }
      const [branches, archivedBranches] = await Promise.all([getBranches(false), getBranches(true)]);
      const shell = await buildShellData(req, {
        pageTitle: 'Branch Management',
        section: 'branches',
        contentView: '../content/admin-branches',
        branches,
        archivedBranches: archivedBranches.filter((branch) => Number(branch.is_archived) === 1)
      });
      res.render('shells/dashboard', shell);
    } catch (error) {
      next(error);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/branches/add', async (req, res, next) => {
    try {
      if (req.session.user.role !== 'admin') {
        setFlash(req, 'error', 'Only the main admin can add branches.');
        return res.redirect(basePath);
      }
      await addBranch(req.body.name);
      setFlash(req, 'success', 'Branch added successfully.');
      res.redirect(`${basePath}/branches`);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not add branch.');
      res.redirect(`${basePath}/branches`);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/branches/:id/archive', async (req, res, next) => {
    try {
      if (req.session.user.role !== 'admin') {
        setFlash(req, 'error', 'Only the main admin can archive branches.');
        return res.redirect(basePath);
      }
      await archiveBranch(req.params.id);
      setFlash(req, 'success', 'Branch archived successfully.');
      res.redirect(`${basePath}/branches`);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not archive branch.');
      res.redirect(`${basePath}/branches`);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/branches/:id/recover', async (req, res, next) => {
    try {
      if (req.session.user.role !== 'admin') {
        setFlash(req, 'error', 'Only the main admin can recover branches.');
        return res.redirect(basePath);
      }
      await recoverBranch(req.params.id);
      setFlash(req, 'success', 'Branch recovered successfully.');
      res.redirect(`${basePath}/branches`);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not recover branch.');
      res.redirect(`${basePath}/branches`);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/branches/:id/delete', async (req, res, next) => {
    try {
      if (req.session.user.role !== 'admin') {
        setFlash(req, 'error', 'Only the main admin can delete branches.');
        return res.redirect(basePath);
      }
      await deleteBranchPermanently(req.params.id);
      setFlash(req, 'success', 'Branch deleted permanently.');
      res.redirect(`${basePath}/branches`);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Branch cannot be deleted while it is still in use.');
      res.redirect(`${basePath}/branches`);
    }
  });


  // Route handler: GET request


  // Purpose: Processes this endpoint and returns the correct view or action result.


  router.get('/branches/:id', async (req, res, next) => {
    try {
      if (req.session.user.role !== 'admin') {
        setFlash(req, 'error', 'Only the main admin can view branch details.');
        return res.redirect(basePath);
      }
      const branch = await getBranchById(req.params.id);
      if (!branch) {
        setFlash(req, 'error', 'Branch not found.');
        return res.redirect(`${basePath}/branches`);
      }
      const members = await getBranchMembers(req.params.id);
      const shell = await buildShellData(req, {
        pageTitle: `${branch.name}`,
        section: 'branches',
        contentView: '../content/admin-branch-detail',
        branch,
        students: members.filter((item) => item.role === 'student'),
        tutors: members.filter((item) => item.role === 'tutor')
      });
      res.render('shells/dashboard', shell);
    } catch (error) {
      next(error);
    }
  });

  // Route handler: GET request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  /**
   * Student Bill — row-based, one row per student, with the full payment ledger
   * attached to each row, AND the POS counter it used to duplicate.
   *
   * WHY THE POS LIVES HERE
   * The POS started as its own page and was immediately redundant: Student Bill
   * already lists every account with its balance and a "+" that records a
   * payment. Two screens for "take money from a student" is two places to keep
   * in step, and staff had to know which one to open. The genuinely new parts —
   * the queue of slips waiting at the counter, and looking a student up by the
   * slip code they are holding — are now a section of this page instead.
   *
   * `edit` and `info` in the query string still work: they open the header form
   * or the SOA panel for that student, which is what the old links pointed at.
   * `slip` opens the counter form for one waiting slip.
   */
  /** The branch Student Bill covers: an assistant's own, or every branch. */
  function billingScopeBranchId(req) {
    return req.session.user.role === 'admin_assistant'
      ? Number(req.session.user.assistant_scope_branch_id)
      : null;
  }

  router.get('/billing', async (req, res, next) => {
    try {
      // No search, status or branch filters any more, and no page numbers: every
      // account is listed in a table that shows ten rows and scrolls, and the
      // search icon in its heading finds a student by anything in their row.
      const scopeBranchId = billingScopeBranchId(req);
      const scope = resolveScope(req.session.user);

      // ---- the counter (was /pos) ------------------------------------------
      // Slips still waiting to be paid, oldest first: that is the queue at the
      // desk, so it is ordered the way the desk works.
      const openSlips = (await getPaymentRequests(scope, { status: 'pending' }))
        .slice()
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

      // `slip` opens that slip's counter form ("Record a different amount", and
      // the link a slip's staff alert carries).
      let selectedSlip = null;
      const byCode = parseSlipCode(req.query.slip);
      if (byCode) {
        const request = await getPaymentRequestById(byCode);
        if (request && request.status === 'pending' && canActOnBranch(req.session.user, request.branch_id)) {
          selectedSlip = { request, ledger: await getBillingLedger(request.student_id) };
        }
      }

      // Every account, each with its ledger totals (one query for all the
      // entries). The three dialogs a row opens are NOT built here: they are
      // fetched when a row's button is pressed (GET /billing/:id/dialogs), so
      // the page does not carry six hundred hidden forms. The one a link asks
      // to open (?info=, ?pay=, ?edit=) is rendered with the page.
      const billingRows = await attachPaymentLedgers(await getBillingRows(scopeBranchId, 'all', {}));
      const paymentHistory = await getPaymentHistory(scopeBranchId);

      const billingStudentIds = new Set(billingRows.map((row) => String(row.student_id)));
      const openEditStudentId = billingStudentIds.has(String(req.query.edit || '')) ? String(req.query.edit) : '';
      const openInfoStudentId = billingStudentIds.has(String(req.query.info || '')) ? String(req.query.info) : '';
      const openPayStudentId = billingStudentIds.has(String(req.query.pay || '')) ? String(req.query.pay) : '';
      const preloadIds = new Set([openEditStudentId, openInfoStudentId, openPayStudentId].filter(Boolean));

      const totals = billingRows.reduce((acc, row) => {
        acc.billed += Number(row.full_bill || 0);
        acc.paid += Number(row.partial_payment || 0);
        acc.remaining += Number(row.for_settlement || 0);
        if (row.payment_status === 'paid') acc.settled += 1;
        return acc;
      }, { billed: 0, paid: 0, remaining: 0, settled: 0, accounts: billingRows.length });

      const shell = await buildShellData(req, {
        pageTitle: 'Student Bill',
        section: 'billing',
        contentView: '../content/admin-billing',
        billingRows,
        preloadRows: billingRows.filter((row) => preloadIds.has(String(row.student_id))),
        paymentHistory,
        billingTotals: totals,
        paymentMethods: PAYMENT_METHODS,
        paymentPurposes: PAYMENT_PURPOSES,
        query: req.query,
        openEditStudentId,
        openInfoStudentId,
        openPayStudentId,
        // The counter, folded in from the old /pos page.
        openSlips,
        selectedSlip,
        slipCode
      });
      res.render('shells/dashboard', shell);
    } catch (error) {
      next(error);
    }
  });

  /**
   * The three dialogs one Student Bill row opens — add payment, payment record
   * & SOA, edit the bill — rendered on demand when one of its buttons is
   * pressed. Same partial the page uses for a dialog a link opens directly.
   */
  router.get('/billing/:studentId/dialogs', async (req, res) => {
    try {
      const studentId = normalizeRouteId(req.params.studentId);
      const rows = studentId
        ? await getBillingRows(billingScopeBranchId(req), 'all', { studentId: Number(studentId) })
        : [];
      if (!rows.length || !canActOnBranch(req.session.user, rows[0].branch_id)) {
        return res.status(404).type('text/plain').send('Billing record not found.');
      }
      const [row] = await attachPaymentLedgers(rows);
      return res.render('partials/billing-dialogs', {
        row,
        basePath,
        currentUser: req.session.user,
        paymentMethods: PAYMENT_METHODS,
        paymentPurposes: PAYMENT_PURPOSES,
        openPayStudentId: '',
        openInfoStudentId: '',
        openEditStudentId: ''
      });
    } catch (error) {
      return res.status(500).type('text/plain').send(error.message || 'Could not load this billing record.');
    }
  });

  /**
   * Append one payment to a student's ledger — the "+" button's endpoint.
   *
   * There is no counterpart that edits or deletes an entry, which is the point:
   * a later payment can never overwrite an earlier one because no code path
   * exists that would let it.
   */
  router.post('/billing/:studentId/payments', async (req, res, next) => {
    const backTo = `${basePath}/billing`;
    try {
      const studentId = await resolveExistingBillingStudentId(req);
      if (!studentId) {
        setFlash(req, 'error', 'Invalid student billing record.');
        return res.redirect(backTo);
      }

      // An assistant may only touch accounts in their own branch. The billing
      // list is already branch-scoped, but the POST is a separate request and
      // has to be checked on its own.
      const student = await getUserById(studentId);
      if (!canActOnBranch(req.session.user, student?.branch_id)) {
        setFlash(req, 'error', 'You can only record payments for students in your branch.');
        return res.redirect(backTo);
      }

      const result = await addPaymentEntry({
        studentId: Number(studentId),
        amount: req.body.amount,
        paymentMethod: req.body.payment_method,
        purpose: req.body.purpose,
        referenceNo: req.body.reference_no,
        notes: req.body.notes,
        paidAt: req.body.paid_at || null,
        actor: req.session.user,
        source: 'admin'
      });

      setFlash(
        req,
        'success',
        `Payment #${result.sequenceNo} recorded. Total paid ₱${result.totals.paid.toFixed(2)}, `
        + `remaining balance ₱${result.totals.settlement.toFixed(2)}.`
      );
      res.redirect(`${backTo}?info=${studentId}`);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not record that payment.');
      res.redirect(backTo);
    }
  });

  /**
   * Payment Collection (was "Income Report") — one row per transaction, with search, date range, branch,
   * method and purpose filters, and a compact summary bar on top.
   */
  router.get('/income-report', async (req, res, next) => {
    try {
      // Every transaction in scope (an assistant: their branch). The search,
      // date, branch, method and purpose filters, Print, and the page numbers
      // are gone: the table shows ten rows and scrolls, and the search icon in
      // its heading finds any transaction by what is in its row.
      const scope = resolveScope(req.session.user);
      const rows = await getPaymentLedger(scope, {});
      const summary = summarisePaymentLedger(rows);

      // Outstanding is a property of the accounts, not of the transactions, so it
      // is read from billing rather than derived from the rows above.
      const outstandingRows = await getBillingRows(billingScopeBranchId(req), false);
      const outstanding = outstandingRows.reduce((sum, row) => sum + Number(row.for_settlement || 0), 0);

      const shell = await buildShellData(req, {
        // Phase 7.3: "Income Report" -> "Payment Collection". The page reports
        // money COLLECTED from students, which is not the centre's income — it
        // says nothing about costs — and staff read the old title as a P&L.
        // The URL stays /income-report so existing links and bookmarks work.
        pageTitle: 'Payment Collection',
        section: 'income',
        contentView: '../content/admin-income-report',
        rows,
        summary: { ...summary, outstanding: Math.round(outstanding * 100) / 100 },
        query: req.query
      });
      res.render('shells/dashboard', shell);
    } catch (error) {
      next(error);
    }
  });

  // Route handler: GET request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.get('/billing/:studentId/edit', (req, res) => {
    const studentId = resolveBillingStudentId(req);
    if (!studentId) {
      setFlash(req, 'error', 'Invalid student billing record.');
      return res.redirect(`${basePath}/billing`);
    }
    return res.redirect(`${basePath}/billing?edit=${studentId}`);
  });

  // Route handler: GET request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.get('/billing/:studentId/info', (req, res) => {
    const studentId = resolveBillingStudentId(req);
    if (!studentId) {
      setFlash(req, 'error', 'Invalid student billing record.');
      return res.redirect(`${basePath}/billing`);
    }
    return res.redirect(`${basePath}/billing?info=${studentId}`);
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/billing/:studentId/update', async (req, res, next) => {
    try {
      const studentId = await resolveExistingBillingStudentId(req);
      if (!studentId) {
        setFlash(req, 'error', 'Invalid student billing record.');
        return res.redirect(`${basePath}/billing`);
      }
      await updateBilling(studentId, req.body, req.session.user.id);
      setFlash(req, 'success', 'Billing information updated.');
      res.redirect(`${basePath}/billing?edit=${studentId}`);
    } catch (error) {
      next(error);
    }
  });



  // Route handler: POST request



  // Purpose: Processes this endpoint and returns the correct view or action result.



  router.post('/billing/update', async (req, res, next) => {
    try {
      const studentId = await resolveExistingBillingStudentId(req);
      if (!studentId) {
        setFlash(req, 'error', 'Invalid student billing record.');
        return res.redirect(`${basePath}/billing`);
      }
      await updateBilling(studentId, req.body, req.session.user.id);
      setFlash(req, 'success', 'Billing information updated.');
      res.redirect(`${basePath}/billing?edit=${studentId}`);
    } catch (error) {
      next(error);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/billing/:billingId/paid', async (req, res, next) => {
    try {
      const billingId = resolveBillingStudentId(req);
      if (!billingId) {
        setFlash(req, 'error', 'Invalid billing record.');
        return res.redirect(`${basePath}/billing`);
      }
      await markBillPaid(billingId, req.session.user.id);
      setFlash(req, 'success', 'Student marked as paid.');
      res.redirect(`${basePath}/billing`);
    } catch (error) {
      next(error);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/billing/:studentId/post-soa', async (req, res, next) => {
    try {
      const studentId = await resolveExistingBillingStudentId(req);
      if (!studentId) {
        setFlash(req, 'error', 'Invalid student billing record.');
        return res.redirect(`${basePath}/billing`);
      }
      await postSoa(studentId, req.session.user.id);
      setFlash(req, 'success', 'SOA posted to the student billing page.');
      res.redirect(`${basePath}/billing?info=${studentId}`);
    } catch (error) {
      next(error);
    }
  });




  // Route handler: POST request




  // Purpose: Processes this endpoint and returns the correct view or action result.




  router.post('/billing/post-soa', async (req, res, next) => {
    try {
      const studentId = await resolveExistingBillingStudentId(req);
      if (!studentId) {
        setFlash(req, 'error', 'Invalid student billing record.');
        return res.redirect(`${basePath}/billing`);
      }
      await postSoa(studentId, req.session.user.id);
      setFlash(req, 'success', 'SOA posted to the student billing page.');
      res.redirect(`${basePath}/billing?info=${studentId}`);
    } catch (error) {
      next(error);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/billing/reenroll', async (req, res, next) => {
    try {
      const ids = Array.isArray(req.body.student_ids) ? req.body.student_ids : [req.body.student_ids];
      await reenrollStudents(ids);
      setFlash(req, 'success', 'Selected students were re-enrolled to billing list.');
      res.redirect(`${basePath}/billing`);
    } catch (error) { next(error); }
  });

  // Route handler: GET request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.get('/payments/history', async (req, res, next) => {
    try {
      const scopeBranchId = getScopeBranchId(req);
      const paymentHistory = await getPaymentHistory(scopeBranchId);
      const shell = await buildShellData(req, {
        pageTitle: 'Payment History',
        section: 'payment_history',
        contentView: '../content/admin-payment-history',
        paymentHistory
      });
      res.render('shells/dashboard', shell);
    } catch (error) {
      next(error);
    }
  });

  // ==========================================================================
  // Notifications & payment requests
  //
  // One page, two lists: the cash payment requests students have submitted, and
  // the system alerts addressed to this role. Both are searchable because both
  // can grow without limit.
  //
  // Neither list is filtered by "who it was sent to" beyond the role scope — the
  // brief's rule is that either Admin or Assistant Admin, whoever sees it first,
  // opens and processes it.
  // ==========================================================================

  router.get('/notifications', async (req, res, next) => {
    try {
      const scope = resolveScope(req.session.user, { requestedBranchId: req.query.branch_id });
      const search = String(req.query.search || '').trim();
      const status = req.query.status || 'all';

      const [allRequests, allAlerts] = await Promise.all([
        getPaymentRequests(scope, { status, search }),
        getAppNotifications(req.session.user, { search })
      ]);

      // Every slip and every alert: each table shows ten rows and scrolls, with
      // a search icon in its heading, instead of page numbers.
      const requests = allRequests;
      const alerts = allAlerts;
      const openRequestId = req.query.request ? String(req.query.request) : '';

      const shell = await buildShellData(req, {
        pageTitle: 'Notifications',
        section: 'notifications',
        contentView: '../content/admin-notifications',
        requests,
        // The topbar bell's own list of unread alerts is separate (buildShellData).
        alerts,
        // Requests are payment slips now (Phase 3), and the page labels them
        // with the same code the student is holding.
        slipCode,
        search,
        selectedStatus: status,
        query: req.query,
        openRequestId,
        summary: {
          pending: allRequests.filter((r) => r.status === 'pending').length,
          completed: allRequests.filter((r) => r.status === 'completed').length,
          unreadAlerts: allAlerts.filter((a) => !a.is_read).length
        }
      });

      // The registration and subject-enrolment inbox. The sidebar badge has
      // always counted it, but when the topbar bell was retired (Phase 7.1) its
      // list went with it and nothing on this page rendered it — so a student's
      // request to add a subject raised the badge and could not be found or
      // accepted anywhere. It is listed here now, first, because it is the part
      // of this page that is waiting on a decision. The search box applies to it
      // as well; the badge and the summary count stay unfiltered.
      const needle = search.toLowerCase();
      shell.inboxItems = !needle
        ? shell.inboxNotifications
        : shell.inboxNotifications.filter((item) => [
          item.first_name, item.middle_name, item.last_name, item.user_id, item.email,
          item.subject_name, item.branch_name
        ].some((value) => String(value || '').toLowerCase().includes(needle)));
      shell.summary.waiting = shell.inboxNotifications.length;

      res.render('shells/dashboard', shell);
    } catch (error) {
      next(error);
    }
  });

  /* ========================================================================
     POS — the counter (Phase 3)
     ------------------------------------------------------------------------
     Cash is no longer something a student "requests" and an admin "confirms"
     from a notification. The student brings a slip; this screen is where the
     money is entered, once, by whoever took it.

     Two ways in, because both happen at a real counter:
       - by slip code, when the student has one (the normal case), and
       - straight against a student, for a walk-in with no slip.
     Both end in exactly one ledger append, so neither can double-count.
     ======================================================================== */

  /**
   * The POS used to be its own page. It is a section of Student Bill now — that
   * page already lists every account with its balance and a button that records
   * a payment, so a second screen for the same job was one more place to keep in
   * step and one more decision for whoever is at the desk.
   *
   * Kept as a redirect rather than deleted: the alert a student's slip raises
   * links to /pos?slip=N, and those rows are already sitting in staff queues.
   * The query string is carried across so such a link still opens that slip.
   */
  router.get('/pos', (req, res) => {
    const qs = new URLSearchParams(req.query).toString();
    return res.redirect(`${basePath}/billing${qs ? `?${qs}` : ''}`);
  });

  /**
   * Take the money. One append to the ledger, whichever way the counter got here.
   *
   * A slip is completed through completePaymentRequest so the slip is closed and
   * the payment recorded in the same step — doing it as two actions is how a
   * counter ends up with a paid slip still sitting in the queue.
   */
  router.post('/pos/record', async (req, res, next) => {
    // Back to Student Bill: the counter is a section of that page now.
    const backTo = `${basePath}/billing`;
    try {
      const requestId = Number(req.body.request_id) || null;
      const amount = req.body.amount;
      const note = String(req.body.note || '').trim();
      const referenceNo = String(req.body.reference_no || '').trim();

      if (requestId) {
        const request = await getPaymentRequestById(requestId);
        if (!request) {
          setFlash(req, 'error', 'That payment slip no longer exists.');
          return res.redirect(backTo);
        }
        if (!canActOnBranch(req.session.user, request.branch_id)) {
          setFlash(req, 'error', 'You can only take payments for your own branch.');
          return res.redirect(backTo);
        }

        // One-click "Take payment" from the slip queue sends no amount: the
        // cash received is what the slip says — capped at what is still owed,
        // the same figure the full form offers, since a slip issued before
        // another payment landed can be stale.
        let amountToRecord = amount;
        if (req.body.quick === '1') {
          const ledger = await getBillingLedger(request.student_id);
          const remaining = Number(ledger?.totals?.remaining || 0);
          if (!ledger || remaining <= 0) {
            setFlash(req, 'error', `${slipCode(requestId)} cannot be taken: this student's account has nothing left to pay. Void the slip instead.`);
            return res.redirect(backTo);
          }
          amountToRecord = Math.min(Number(request.amount || 0), remaining).toFixed(2);
        }

        const { request: updated, entry } = await completePaymentRequest(requestId, req.session.user, {
          amount: amountToRecord,
          note: [referenceNo ? `OR/Ref ${referenceNo}` : '', note].filter(Boolean).join(' — ')
        });

        await markAppNotificationReferenceRead('payment_request', requestId, req.session.user)
          .catch((error) => console.error('[notifications] could not mark read:', error.message));

        await notifyAdminRoles({
          type: 'pos_payment',
          title: `POS payment recorded — ${updated.first_name} ${updated.last_name}`,
          message: `₱${Number(updated.recorded_amount || 0).toFixed(2)} taken at `
            + `${updated.branch_name || 'the branch'} against ${slipCode(requestId)}, `
            + `recorded by ${displayActor(req.session.user)}.`,
          linkPath: '/payments/history',
          refType: 'payment_entry',
          refId: entry.entryId,
          branchId: request.branch_id,
          severity: 'success'
        }).catch((error) => console.error('[pos] could not notify staff:', error.message));

        setFlash(req, 'success',
          `₱${Number(updated.recorded_amount || 0).toFixed(2)} recorded for `
          + `${updated.first_name} ${updated.last_name} as payment #${entry.sequenceNo}. `
          + `${slipCode(requestId)} is closed.`);
        return res.redirect(backTo);
      }

      // Walk-in: no slip, so the student is named directly.
      const studentId = Number(req.body.student_id);
      if (!studentId) {
        setFlash(req, 'error', 'Choose a student or a payment slip first.');
        return res.redirect(backTo);
      }
      const student = await getUserById(studentId);
      if (!student || student.role !== 'student') {
        setFlash(req, 'error', 'Student not found.');
        return res.redirect(backTo);
      }
      if (!canActOnBranch(req.session.user, student.branch_id)) {
        setFlash(req, 'error', 'You can only take payments for your own branch.');
        return res.redirect(backTo);
      }

      const entry = await addPaymentEntry({
        studentId,
        amount,
        paymentMethod: req.body.payment_method || 'Cash',
        purpose: req.body.purpose || 'Tuition',
        referenceNo: referenceNo || null,
        notes: note || 'Cash taken at the counter (POS, no slip).',
        actor: req.session.user,
        source: 'admin'
      });

      await notifyAdminRoles({
        type: 'pos_payment',
        title: `POS payment recorded — ${student.first_name} ${student.last_name}`,
        message: `₱${Number(normalizeAmount(amount)).toFixed(2)} taken at the counter with no slip, `
          + `recorded by ${displayActor(req.session.user)}.`,
        linkPath: '/payments/history',
        refType: 'payment_entry',
        refId: entry.entryId,
        branchId: student.branch_id,
        severity: 'success'
      }).catch((error) => console.error('[pos] could not notify staff:', error.message));

      setFlash(req, 'success',
        `₱${Number(normalizeAmount(amount)).toFixed(2)} recorded for `
        + `${student.first_name} ${student.last_name} as payment #${entry.sequenceNo}.`);
      return res.redirect(backTo);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not record that payment.');
      return res.redirect(backTo);
    }
  });

  /** Void a slip that will not be paid — the student left, or it was a mistake. */
  router.post('/pos/:id/cancel', async (req, res, next) => {
    // Back to Student Bill: the counter is a section of that page now.
    const backTo = `${basePath}/billing`;
    try {
      const request = await getPaymentRequestById(Number(req.params.id));
      if (!request) {
        setFlash(req, 'error', 'That payment slip no longer exists.');
        return res.redirect(backTo);
      }
      if (!canActOnBranch(req.session.user, request.branch_id)) {
        setFlash(req, 'error', 'You can only void slips from your own branch.');
        return res.redirect(backTo);
      }
      await cancelPaymentRequest(Number(req.params.id), req.session.user, req.body.note);
      await markAppNotificationReferenceRead('payment_request', Number(req.params.id), req.session.user)
        .catch((error) => console.error('[notifications] could not mark read:', error.message));
      setFlash(req, 'success', `${slipCode(req.params.id)} voided. Nothing was added to the ledger.`);
      return res.redirect(backTo);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not void that slip.');
      return res.redirect(backTo);
    }
  });

  /** Confirm the cash arrived: status Pending -> Completed, ledger entry appended. */
  router.post('/payment-requests/:id/complete', async (req, res, next) => {
    const backTo = `${basePath}/notifications`;
    try {
      const request = await getPaymentRequestById(Number(req.params.id));
      if (!request) {
        setFlash(req, 'error', 'Payment request not found.');
        return res.redirect(backTo);
      }
      if (!canActOnBranch(req.session.user, request.branch_id)) {
        setFlash(req, 'error', 'You can only process payment requests from your branch.');
        return res.redirect(backTo);
      }

      const { request: updated, entry } = await completePaymentRequest(
        Number(req.params.id),
        req.session.user,
        { amount: req.body.amount, note: req.body.note }
      );

      await markAppNotificationReferenceRead('payment_request', Number(req.params.id), req.session.user)
        .catch((error) => console.error('[notifications] could not mark read:', error.message));

      setFlash(
        req,
        'success',
        `Marked completed. ₱${Number(updated.recorded_amount || 0).toFixed(2)} added to `
        + `${updated.first_name} ${updated.last_name}'s ledger as payment #${entry.sequenceNo}.`
      );
      res.redirect(backTo);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not process that payment request.');
      res.redirect(backTo);
    }
  });

  /** Turn a request down. Nothing touches the ledger. */
  router.post('/payment-requests/:id/cancel', async (req, res, next) => {
    const backTo = `${basePath}/notifications`;
    try {
      const request = await getPaymentRequestById(Number(req.params.id));
      if (!request) {
        setFlash(req, 'error', 'Payment request not found.');
        return res.redirect(backTo);
      }
      if (!canActOnBranch(req.session.user, request.branch_id)) {
        setFlash(req, 'error', 'You can only process payment requests from your branch.');
        return res.redirect(backTo);
      }
      await cancelPaymentRequest(Number(req.params.id), req.session.user, req.body.note);
      await markAppNotificationReferenceRead('payment_request', Number(req.params.id), req.session.user)
        .catch((error) => console.error('[notifications] could not mark read:', error.message));
      setFlash(req, 'success', 'Payment request cancelled.');
      res.redirect(backTo);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not cancel that payment request.');
      res.redirect(backTo);
    }
  });

  router.post('/alerts/:id/read', async (req, res, next) => {
    try {
      await markAppNotificationRead(Number(req.params.id), req.session.user);
      res.redirect(req.get('Referer') || `${basePath}/notifications`);
    } catch (error) { next(error); }
  });

  router.post('/alerts/:id/archive', async (req, res, next) => {
    try {
      await archiveAppNotification(Number(req.params.id));
      setFlash(req, 'success', 'Notification archived.');
      res.redirect(`${basePath}/notifications`);
    } catch (error) { next(error); }
  });

  // Route handler: GET request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.get('/subjects', async (req, res, next) => {
    try {
      const [subjects, archivedSubjects] = await Promise.all([
        getSubjects(false),
        getSubjects(true)
      ]);
      const filteredArchived = archivedSubjects.filter((subject) => Number(subject.is_archived) === 1);
      const shell = await buildShellData(req, {
        pageTitle: 'All Subjects',
        section: 'subjects',
        contentView: '../content/admin-subjects',
        subjects,
        archivedSubjects: filteredArchived
      });
      res.render('shells/dashboard', shell);
    } catch (error) {
      next(error);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/subjects/add', async (req, res, next) => {
    try {
      if (req.session.user.role !== 'admin') {
        setFlash(req, 'error', 'Only the main admin can add subjects.');
        return res.redirect(`${basePath}/subjects`);
      }
      await addSubject(req.body.name);
      setFlash(req, 'success', 'Subject added successfully.');
      res.redirect(`${basePath}/subjects`);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not add subject.');
      res.redirect(`${basePath}/subjects`);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/subjects/:id/archive', async (req, res, next) => {
    try {
      if (req.session.user.role !== 'admin') {
        setFlash(req, 'error', 'Only the main admin can archive subjects.');
        return res.redirect(`${basePath}/subjects`);
      }
      await archiveSubject(req.params.id);
      setFlash(req, 'success', 'Subject archived successfully.');
      res.redirect(`${basePath}/subjects`);
    } catch (error) {
      next(error);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/subjects/:id/recover', async (req, res, next) => {
    try {
      if (req.session.user.role !== 'admin') {
        setFlash(req, 'error', 'Only the main admin can recover subjects.');
        return res.redirect(`${basePath}/subjects`);
      }
      await recoverSubject(req.params.id);
      setFlash(req, 'success', 'Subject recovered successfully.');
      res.redirect(`${basePath}/subjects`);
    } catch (error) {
      next(error);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/subjects/:id/delete', async (req, res, next) => {
    try {
      if (req.session.user.role !== 'admin') {
        setFlash(req, 'error', 'Only the main admin can delete subjects.');
        return res.redirect(`${basePath}/subjects`);
      }
      await deleteSubjectPermanently(req.params.id);
      setFlash(req, 'success', 'Subject deleted permanently.');
      res.redirect(`${basePath}/subjects`);
    } catch (error) {
      next(error);
    }
  });

  // Route handler: GET request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.get('/subjects/:id', async (req, res, next) => {
    try {
      const scopeBranchId = getScopeBranchId(req);
      // Everything the tabs show, fetched together rather than one after
      // another: the database is remote, and each round trip is the cost.
      const [
        members, archivedAssignments, archivedTutors, subjectAssessments, modules,
        preResults, preStatus, postAssessment, comparisons
      ] = await Promise.all([
        getSubjectMembers(req.params.id, scopeBranchId),
        getSubjectArchivedAssignments(req.params.id),
        getSubjectArchivedTutors(req.params.id, scopeBranchId),
        // The Legacy Modules panel and its upload/archive/recover routes are
        // gone. "Subject Assessments" lists the assessments that exist today —
        // the Pre-Assessment, every tutor's module assessments, the
        // Post-Assessment — instead of the retired table, which was empty.
        getSubjectAssessmentsOverview(req.params.id),
        // Module system (overhaul Phase 3): All Subjects -> subject -> Modules
        getSubjectModules(req.params.id),
        getSubjectSubmissions(req.params.id, { kind: 'pre_assessment' }),
        getPreAssessmentStatus(req.params.id),
        // Post-Assessment (overhaul Phase 8): Admin reads the before-and-after,
        // but the tutor is the one who opens it.
        getPostAssessment(req.params.id),
        getSubjectPrePostComparison(req.params.id)
      ]);
      const { subject, students, tutors } = members;
      if (!subject) {
        setFlash(req, 'error', 'Subject not found.');
        return res.redirect(`${basePath}/subjects`);
      }
      const assignableStudentsByTutorId = Object.fromEntries(
        tutors.map((tutor) => [String(tutor.id), getAssignableStudentsForTutor(tutor, students)])
      );
      const shell = await buildShellData(req, {
        pageTitle: subject ? subject.name : 'Subject',
        section: 'subjects',
        contentView: '../content/admin-subject-detail',
        subject,
        students,
        tutors,
        archivedAssignments,
        archivedTutors,
        assignmentStudents: students,
        assignableStudentsByTutorId,
        subjectAssessments,
        modules,
        maxModuleNumber: MAX_MODULE_NUMBER,
        moduleTargetOptions: getModuleTargetOptions(),
        preResults,
        preStatus,
        warmup: getWarmupState(req.params.id),
        postAssessment,
        comparisons
      });
      res.render('shells/dashboard', shell);
    } catch (error) {
      next(error);
    }
  });

  // ==========================================================================
  // Modules & Handouts (overhaul Phase 3)
  // Admin owns modules and their handout files. Handouts are both the student's
  // study material and the source text the AI generates Pre/Post assessments
  // from, so any change to them bumps subjects.handout_version.
  // ==========================================================================
  const handoutUploader = createUploader('handouts');

  router.post('/subjects/:id/modules', async (req, res, next) => {
    const back = `${basePath}/subjects/${req.params.id}`;
    try {
      if (req.session.user.role !== 'admin') {
        setFlash(req, 'error', 'Only the main admin can add modules.');
        return res.redirect(back);
      }
      const created = await createSubjectModule({
        subject_id: Number(req.params.id),
        title: req.body.title,
        description: req.body.description,
        order_number: req.body.order_number,
        target_year_levels: normalizeArray(req.body.target_year_levels),
        uploaded_by: req.session.user.id
      });
      setFlash(req, 'success', `"${created.title}" added. Upload its handouts next.`);
      res.redirect(`${basePath}/modules/${created.id}`);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not add the module.');
      res.redirect(back);
    }
  });

  router.get('/modules/:id', async (req, res, next) => {
    try {
      const mod = await getModuleById(req.params.id);
      if (!mod) {
        setFlash(req, 'error', 'Module not found.');
        return res.redirect(`${basePath}/subjects`);
      }
      const handouts = await getModuleHandouts(mod.id);
      // The other live modules in this subject, so the settings form can say
      // which numbers are already spoken for before the admin submits.
      const siblingModules = (await getSubjectModules(mod.subject_id))
        .filter((m) => Number(m.id) !== Number(mod.id));
      const shell = await buildShellData(req, {
        pageTitle: mod.title,
        section: 'subjects',
        contentView: '../content/admin-module-detail',
        mod,
        handouts,
        siblingModules,
        maxModuleNumber: MAX_MODULE_NUMBER,
        moduleTargetOptions: getModuleTargetOptions(),
        // Pre-Assessment build status (Phase 10): the admin uploads handouts here,
        // so this is where they should see the assessment being built from them.
        preStatus: await getPreAssessmentStatus(mod.subject_id),
        warmup: getWarmupState(mod.subject_id)
      });
      res.render('shells/dashboard', shell);
    } catch (error) { next(error); }
  });

  router.post('/modules/:id/update', async (req, res, next) => {
    const back = `${basePath}/modules/${req.params.id}`;
    try {
      if (req.session.user.role !== 'admin') {
        setFlash(req, 'error', 'Only the main admin can edit modules.');
        return res.redirect(back);
      }
      const updated = await updateSubjectModule(Number(req.params.id), {
        title: req.body.title,
        description: req.body.description,
        order_number: req.body.order_number,
        target_year_levels: normalizeArray(req.body.target_year_levels)
      });
      setFlash(req, 'success', `Module updated. It is now Module ${updated.order_number}.`);
      res.redirect(back);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not update the module.');
      res.redirect(back);
    }
  });

  router.post('/modules/:id/archive', async (req, res, next) => {
    try {
      const mod = await getModuleById(req.params.id);
      if (!mod) {
        setFlash(req, 'error', 'Module not found.');
        return res.redirect(`${basePath}/subjects`);
      }
      if (req.session.user.role !== 'admin') {
        setFlash(req, 'error', 'Only the main admin can remove modules.');
        return res.redirect(`${basePath}/modules/${req.params.id}`);
      }
      await deleteModule(Number(req.params.id));
      // Its handouts no longer feed generation, so the cached assessment is stale.
      await bumpSubjectHandoutVersion(mod.subject_id);
      schedulePreAssessmentWarmup(mod.subject_id, 'module removed');
      setFlash(req, 'success', `"${mod.title}" removed.`);
      res.redirect(`${basePath}/subjects/${mod.subject_id}`);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not remove the module.');
      res.redirect(`${basePath}/subjects`);
    }
  });

  router.post('/modules/:id/handouts', handoutUploader.array('handouts', 10), async (req, res, next) => {
    const back = `${basePath}/modules/${req.params.id}`;
    try {
      const mod = await getModuleById(req.params.id);
      if (!mod) {
        setFlash(req, 'error', 'Module not found.');
        return res.redirect(`${basePath}/subjects`);
      }
      if (req.session.user.role !== 'admin') {
        setFlash(req, 'error', 'Only the main admin can upload handouts.');
        return res.redirect(back);
      }

      const files = req.files || [];
      if (!files.length) {
        // createUploader rejects disallowed types before they touch disk and
        // records why, so tell the admin which file was refused.
        setFlash(req, 'error', describeUploadRejection(req) || 'Please choose at least one handout file.');
        return res.redirect(back);
      }

      const result = await addModuleHandouts(
        mod.id,
        mod.subject_id,
        files.map((file) => ({
          file_path: `/uploads/handouts/${file.filename}`,
          file_original_name: file.originalname,
          file_type: file.mimetype,
          file_size_bytes: file.size
        })),
        req.session.user.id
      );

      // Extract text now, once, so generation never re-parses the file. This is
      // local CPU work (~200ms per PDF), so it stays inline and the admin gets
      // immediate feedback on which files can actually produce questions.
      let unusable = 0;
      for (let i = 0; i < result.ids.length; i++) {
        const file = files[i];
        // The bytes are still in hand from the upload, so this reads them
        // directly instead of fetching the object back out of storage.
        const extraction = await extractHandoutText({
          buffer: file.buffer,
          originalName: file.originalname
        });
        await saveHandoutExtraction(result.ids[i], extraction);
        if (!extraction.usable) unusable++;
      }

      // Build the Pre-Assessment now, in the background, so no student has to wait
      // on it later. Debounced, so uploading several handouts in a row costs one
      // generation rather than one per file.
      schedulePreAssessmentWarmup(mod.subject_id, 'handouts uploaded');

      const rejected = describeUploadRejection(req);
      const parts = [`${result.inserted} handout${result.inserted === 1 ? '' : 's'} uploaded.`];
      if (unusable) {
        parts.push(
          `${unusable} of them had no readable text (often a scanned PDF) and cannot be used to generate questions — see the handout cards below.`
        );
      }
      if (rejected) parts.push(rejected);
      setFlash(req, unusable || rejected ? 'info' : 'success', parts.join(' '));
      res.redirect(back);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not upload the handouts.');
      res.redirect(back);
    }
  });

  /**
   * Retry extraction for one handout. Without this, a handout whose first parse
   * failed would stay permanently unusable with no way to recover short of
   * deleting and re-uploading it.
   */
  router.post('/modules/:id/handouts/:handoutId/extract', async (req, res, next) => {
    const back = `${basePath}/modules/${req.params.id}`;
    try {
      if (req.session.user.role !== 'admin') {
        setFlash(req, 'error', 'Only the main admin can re-read handouts.');
        return res.redirect(back);
      }
      const handout = await getModuleHandoutById(Number(req.params.handoutId));
      if (!handout) {
        setFlash(req, 'error', 'Handout not found.');
        return res.redirect(back);
      }
      // allowOcr: this route is the explicit "read it properly" action, so a PDF
      // with no text layer gets its pages transcribed by the vision model rather
      // than being written off. That path costs money and takes a few seconds per
      // page, which is why it is not run automatically on upload.
      // Fetch the stored object rather than a disk path: on the remote backend
      // there is no local file. A missing object leaves buffer null, which
      // extractHandoutText already reports as "could not be found on the server".
      const stored = await getFile(handout.file_path);
      const extraction = await extractHandoutText({
        buffer: stored ? stored.buffer : null,
        originalName: handout.file_original_name || handout.file_path,
        allowOcr: true
      });
      await saveHandoutExtraction(handout.id, extraction);
      if (extraction.usable) {
        await bumpSubjectHandoutVersion(handout.subject_id);
        schedulePreAssessmentWarmup(handout.subject_id, 'handout re-read');
        const how = extraction.method === 'ocr' ? ' by reading the scanned pages with AI' : '';
        setFlash(
          req,
          'success',
          `Read ${extraction.chars.toLocaleString()} characters${how}. This handout can now be used for question generation.`
        );
      } else {
        setFlash(req, 'error', extraction.error || extraction.warning || 'Still no readable text in this file.');
      }
      res.redirect(back);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not re-read the handout.');
      res.redirect(back);
    }
  });

  router.post('/modules/:id/handouts/:handoutId/delete', async (req, res, next) => {
    const back = `${basePath}/modules/${req.params.id}`;
    try {
      if (req.session.user.role !== 'admin') {
        setFlash(req, 'error', 'Only the main admin can remove handouts.');
        return res.redirect(back);
      }
      const removed = await archiveModuleHandout(Number(req.params.handoutId));
      schedulePreAssessmentWarmup(removed.subject_id, 'handout removed');
      setFlash(req, 'success', 'Handout removed. The Pre-Assessment will regenerate from the remaining handouts.');
      res.redirect(back);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not remove the handout.');
      res.redirect(back);
    }
  });

  // ==========================================================================
  // Legacy modules — removed.
  //
  // POST /subjects/:id/resources (upload), /subjects/:id/resources/:id/archive
  // and /recover, and /subjects/:id/assessments/:id/publish served the
  // pre-overhaul "Legacy Modules" panel and its subject_resources /
  // assessments rows. That panel is gone from the subject page, and every
  // module now lives in Modules (Module 1..N with handouts), so the routes went
  // with it rather than staying reachable with nothing on screen to call them.
  // Existing rows are untouched.
  // ==========================================================================

  // Route: Student analytics per subject (admin view)
  router.get('/subjects/:id/students/:studentId/analytics', async (req, res, next) => {
    try {
      const analytics = await getStudentAnalytics(req.params.studentId, req.params.id);
      if (!analytics) {
        setFlash(req, 'error', 'Student or subject not found.');
        return res.redirect(`${basePath}/subjects/${req.params.id}`);
      }
      if (!canActOnBranch(req.session.user, analytics.student.branch_id)) {
        setFlash(req, 'error', 'You can only view students from your branch.');
        return res.redirect(`${basePath}/subjects/${req.params.id}`);
      }
      const shell = await buildShellData(req, {
        pageTitle: `Analytics: ${analytics.student.first_name} ${analytics.student.last_name}`,
        section: 'subjects',
        contentView: '../content/admin-student-analytics',
        student: analytics.student,
        analyticsList: [analytics],
        backUrl: `${basePath}/subjects/${req.params.id}`,
        backLabel: `Back to ${analytics.subject.name}`
      });
      res.render('shells/dashboard', shell);
    } catch (error) {
      next(error);
    }
  });


  // Route handler: POST request


  // Purpose: Processes this endpoint and returns the correct view or action result.


  router.post('/subjects/:id/tutors/:tutorId/archive', async (req, res, next) => {
    try {
      await archiveTutorSubject(req.params.id, req.params.tutorId);
      setFlash(req, 'success', 'Tutor archived from subject.');
      redirectBackToTab(req, res, `${basePath}/subjects`);
    } catch (error) {
      next(error);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/subjects/:id/tutors/:tutorId/recover', async (req, res, next) => {
    try {
      await recoverTutorSubject(req.params.id, req.params.tutorId);
      setFlash(req, 'success', 'Tutor recovered into subject.');
      redirectBackToTab(req, res, `${basePath}/subjects`);
    } catch (error) {
      next(error);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/subjects/:id/assign', async (req, res, next) => {
    try {
      const studentIds = Array.isArray(req.body.student_ids) ? req.body.student_ids : [req.body.student_ids];
      await assignStudentsToTutor(req.params.id, req.body.tutor_id, studentIds, req.session.user.id);
      setFlash(req, 'success', 'Students assigned to tutor successfully.');
      res.redirect(`${basePath}/subjects/${req.params.id}`);
    } catch (error) {
      next(error);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/subjects/assignments/:id/archive', async (req, res, next) => {
    try {
      await archiveAssignment(req.params.id);
      setFlash(req, 'success', 'Assignment archived.');
      redirectBackToTab(req, res, `${basePath}/subjects`);
    } catch (error) {
      next(error);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/subjects/assignments/:id/recover', async (req, res, next) => {
    try {
      await recoverAssignment(req.params.id);
      setFlash(req, 'success', 'Assignment recovered.');
      redirectBackToTab(req, res, `${basePath}/subjects`);
    } catch (error) {
      next(error);
    }
  });


  // Route handler: GET request


  // Purpose: Processes this endpoint and returns the correct view or action result.


  router.get('/assessments', async (req, res, next) => {
    try {
      const scopeBranchId = getScopeBranchId(req);
      const [assessments, assessmentHistory, students, subjects, templates] = await Promise.all([
        getAssessments(scopeBranchId),
        getAssessmentHistory(scopeBranchId),
        getUsers({ scopeBranchId, role: 'student', archived: false }),
        getSubjects(false),
        getAssessmentTemplates()
      ]);
      const templateStudentEntries = await Promise.all(
        (templates || []).map(async (template) => [String(template.id), await getStudentsMatchingAssessmentTemplate(template, scopeBranchId)])
      );
      const templateStudentMap = Object.fromEntries(templateStudentEntries);
      const shell = await buildShellData(req, {
        pageTitle: 'Assessments',
        section: 'assessments',
        contentView: '../content/admin-assessments',
        assessments,
        assessmentHistory,
        students,
        subjects,
        templates,
        templateStudentMap,
        yearLevelOptions: YEAR_LEVEL_OPTIONS,
        gradeLevelMap: GRADE_LEVEL_MAP,
        viewOnly: req.session.user.role !== 'admin',
        canCreateTemplate: role === 'admin',
        showAssessmentTemplates: true
      });
      res.render('shells/dashboard', shell);
    } catch (error) {
      next(error);
    }
  });


  // Route handler: GET request


  // Purpose: Processes this endpoint and returns the correct view or action result.


  router.get('/assessments/:id', async (req, res, next) => {
    try {
      const assessment = await getAssessmentById(req.params.id);
      if (!assessment) {
        setFlash(req, 'error', 'Assessment not found.');
        return res.redirect(`${basePath}/assessments`);
      }
      // assessments.branch_id is nullable on older rows, so fall back to the
      // branch of the student it was assigned to rather than failing the check
      // against NULL and locking the assistant out of their own branch.
      const assessmentBranchId = assessment.branch_id ?? assessment.student_branch_id;
      if (req.session.user.role === 'admin_assistant' && Number(assessmentBranchId) !== Number(req.session.user.assistant_scope_branch_id)) {
        setFlash(req, 'error', 'You can only view assessments from your branch.');
        return res.redirect(`${basePath}/assessments`);
      }
      const shell = await buildShellData(req, {
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

  router.post('/assessments/create', async (req, res, next) => {
    try {
      if (req.session.user.role !== 'admin') {
        setFlash(req, 'error', 'Assistant admin can only view assessments.');
        return res.redirect(`${basePath}/assessments`);
      }

      const targetSubjectIds = [...new Set((Array.isArray(req.body.target_subject_ids) ? req.body.target_subject_ids : [req.body.target_subject_ids]).map((value) => Number(value)).filter(Boolean))];
      const primarySubjectId = Number(req.body.subject_id || targetSubjectIds[0] || 0);
      const targetYearLevels = normalizeArray(req.body.target_year_levels || []).map((value) => String(value || '').trim()).filter(Boolean);
      const targetGradeLevels = normalizeArray(req.body.target_grade_levels || []).map((value) => String(value || '').trim()).filter(Boolean);
      const selectedAssessmentTypes = normalizeArray(req.body.type_of_assessment || []).map((value) => String(value || '').trim()).filter(Boolean);

      if (!primarySubjectId) {
        setFlash(req, 'error', 'Please choose a subject before creating the assessment template.');
        return res.redirect(`${basePath}/assessments`);
      }

      const questions = [];
      const questionTexts = Array.isArray(req.body.question_text) ? req.body.question_text : [req.body.question_text];
      const choiceA = Array.isArray(req.body.choice_a) ? req.body.choice_a : [req.body.choice_a];
      const choiceB = Array.isArray(req.body.choice_b) ? req.body.choice_b : [req.body.choice_b];
      const choiceC = Array.isArray(req.body.choice_c) ? req.body.choice_c : [req.body.choice_c];
      const choiceD = Array.isArray(req.body.choice_d) ? req.body.choice_d : [req.body.choice_d];
      const correctAnswers = Array.isArray(req.body.correct_answer) ? req.body.correct_answer : [req.body.correct_answer];
      const questionTypes = Array.isArray(req.body.question_type) ? req.body.question_type : [req.body.question_type];
      for (let i = 0; i < questionTexts.length; i += 1) {
        if (!questionTexts[i]) continue;
        questions.push({
          question_text: questionTexts[i],
          choice_a: choiceA[i] || '',
          choice_b: choiceB[i] || '',
          choice_c: choiceC[i] || '',
          choice_d: choiceD[i] || '',
          correct_answer: correctAnswers[i] || '',
          question_type: questionTypes[i] || (selectedAssessmentTypes.length === 1 ? selectedAssessmentTypes[0] : 'Multiple Choice'),
          points: 1
        });
      }

      const templateId = await createAssessmentTemplate({
        title: req.body.title || 'Assessment',
        assessment_type: 'assessment',
        subject_id: primarySubjectId,
        target_subject_ids: targetSubjectIds.length ? targetSubjectIds : [primarySubjectId],
        target_year_levels: targetYearLevels,
        target_grade_levels: targetGradeLevels,
        type_of_assessment: selectedAssessmentTypes.length ? selectedAssessmentTypes : ['Multiple Choice'],
        created_by: req.session.user.id,
        questions
      });

      const template = await getAssessmentTemplateById(templateId);
      const matchedStudents = await getStudentsMatchingAssessmentTemplate(template);
      const matchedStudentIds = matchedStudents.map((student) => Number(student.student_id || student.id)).filter(Boolean);

      if (matchedStudentIds.length) {
        await assignAssessmentTemplateToStudents(templateId, null, matchedStudentIds, null);
      }

      const sentSummary = matchedStudentIds.length
        ? ` and sent to ${matchedStudentIds.length} matching student${matchedStudentIds.length > 1 ? 's' : ''}`
        : '. No matching students were found yet.';
      setFlash(req, 'success', `Assessment template created successfully${sentSummary}`);
      res.redirect(`${basePath}/assessments`);
    } catch (error) {
      next(error);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/assessments/templates/:templateId/assign', async (req, res, next) => {
    try {
      const template = await getAssessmentTemplateById(req.params.templateId);
      if (!template) {
        setFlash(req, 'error', 'Assessment template not found.');
        return res.redirect(`${basePath}/assessments`);
      }

      const scopeBranchId = getScopeBranchId(req);
      const allowedStudents = await getStudentsMatchingAssessmentTemplate(template, scopeBranchId);
      const allowedStudentIds = new Set(allowedStudents.map((student) => Number(student.student_id || student.id)).filter(Boolean));
      const submittedIds = normalizeArray(req.body.assigned_student_ids || []).map((value) => Number(value)).filter(Boolean);
      const assignedStudentIds = [...new Set(submittedIds.filter((id) => allowedStudentIds.has(id)))];

      if (!assignedStudentIds.length) {
        setFlash(req, 'error', 'Please select at least one matching student.');
        return res.redirect(`${basePath}/assessments`);
      }

      const firstStudent = allowedStudents.find((student) => Number(student.student_id || student.id) === assignedStudentIds[0]);
      await assignAssessmentTemplateToStudents(req.params.templateId, null, assignedStudentIds, firstStudent?.branch_id || scopeBranchId || null);
      setFlash(req, 'success', 'Assessment sent to the selected students successfully.');
      res.redirect(`${basePath}/assessments`);
    } catch (error) {
      next(error);
    }
  });



  // Route handler: POST request



  // Purpose: Processes this endpoint and returns the correct view or action result.



  router.post('/assessments/:id/done', async (req, res, next) => {
    try {
      const assessment = await getAssessmentById(req.params.id);
      if (!assessment || !assessment.result) {
        setFlash(req, 'error', 'Only completed assessments can be marked done.');
        return res.redirect(`${basePath}/assessments`);
      }
      await markAssessmentDone(req.params.id);
      setFlash(req, 'success', 'Assessment moved to history.');
      res.redirect(`${basePath}/assessments?history=1`);
    } catch (error) { next(error); }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/assessments/:id/recover', async (req, res, next) => {
    try {
      await recoverAssessment(req.params.id);
      setFlash(req, 'success', 'Assessment recovered.');
      res.redirect(`${basePath}/assessments`);
    } catch (error) { next(error); }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/assessments/:id/delete', async (req, res, next) => {
    try {
      await deleteAssessmentPermanently(req.params.id);
      setFlash(req, 'success', 'Assessment deleted permanently.');
      res.redirect(`${basePath}/assessments`);
    } catch (error) { next(error); }
  });


  /**
   * Analytics & Reports.
   *
   * The scope is decided inside getAnalyticsDashboard from the session user, not
   * from anything in the request: an assistant who appends ?branch_id=3 still
   * gets their own branch, because resolveScope only honours that parameter for
   * an admin. That is the "enforced at the query level, not hidden in the UI"
   * requirement — the rows for other branches are never fetched.
   */
  router.get('/analytics', async (req, res, next) => {
    try {
      // The filter bar (search, subject, assessment, dates, branch) is gone:
      // the page reports the whole scope, and each table has its own search
      // icon and scrolls after ten rows.
      const filters = { search: '', subjectId: 'all', kind: 'all', from: '', to: '', branchId: 'all' };

      const data = await getAnalyticsDashboard(req.session.user, filters);
      const focus = await getFocusHandouts(data.scope, {}).catch(() => []);

      const shell = await buildShellData(req, {
        pageTitle: 'Analytics & Reports',
        section: 'analytics',
        contentView: '../content/analytics-dashboard',
        analytics: data,
        focusHandouts: focus,
        filters,
        query: req.query,
        viewerRole: req.session.user.role
      });
      res.render('shells/dashboard', shell);
    } catch (error) {
      next(error);
    }
  });

  /** One student's auto-generated focus material, opened from Analytics. */
  router.get('/focus-handouts/:id', async (req, res, next) => {
    try {
      const handout = await getFocusHandoutById(Number(req.params.id));
      if (!handout) {
        setFlash(req, 'error', 'Focus handout not found.');
        return res.redirect(`${basePath}/analytics`);
      }
      if (!canActOnBranch(req.session.user, handout.branch_id) && req.session.user.role !== 'admin') {
        setFlash(req, 'error', 'That record belongs to another branch.');
        return res.redirect(`${basePath}/analytics`);
      }
      const shell = await buildShellData(req, {
        pageTitle: handout.title,
        section: 'analytics',
        contentView: '../content/focus-handout-detail',
        handout,
        viewerRole: req.session.user.role,
        backUrl: `${basePath}/analytics`
      });
      res.render('shells/dashboard', shell);
    } catch (error) {
      next(error);
    }
  });

  // One learner's Analytics & Reports, opened from the Learner performance
  // table: a score chart and history for EVERY subject they are enrolled in.
  // It used to show only their first subject.
  router.get('/students/:studentId/analytics', async (req, res, next) => {
    try {
      const student = await getUserById(req.params.studentId);
      if (!student || student.role !== 'student') {
        setFlash(req, 'error', 'Student not found.');
        return res.redirect(`${basePath}/analytics`);
      }
      if (!canActOnBranch(req.session.user, student.branch_id)) {
        setFlash(req, 'error', 'You can only view students from your branch.');
        return res.redirect(`${basePath}/analytics`);
      }

      const studentAssignments = await getStudentAssignments(student.id);
      const analyticsList = (await Promise.all(
        studentAssignments.map((assignment) => getStudentAnalytics(student.id, assignment.subject_id))
      )).filter(Boolean);

      const shell = await buildShellData(req, {
        pageTitle: `Analytics: ${student.first_name} ${student.last_name}`,
        section: 'analytics',
        contentView: '../content/admin-student-analytics',
        student,
        analyticsList,
        backUrl: `${basePath}/analytics`,
        backLabel: 'Back to Analytics & Reports'
      });
      res.render('shells/dashboard', shell);
    } catch (error) {
      next(error);
    }
  });

  // Admin-only: Database cleanup for old assessment/module records
  router.post('/cleanup-records', async (req, res, next) => {
    try {
      if (req.session.user.role !== 'admin') {
        setFlash(req, 'error', 'Only the main admin can perform database cleanup.');
        return res.redirect(`${basePath}`);
      }

      const { query: dbQuery } = require('../config/db');
      const fs = require('fs');
      const path = require('path');

      // Delete in order respecting foreign keys
      await dbQuery('DELETE FROM assessment_results');
      await dbQuery('DELETE FROM ai_generation_logs');
      await dbQuery('DELETE FROM student_learning_cycles');
      await dbQuery('DELETE FROM module_reads');
      await dbQuery('DELETE FROM assessment_requests');
      await dbQuery('DELETE FROM assessments');

      // Get AI-generated file paths before deleting records
      const aiModules = await dbQuery("SELECT file_path FROM subject_resources WHERE module_origin = 'ai_generated' AND file_path IS NOT NULL");
      await dbQuery("DELETE FROM subject_resources WHERE module_origin = 'ai_generated'");

      // Delete AI-generated files from storage
      let filesDeleted = 0;
      for (const mod of aiModules) {
        if (mod.file_path) {
          try {
            // deleteFile is a no-op for an object that is already gone, so the
            // count reflects rows processed, not disk hits.
            await deleteFile(mod.file_path);
            filesDeleted++;
          } catch (e) {
            console.error('[Cleanup] Failed to delete file:', mod.file_path, e.message);
          }
        }
      }

      console.log(`[Admin Cleanup] Records cleaned. ${filesDeleted} AI files removed from storage.`);
      setFlash(req, 'success', `Database cleanup complete! All old assessments, AI modules, and learning records have been removed. ${filesDeleted} generated files deleted from storage.`);
      res.redirect(`${basePath}`);
    } catch (error) {
      next(error);
    }
  });

  // ==========================================================================
  // Module Management was removed in the Module/Assessment overhaul (Phase 1).
  // Modules are now created and managed inside a subject: All Subjects ->
  // <subject> -> Modules -> Handouts. See MODULE_OVERHAUL_PLAN.md, Phase 3.
  // ==========================================================================

  // ==========================================================================
  // Phase 7: Assessment Monitoring & Student Results
  // ==========================================================================
  // Assessment Monitoring and Student Results used to be two sidebar entries.
  // They answer one question in two halves — what was set, and how it went — and
  // read as the same page to anyone using the system, so they are now one page
  // with a section each.
  router.get('/assessment-monitoring', async (req, res, next) => {
    try {
      const [assessments, results] = await Promise.all([
        getAllTutorAssessmentsAdmin(),
        getStudentResultsAdmin()
      ]);
      const shell = await buildShellData(req, {
        pageTitle: 'Assessment Monitoring',
        section: 'assessment_monitoring',
        contentView: '../content/admin-assessment-monitoring',
        assessments,
        results
      });
      res.render('shells/dashboard', shell);
    } catch (error) { next(error); }
  });

  // Result breakdown with weak areas (overhaul Phase 6, acceptance item 8).
  // Admin and Admin Assistant both read results; neither can alter them.
  router.get('/results/:submissionId', async (req, res, next) => {
    try {
      const submission = await getSubmissionWithAnswers(Number(req.params.submissionId));
      if (!submission) {
        setFlash(req, 'error', 'Result not found.');
        return res.redirect(`${basePath}/assessment-monitoring`);
      }
      const weakAreas = await getWeakAreasForSubmission(submission.id);
      const shell = await buildShellData(req, {
        pageTitle: `${submission.first_name} ${submission.last_name || ''} - ${submission.title}`,
        section: 'assessment_monitoring',
        contentView: '../content/student-assessment-breakdown',
        submission,
        weakAreas,
        viewerRole: 'admin'
      });
      res.render('shells/dashboard', shell);
    } catch (error) { next(error); }
  });

  // Kept as a working URL. The results now live in a section of Assessment
  // Monitoring, and a bookmark or an old link should land there rather than 404.
  router.get('/student-results', (req, res) => {
    res.redirect(`${basePath}/assessment-monitoring`);
  });

  return router;
}

module.exports = createAdminRouter;
