/**
 * File: lib/appNotifications.js
 * Purpose: In-app notifications that are not registration submissions.
 *
 * The original `notifications` table has `submission_id INT NOT NULL` with a
 * foreign key to registration submissions, so it can only ever carry "a learner
 * signed up". A cash payment request, a weak-topic handout or an assessment flag
 * has no submission behind it, hence this second, general table.
 *
 * Addressing model
 * ----------------
 * A notification names a ROLE plus an optional branch, or a single user:
 *
 *   recipient_role = 'admin'            -> every admin, all branches
 *   recipient_role = 'admin_assistant'  -> assistants whose branch matches
 *   recipient_user_id = 42              -> exactly that person
 *
 * That is what makes "either Admin or Assistant Admin, whoever sees it first can
 * process it" work: one notification row is addressed to the role, so both see it
 * and either can act. `is_read` is therefore a property of the notification, not
 * of each viewer — reading it marks who read it, which is the traceability the
 * brief asks for.
 */

const { query } = require('../config/db');

/**
 * Write one notification.
 *
 * @param {object} input
 * @param {string} input.type          machine name, e.g. 'payment_request'
 * @param {string} input.title
 * @param {string} [input.message]
 * @param {string} [input.linkUrl]     where "View" should go for staff
 * @param {string} [input.refType]     'payment_request' | 'focus_handout' | ...
 * @param {number} [input.refId]
 * @param {string} [input.role]        recipient role
 * @param {number} [input.userId]      recipient user (overrides role)
 * @param {number} [input.branchId]    narrows a role recipient to one branch
 * @param {string} [input.severity]    'info' | 'success' | 'warning' | 'danger'
 */
async function createNotification(input = {}) {
  const {
    type, title, message = null, linkUrl = null, refType = null, refId = null,
    role = null, userId = null, branchId = null, severity = 'info'
  } = input;

  if (!type || !title) throw new Error('A notification needs a type and a title.');

  const result = await query(
    `INSERT INTO app_notifications
       (notification_type, title, message, link_url, ref_type, ref_id,
        recipient_role, recipient_user_id, branch_id, severity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(type).slice(0, 50),
      String(title).slice(0, 200),
      message ? String(message) : null,
      linkUrl ? String(linkUrl).slice(0, 300) : null,
      refType ? String(refType).slice(0, 50) : null,
      refId || null,
      role ? String(role).slice(0, 30) : null,
      userId || null,
      branchId || null,
      severity
    ]
  );
  return result.insertId;
}

/**
 * Notify both admin roles about the same event.
 *
 * Two rows, not one: an assistant is scoped to a branch and an admin is not, so a
 * single row would either leak other branches to the assistant or hide the event
 * from admins of a different branch. Both rows point at the same ref_id, and the
 * handler acts on the referenced record, so acting on either one settles it.
 */
async function notifyAdminRoles(input = {}) {
  // The two roles are mounted under different base paths, so a single link would
  // 404 for one of them. `linkPath` is given relative to the role's base and
  // resolved per row; `linkUrl` is still honoured when a caller wants one exact
  // destination for both.
  const linkFor = (base) => (input.linkPath ? `${base}${input.linkPath}` : (input.linkUrl || null));

  const ids = await Promise.all([
    createNotification({ ...input, role: 'admin', branchId: null, linkUrl: linkFor('/admin') }),
    createNotification({
      ...input,
      role: 'admin_assistant',
      branchId: input.branchId || null,
      linkUrl: linkFor('/assistant')
    })
  ]);
  return ids;
}

/**
 * The notifications this viewer may see.
 *
 * @param {object} user     req.session.user
 * @param {object} [filters] { search, unreadOnly, type, includeArchived }
 */
async function getNotificationsFor(user, filters = {}) {
  const role = String(user?.role || '');
  const params = [];
  const clauses = [];

  if (role === 'admin') {
    clauses.push('(an.recipient_role = ? OR an.recipient_user_id = ?)');
    params.push('admin', user.id);
  } else if (role === 'admin_assistant') {
    // Branch-scoped, and a role notification with no branch is head-office only.
    clauses.push('((an.recipient_role = ? AND an.branch_id = ?) OR an.recipient_user_id = ?)');
    params.push('admin_assistant', Number(user.assistant_scope_branch_id) || -1, user.id);
  } else {
    clauses.push('(an.recipient_user_id = ?)');
    params.push(user.id);
  }

  if (!filters.includeArchived) clauses.push('an.is_archived = 0');
  if (filters.unreadOnly) clauses.push('an.is_read = 0');
  if (filters.type) {
    clauses.push('an.notification_type = ?');
    params.push(filters.type);
  }

  const search = String(filters.search || '').trim().toLowerCase();
  if (search) {
    clauses.push("(LOWER(an.title) LIKE ? OR LOWER(COALESCE(an.message, '')) LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }

  return query(
    `SELECT an.*, br.name AS branch_name,
            r.first_name AS reader_first_name, r.last_name AS reader_last_name
     FROM app_notifications an
     LEFT JOIN branches br ON br.id = an.branch_id
     LEFT JOIN users r ON r.id = an.read_by
     WHERE ${clauses.join(' AND ')}
     ORDER BY an.is_read ASC, an.created_at DESC`,
    params
  );
}

/** Unread count for the topbar bell. */
async function countUnreadFor(user) {
  const rows = await getNotificationsFor(user, { unreadOnly: true });
  return rows.length;
}

/** Mark one read, recording who read it. Idempotent. */
async function markRead(id, user) {
  await query(
    `UPDATE app_notifications
        SET is_read = 1, read_at = DATEADD(hour, 8, GETUTCDATE()), read_by = ?,
            updated_at = DATEADD(hour, 8, GETUTCDATE())
      WHERE id = ? AND is_read = 0`,
    [user?.id || null, id]
  );
}

/** Mark every notification addressed to one reference as read (e.g. after it is processed). */
async function markReferenceRead(refType, refId, user) {
  await query(
    `UPDATE app_notifications
        SET is_read = 1, read_at = DATEADD(hour, 8, GETUTCDATE()), read_by = ?,
            updated_at = DATEADD(hour, 8, GETUTCDATE())
      WHERE ref_type = ? AND ref_id = ? AND is_read = 0`,
    [user?.id || null, refType, refId]
  );
}

/** Hide a notification without deleting the audit trail. */
async function archiveNotification(id) {
  await query(
    `UPDATE app_notifications
        SET is_archived = 1, updated_at = DATEADD(hour, 8, GETUTCDATE())
      WHERE id = ?`,
    [id]
  );
}

module.exports = {
  createNotification,
  notifyAdminRoles,
  getNotificationsFor,
  countUnreadFor,
  markRead,
  markReferenceRead,
  archiveNotification
};
