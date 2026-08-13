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
const { createUploader } = require('../lib/uploads');
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
  // Phase 3: Analytics imports
  getAllStudentsForAnalytics,
  // Phase 4: Admin pre/post assessments
  createSubjectAssessment,
  getSubjectAssessments,
  // Phase 5: Module Management
  upsertModule,
  deleteModule,
  getAllModulesAdmin,
  getAllTutorAssessmentsAdmin,
  getStudentResultsAdmin
} = require('../lib/data');
const { normalizeArray } = require('../lib/utils');
const { query } = require('../config/db');

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
    const [branches, inboxNotifications] = await Promise.all([
      getBranches(),
      getAdminInboxNotifications(scopeBranchId)
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
      notificationCount: inboxNotifications.length,
      inboxNotifications,
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
      setFlash(req, 'error', error.message || 'Could not add subject.');
      res.redirect(`${basePath}/subjects`);
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

  router.post('/notifications/:id/read', async (req, res, next) => {
    try {
      await markNotificationRead(req.params.id, req.session.user.role === 'admin_assistant' ? req.session.user.assistant_scope_branch_id : null);
      setFlash(req, 'success', 'Notification marked as read.');
      res.redirect(basePath);
    } catch (error) {
      next(error);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/notifications/:id/archive', async (req, res, next) => {
    try {
      await archiveNotification(req.params.id, req.session.user.role === 'admin_assistant' ? req.session.user.assistant_scope_branch_id : null);
      setFlash(req, 'success', 'Notification archived successfully.');
      res.redirect(basePath);
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
      res.redirect(basePath);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not accept submission.');
      res.redirect(basePath);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/subject-requests/:id/accept', async (req, res, next) => {
    try {
      await acceptSubjectEnrollmentRequest(req.params.id, req.session.user);
      setFlash(req, 'success', 'Subject enrollment request accepted successfully.');
      res.redirect(basePath);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not accept enrollment request.');
      res.redirect(basePath);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/subject-requests/:id/cancel', async (req, res, next) => {
    try {
      await cancelSubjectEnrollmentRequest(req.params.id, req.session.user);
      setFlash(req, 'success', 'Subject enrollment request cancelled successfully.');
      res.redirect(basePath);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not cancel enrollment request.');
      res.redirect(basePath);
    }
  });

  // Route handler: GET request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.get('/users', async (req, res, next) => {
    try {
      const scopeBranchId = getScopeBranchId(req);
      const selectedRole = req.query.role || 'all';
      const search = req.query.search || '';
      const [users, archivedUsers, assistantAccounts, archivedAssistantAccounts, availableAssistantBranches] = await Promise.all([
        getUsers({ scopeBranchId, role: selectedRole, archived: false, search }),
        getUsers({ scopeBranchId, role: selectedRole, archived: true, search }),
        req.session.user.role === 'admin' ? getAssistantAccounts(null, false) : Promise.resolve([]),
        req.session.user.role === 'admin' ? getAssistantAccounts(null, true) : Promise.resolve([]),
        req.session.user.role === 'admin' ? getAvailableAssistantBranches() : Promise.resolve([])
      ]);
      const shell = await buildShellData(req, {
        pageTitle: 'User Management',
        section: 'users',
        contentView: '../content/admin-users',
        users,
        archivedUsers,
        assistantAccounts,
        archivedAssistantAccounts,
        availableAssistantBranches,
        selectedRole,
        search
      });
      res.render('shells/dashboard', shell);
    } catch (error) {
      next(error);
    }
  });

  // Route handler: GET request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.get('/profile/:id', async (req, res, next) => {
    try {
      const user = await getUserById(req.params.id);
      if (!user) {
        setFlash(req, 'error', 'User not found.');
        return res.redirect(`${basePath}/users`);
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
      const shell = await buildShellData(req, {
        pageTitle: isOwnAdminProfile ? 'Admin Profile' : `${user.role === 'student' ? 'Student' : 'Tutor'} Profile`,
        section: isOwnAdminProfile ? 'profile' : 'users',
        contentView: '../content/admin-profile',
        profileUser: user,
        studentAssignments,
        tutorAssignments,
        subjectOptions,
        supportOptions: ['Exam Preparation & Reviews','Homework Assistance','Project Guidance']
      });
      res.render('shells/dashboard', shell);
    } catch (error) {
      next(error);
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
      setFlash(req, 'success', 'Profile updated successfully.');
      res.redirect(`${basePath}/profile/${req.params.id}`);
    } catch (error) {
      next(error);
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

  router.post('/assistant-accounts/:id/update', async (req, res, next) => {
    try {
      await updateAssistantAccount(req.params.id, req.body);
      setFlash(req, 'success', 'Assistant account updated.');
      res.redirect(`${basePath}/users`);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not update assistant account.');
      res.redirect(`${basePath}/users`);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/assistant-accounts/:id/archive', async (req, res, next) => {
    try {
      await archiveUser(req.params.id);
      setFlash(req, 'success', 'Assistant account archived successfully.');
      res.redirect(`${basePath}/users`);
    } catch (error) { next(error); }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/assistant-accounts/:id/recover', async (req, res, next) => {
    try {
      await recoverUser(req.params.id);
      setFlash(req, 'success', 'Assistant account recovered successfully.');
      res.redirect(`${basePath}/users`);
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

  router.get('/billing', async (req, res, next) => {
    try {
      const scopeBranchId = getScopeBranchId(req);
      const [billingRows, paymentHistory] = await Promise.all([
        getBillingRows(scopeBranchId, false),
        getPaymentHistory(scopeBranchId)
      ]);
      const billingStudentIds = new Set(billingRows.map((row) => String(row.student_id)));
      const openEditStudentId = billingStudentIds.has(String(req.query.edit || '')) ? String(req.query.edit) : '';
      const openInfoStudentId = billingStudentIds.has(String(req.query.info || '')) ? String(req.query.info) : '';
      const shell = await buildShellData(req, {
        pageTitle: 'Student Billing',
        section: 'billing',
        contentView: '../content/admin-billing',
        billingRows,
        paymentHistory,
        openEditStudentId,
        openInfoStudentId
      });
      res.render('shells/dashboard', shell);
    } catch (error) {
      next(error);
    }
  });

  // Income Report route
  router.get('/income-report', async (req, res, next) => {
    try {
      const scopeBranchId = getScopeBranchId(req);
      const [billingRows, paidBills, paymentHistoryData, branches] = await Promise.all([
        getBillingRows(scopeBranchId, false),
        getBillingRows(scopeBranchId, true),
        getPaymentHistory(scopeBranchId),
        getBranches()
      ]);
      const allBillingRows = [...billingRows, ...paidBills];
      const shell = await buildShellData(req, {
        pageTitle: 'Income Report',
        section: 'income',
        contentView: '../content/admin-income-report',
        billingRows: allBillingRows,
        paymentHistory: paymentHistoryData,
        branches: req.session.user.role === 'admin' ? branches : [],
        selectedBranch: req.query.branch_id || 'all'
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
      const { subject, students, tutors } = await getSubjectMembers(req.params.id, scopeBranchId);
      const [archivedAssignments, archivedTutors, adminResources] = await Promise.all([
        getSubjectArchivedAssignments(req.params.id),
        getSubjectArchivedTutors(req.params.id, scopeBranchId),
        getAdminSubjectResourcesWithArchived(req.params.id)
      ]);
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
        adminResources,
        subjectAssessments: await getSubjectAssessments(req.params.id)
      });
      res.render('shells/dashboard', shell);
    } catch (error) {
      next(error);
    }
  });

  // Route handler: POST request

  // Purpose: Processes this endpoint and returns the correct view or action result.

  router.post('/subjects/:id/resources', resourceUploader.single('attachment'), async (req, res, next) => {
    try {
      if (req.session.user.role !== 'admin') {
        setFlash(req, 'error', 'Only the main admin can upload modules.');
        return res.redirect(`${basePath}/subjects/${req.params.id}`);
      }

      let contentText = '';
      if (req.file) {
        const fs = require('fs');
        const absolutePath = require('path').join(__dirname, '..', 'public', 'uploads', 'resources', req.file.filename);
        
        try {
          if (req.file.mimetype === 'application/pdf') {
            const pdfParse = require('pdf-parse');
            const dataBuffer = fs.readFileSync(absolutePath);
            const data = await pdfParse(dataBuffer);
            contentText = data.text;
          } else if (req.file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            const mammoth = require('mammoth');
            const result = await mammoth.extractRawText({ path: absolutePath });
            contentText = result.value;
          } else if (req.file.mimetype === 'text/plain') {
            contentText = fs.readFileSync(absolutePath, 'utf8');
          }
        } catch (parseError) {
          console.error('[AI File Parser] Error extracting text:', parseError);
          // Non-fatal error, we still save the file
        }
      }

      await addSubjectResource(req.session.user.id, req.params.id, req.body.title, req.body.description, req.file ? {
        path: `/uploads/resources/${req.file.filename}`,
        mimetype: req.file.mimetype
      } : null, {
        created_by_role: 'admin_template',
        type_of_module: req.body.type_of_module || null,
        content_text: contentText.substring(0, 50000) // limit to 50k chars
      });
      setFlash(req, 'success', 'Module uploaded successfully.');
      res.redirect(`${basePath}/subjects/${req.params.id}`);
    } catch (error) {
      next(error);
    }
  });

  // Route: Create pre/post assessment for a subject
  router.post('/subjects/:id/assessments/create', async (req, res, next) => {
    try {
      if (req.session.user.role !== 'admin') {
        setFlash(req, 'error', 'Only the main admin can create assessments.');
        return res.redirect(`${basePath}/subjects/${req.params.id}`);
      }

      const questions = [];
      const questionTexts = Array.isArray(req.body.question_text) ? req.body.question_text : [req.body.question_text];
      const questionTypes = Array.isArray(req.body.question_type) ? req.body.question_type : [req.body.question_type];
      const sourceModuleTitles = Array.isArray(req.body.q_source_module_title) ? req.body.q_source_module_title : [req.body.q_source_module_title];
      const choiceA = Array.isArray(req.body.choice_a) ? req.body.choice_a : [req.body.choice_a];
      const choiceB = Array.isArray(req.body.choice_b) ? req.body.choice_b : [req.body.choice_b];
      const choiceC = Array.isArray(req.body.choice_c) ? req.body.choice_c : [req.body.choice_c];
      const choiceD = Array.isArray(req.body.choice_d) ? req.body.choice_d : [req.body.choice_d];
      const correctAnswers = Array.isArray(req.body.correct_answer) ? req.body.correct_answer : [req.body.correct_answer];
      const essayKeywords = Array.isArray(req.body.essay_rubric_keywords) ? req.body.essay_rubric_keywords : [req.body.essay_rubric_keywords];

      for (let i = 0; i < questionTexts.length; i++) {
        if (!questionTexts[i]) continue;
        questions.push({
          question_text: questionTexts[i],
          question_type: questionTypes[i] || 'Multiple Choice',
          source_module_title: sourceModuleTitles[i] || null,
          choice_a: choiceA[i] || '',
          choice_b: choiceB[i] || '',
          choice_c: choiceC[i] || '',
          choice_d: choiceD[i] || '',
          correct_answer: correctAnswers[i] || '',
          essay_rubric_keywords: essayKeywords[i] || null,
          points: 1
        });
      }

      await createSubjectAssessment(req.params.id, req.session.user.id, {
        assessment_type: req.body.assessment_type || 'pre',
        source_module_title: null, // Module is now assigned per-question
        questions
      });

      setFlash(req, 'success', `${req.body.assessment_type === 'post' ? 'Post' : 'Pre'}-Assessment created successfully.`);
      res.redirect(`${basePath}/subjects/${req.params.id}`);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not create assessment.');
      res.redirect(`${basePath}/subjects/${req.params.id}`);
    }
  });

  // Route: Publish a post assessment
  router.post('/subjects/:id/assessments/:assessmentId/publish', async (req, res, next) => {
    try {
      if (req.session.user.role !== 'admin') {
        setFlash(req, 'error', 'Only the main admin can publish assessments.');
        return res.redirect(`${basePath}/subjects/${req.params.id}`);
      }
      await query('UPDATE assessments SET is_published = 1 WHERE id = ? AND subject_id = ?', [req.params.assessmentId, req.params.id]);
      setFlash(req, 'success', 'Post-Assessment published! Students can now take it.');
      res.redirect(`${basePath}/subjects/${req.params.id}`);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not publish assessment.');
      res.redirect(`${basePath}/subjects/${req.params.id}`);
    }
  });

  // Route: Copy a pre-assessment as a post-assessment
  router.post('/subjects/:id/assessments/:assessmentId/copy-as-post', async (req, res, next) => {
    try {
      if (req.session.user.role !== 'admin') {
        setFlash(req, 'error', 'Only the main admin can copy assessments.');
        return res.redirect(`${basePath}/subjects/${req.params.id}`);
      }

      const { getAssessmentById, createSubjectAssessment } = require('../../lib/data');
      const original = await getAssessmentById(req.params.assessmentId);
      if (!original || original.assessment_type !== 'pre' || Number(original.subject_id) !== Number(req.params.id)) {
        setFlash(req, 'error', 'Invalid assessment to copy.');
        return res.redirect(`${basePath}/subjects/${req.params.id}`);
      }

      await createSubjectAssessment(req.params.id, req.session.user.id, {
        assessment_type: 'post',
        source_module_title: original.source_module_title,
        questions: original.questions
      });

      setFlash(req, 'success', 'Pre-Assessment copied and published as Post-Assessment successfully!');
      res.redirect(`${basePath}/subjects/${req.params.id}`);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not copy assessment.');
      res.redirect(`${basePath}/subjects/${req.params.id}`);
    }
  });

  // Route: Archive a module
  router.post('/subjects/:id/resources/:resourceId/archive', async (req, res, next) => {
    try {
      if (req.session.user.role !== 'admin') {
        setFlash(req, 'error', 'Only the main admin can archive modules.');
        return res.redirect(`${basePath}/subjects/${req.params.id}`);
      }
      await archiveSubjectResource(req.params.resourceId);
      setFlash(req, 'success', 'Module archived.');
      res.redirect(`${basePath}/subjects/${req.params.id}`);
    } catch (error) {
      next(error);
    }
  });

  // Route: Recover an archived module
  router.post('/subjects/:id/resources/:resourceId/recover', async (req, res, next) => {
    try {
      if (req.session.user.role !== 'admin') {
        setFlash(req, 'error', 'Only the main admin can recover modules.');
        return res.redirect(`${basePath}/subjects/${req.params.id}`);
      }
      await recoverSubjectResource(req.params.resourceId);
      setFlash(req, 'success', 'Module recovered.');
      res.redirect(`${basePath}/subjects/${req.params.id}`);
    } catch (error) {
      next(error);
    }
  });

  // Route: Student analytics per subject (admin view)
  router.get('/subjects/:id/students/:studentId/analytics', async (req, res, next) => {
    try {
      const analytics = await getStudentAnalytics(req.params.studentId, req.params.id);
      if (!analytics) {
        setFlash(req, 'error', 'Student or subject not found.');
        return res.redirect(`${basePath}/subjects/${req.params.id}`);
      }
      const shell = await buildShellData(req, {
        pageTitle: `Analytics: ${analytics.student.first_name} ${analytics.student.last_name}`,
        section: 'subjects',
        contentView: '../content/admin-student-analytics',
        analytics
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
      res.redirect('back');
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
      res.redirect('back');
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
      res.redirect('back');
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
      res.redirect('back');
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
      if (req.session.user.role === 'admin_assistant' && Number(assessment.branch_id) !== Number(req.session.user.assistant_scope_branch_id)) {
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


  // Analytics & Reports page
  router.get('/analytics', async (req, res, next) => {
    try {
      const search = String(req.query.search || '').trim();
      const scopeBranchId = role === 'admin_assistant' ? req.session.user.assistant_scope_branch_id : null;
      const students = await getAllStudentsForAnalytics(scopeBranchId, search);

      const totalStudents = students.length;
      const inProgress = students.filter((s) => s.progress_status === 'In Progress').length;
      const advanced = students.filter((s) => s.progress_status === 'Advanced').length;
      const notStarted = students.filter((s) => s.progress_status === 'Not Started').length;

      const shell = await buildShellData(req, {
        pageTitle: 'Analytics & Reports',
        section: 'analytics',
        contentView: '../content/admin-analytics',
        students,
        search,
        summary: { totalStudents, inProgress, advanced, notStarted }
      });
      res.render('shells/dashboard', shell);
    } catch (error) {
      next(error);
    }
  });

  // Student analytics detail page (from Analytics & Reports page)
  router.get('/students/:studentId/analytics', async (req, res, next) => {
    try {
      const studentAssignments = await getStudentAssignments(req.params.studentId);
      if (!studentAssignments.length) {
        setFlash(req, 'error', 'No analytics data found for this student.');
        return res.redirect(`${basePath}/analytics`);
      }

      // Get analytics for the first subject (primary view)
      const primaryAnalytics = await getStudentAnalytics(req.params.studentId, studentAssignments[0].subject_id);
      if (!primaryAnalytics) {
        setFlash(req, 'error', 'Student or subject not found.');
        return res.redirect(`${basePath}/analytics`);
      }

      const shell = await buildShellData(req, {
        pageTitle: `Analytics: ${primaryAnalytics.student.first_name} ${primaryAnalytics.student.last_name}`,
        section: 'analytics',
        contentView: '../content/admin-student-analytics',
        analytics: primaryAnalytics
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
          const filePath = path.join(__dirname, '..', 'public', mod.file_path.replace(/\\/g, '/'));
          try {
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
              filesDeleted++;
            }
          } catch (e) {
            console.error('[Cleanup] Failed to delete file:', filePath, e.message);
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
  // Phase 5: Module Management
  // ==========================================================================
  const moduleUploader = createUploader('modules');

  router.get('/modules', async (req, res, next) => {
    try {
      const [modules, subjects] = await Promise.all([
        getAllModulesAdmin(),
        getSubjects(false)
      ]);
      // Group modules by subject
      const subjectMap = {};
      for (const m of modules) {
        if (!subjectMap[m.subject_id]) subjectMap[m.subject_id] = { name: m.subject_name, modules: [] };
        subjectMap[m.subject_id].modules.push(m);
      }
      const shell = await buildShellData(req, {
        pageTitle: 'Module Management',
        section: 'modules',
        contentView: '../content/admin-modules',
        modules,
        subjects,
        subjectMap
      });
      res.render('shells/dashboard', shell);
    } catch (error) { next(error); }
  });

  router.post('/modules', moduleUploader.single('file'), async (req, res, next) => {
    try {
      const { subject_id, level, title, description } = req.body;
      if (!subject_id || !level || !title) {
        setFlash(req, 'error', 'Subject, Level, and Title are required.');
        return res.redirect(`${basePath}/modules`);
      }
      // Validate file type
      if (req.file) {
        const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
        const allowed = ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'txt'];
        if (!allowed.includes(ext)) {
          setFlash(req, 'error', 'Invalid file type. Allowed: PDF, DOC, DOCX, PPT, PPTX, XLS, XLSX, TXT.');
          return res.redirect(`${basePath}/modules`);
        }
      }
      await upsertModule({
        subject_id: Number(subject_id),
        level: String(level),
        title: String(title).trim(),
        description: String(description || '').trim(),
        file_path: req.file ? `/uploads/modules/${req.file.filename}` : null,
        file_original_name: req.file ? req.file.originalname : null,
        file_type: req.file ? req.file.mimetype : null,
        uploaded_by: req.session.user.id
      });
      setFlash(req, 'success', `Module "${title}" (${level}) uploaded successfully.`);
      res.redirect(`${basePath}/modules`);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not upload module.');
      res.redirect(`${basePath}/modules`);
    }
  });

  router.post('/modules/:id/delete', async (req, res, next) => {
    try {
      await deleteModule(Number(req.params.id));
      setFlash(req, 'success', 'Module removed successfully.');
      res.redirect(`${basePath}/modules`);
    } catch (error) {
      setFlash(req, 'error', error.message || 'Could not delete module.');
      res.redirect(`${basePath}/modules`);
    }
  });

  // ==========================================================================
  // Phase 7: Assessment Monitoring & Student Results
  // ==========================================================================
  router.get('/assessment-monitoring', async (req, res, next) => {
    try {
      const assessments = await getAllTutorAssessmentsAdmin();
      const shell = await buildShellData(req, {
        pageTitle: 'Assessment Monitoring',
        section: 'assessment_monitoring',
        contentView: '../content/admin-assessment-monitoring',
        assessments
      });
      res.render('shells/dashboard', shell);
    } catch (error) { next(error); }
  });

  router.get('/student-results', async (req, res, next) => {
    try {
      const results = await getStudentResultsAdmin();
      const shell = await buildShellData(req, {
        pageTitle: 'Student Results',
        section: 'student_results',
        contentView: '../content/admin-student-results',
        results
      });
      res.render('shells/dashboard', shell);
    } catch (error) { next(error); }
  });

  return router;
}

module.exports = createAdminRouter;
