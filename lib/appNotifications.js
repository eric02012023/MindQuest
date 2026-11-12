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
/**
 * Which notifications a viewer may see, as a WHERE fragment: an admin sees the
 * admin role's, an assistant their branch's, anyone else only their own.
 * Shared by every read and every write below, so a person can only ever read,
 * mark, archive or recover a notification that is theirs to see.
 */
function visibilityClause(user) {
  const role = String(user?.role || '');
  if (role === 'admin') {
    return { sql: '(an.recipient_role = ? OR an.recipient_user_id = ?)', params: ['admin', user.id] };
  }
  if (role === 'admin_assistant') {
    // Branch-scoped, and a role notification with no branch is head-office only.
    return {
      sql: '((an.recipient_role = ? AND an.branch_id = ?) OR an.recipient_user_id = ?)',
      params: ['admin_assistant', Number(user.assistant_scope_branch_id) || -1, user.id]
    };
  }
  return { sql: '(an.recipient_user_id = ?)', params: [user?.id || -1] };
}

async function getNotificationsFor(user, filters = {}) {
  const visible = visibilityClause(user);
  const params = [...visible.params];
  const clauses = [visible.sql];

  if (filters.archivedOnly) clauses.push('an.is_archived = 1');
  else if (!filters.includeArchived) clauses.push('an.is_archived = 0');
  if (filters.unreadOnly) clauses.push('an.is_read = 0');
  if (filters.readOnly) clauses.push('an.is_read = 1');
  if (filters.type) {
    clauses.push('an.notification_type = ?');
    params.push(filters.type);
  }

  const search = String(filters.search || '').trim().toLowerCase();
  if (search) {
    clauses.push("(LOWER(an.title) LIKE ? OR LOWER(COALESCE(an.message, '')) LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }

  const rows = await query(
    `SELECT an.*, br.name AS branch_name,
            r.first_name AS reader_first_name, r.last_name AS reader_last_name
     FROM app_notifications an
     LEFT JOIN branches br ON br.id = an.branch_id
     LEFT JOIN users r ON r.id = an.read_by
     WHERE ${clauses.join(' AND ')}
     ORDER BY an.is_read ASC, an.created_at DESC`,
    params
  );
  return rows.map(relabelLegacy);
}

/**
 * Re-word alerts written before cash became a POS transaction (Phase 3).
 *
 * Their titles are stored text — "Cash payment request — Jordan Lee" — and they
 * are still sitting unread in admins' queues, pointing at a flow that no longer
 * exists. Rewriting the stored rows would edit a historical record to say
 * something it did not say at the time, so the substitution happens on the way
 * OUT instead: the row is untouched, and nobody is shown a request they cannot
 * action. New alerts are written as payment_slip / pos_payment and pass through
 * here unchanged.
 */
function relabelLegacy(row) {
  if (!row || row.notification_type !== 'payment_request') return row;
  return {
    ...row,
    title: String(row.title || '').replace(/^Cash payment request\b/i, 'Pending payment slip'),
    message: String(row.message || '').replace(/wants to pay/i, 'has a payment slip for')
  };
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

/**
 * Mark one read on behalf of the single person it was addressed to — a student
 * dismissing their own payment reminder. Anyone else's id changes nothing.
 */
async function markReadByRecipient(id, user) {
  await query(
    `UPDATE app_notifications
        SET is_read = 1, read_at = DATEADD(hour, 8, GETUTCDATE()), read_by = ?,
            updated_at = DATEADD(hour, 8, GETUTCDATE())
      WHERE id = ? AND recipient_user_id = ? AND is_read = 0`,
    [user.id, id, user.id]
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

/**
 * Hide a notification without deleting the audit trail. With a viewer, only one
 * they may see — so nobody can archive another branch's or another person's.
 */
async function archiveNotification(id, user = null) {
  const visible = user ? visibilityClause(user) : { sql: '1 = 1', params: [] };
  await query(
    `UPDATE an
        SET is_archived = 1, updated_at = DATEADD(hour, 8, GETUTCDATE())
       FROM app_notifications an
      WHERE an.id = ? AND ${visible.sql}`,
    [id, ...visible.params]
  );
}

/** Bring an archived notification back to the list ("View Archive Notification"). */
async function recoverNotification(id, user) {
  const visible = visibilityClause(user);
  await query(
    `UPDATE an
        SET is_archived = 0, updated_at = DATEADD(hour, 8, GETUTCDATE())
       FROM app_notifications an
      WHERE an.id = ? AND ${visible.sql}`,
    [id, ...visible.params]
  );
}

/** Mark one read — only if this viewer may see it (the bell's ×, for staff). */
async function markReadFor(id, user) {
  const visible = visibilityClause(user);
  await query(
    `UPDATE an
        SET is_read = 1, read_at = DATEADD(hour, 8, GETUTCDATE()), read_by = ?,
            updated_at = DATEADD(hour, 8, GETUTCDATE())
       FROM app_notifications an
      WHERE an.id = ? AND an.is_read = 0 AND ${visible.sql}`,
    [user?.id || null, id, ...visible.params]
  );
}

/** "Mark all read" in the bell: every unread notification this viewer can see. */
async function markAllReadFor(user) {
  const visible = visibilityClause(user);
  await query(
    `UPDATE an
        SET is_read = 1, read_at = DATEADD(hour, 8, GETUTCDATE()), read_by = ?,
            updated_at = DATEADD(hour, 8, GETUTCDATE())
       FROM app_notifications an
      WHERE an.is_read = 0 AND an.is_archived = 0 AND ${visible.sql}`,
    [user?.id || null, ...visible.params]
  );
}

/** Mark several read at once — only those this viewer may see. */
async function markManyReadFor(ids = [], user) {
  const list = [...new Set(ids.map(Number).filter(Boolean))];
  if (!list.length || !user) return;
  const visible = visibilityClause(user);
  await query(
    `UPDATE an
        SET is_read = 1, read_at = DATEADD(hour, 8, GETUTCDATE()), read_by = ?,
            updated_at = DATEADD(hour, 8, GETUTCDATE())
       FROM app_notifications an
      WHERE an.is_read = 0 AND an.id IN (${list.map(() => '?').join(',')}) AND ${visible.sql}`,
    [user.id || null, ...list, ...visible.params]
  );
}

/**
 * Every unread notification this viewer may see about one thing (a module of a
 * student's path, their Post-Assessment) marked read — once it is dealt with.
 * Only the viewer's own: the student's notices about the same thing stay.
 */
async function markRefReadFor(refType, refId, user) {
  if (!refType || !Number(refId) || !user) return;
  const visible = visibilityClause(user);
  await query(
    `UPDATE an
        SET is_read = 1, read_at = DATEADD(hour, 8, GETUTCDATE()), read_by = ?,
            updated_at = DATEADD(hour, 8, GETUTCDATE())
       FROM app_notifications an
      WHERE an.is_read = 0 AND an.ref_type = ? AND an.ref_id = ? AND ${visible.sql}`,
    [user.id || null, String(refType), Number(refId), ...visible.params]
  );
}

/**
 * One notification this viewer may see, marked read together with its unread
 * repeats — the same kind of notice about the same thing (a module's assessment
 * written again sends "ready to check" a second time). Returns the row, or null
 * when it is not theirs.
 */
async function markReadWithRepeats(id, user) {
  if (!Number(id) || !user) return null;
  const visible = visibilityClause(user);
  const rows = await query(
    `SELECT TOP 1 an.id, an.notification_type, an.title, an.link_url, an.ref_type, an.ref_id, an.is_read
       FROM app_notifications an
      WHERE an.id = ? AND ${visible.sql}`,
    [Number(id), ...visible.params]
  );
  const row = rows[0];
  if (!row) return null;
  const sameThing = row.ref_type && row.ref_id
    ? ' OR (an.notification_type = ? AND an.ref_type = ? AND an.ref_id = ?)'
    : '';
  await query(
    `UPDATE an
        SET is_read = 1, read_at = DATEADD(hour, 8, GETUTCDATE()), read_by = ?,
            updated_at = DATEADD(hour, 8, GETUTCDATE())
       FROM app_notifications an
      WHERE an.is_read = 0 AND (an.id = ?${sameThing}) AND ${visible.sql}`,
    [
      user.id || null, Number(row.id),
      ...(sameThing ? [row.notification_type, row.ref_type, Number(row.ref_id)] : []),
      ...visible.params
    ]
  );
  return row;
}

/**
 * Before a person is told the same thing again, the unread notice they already
 * have about it is put away (read, by nobody), so their bell lists it once.
 */
async function supersedeUnread({ type, refType, refId, userId } = {}) {
  if (!type || !refType || !Number(refId) || !Number(userId)) return;
  await query(
    `UPDATE app_notifications
        SET is_read = 1, read_at = DATEADD(hour, 8, GETUTCDATE()), updated_at = DATEADD(hour, 8, GETUTCDATE())
      WHERE is_read = 0 AND recipient_user_id = ? AND notification_type = ? AND ref_type = ? AND ref_id = ?`,
    [Number(userId), String(type).slice(0, 50), String(refType).slice(0, 50), Number(refId)]
  );
}

/**
 * The same notice about the same thing listed once: the newest is kept. A
 * notice with no reference is always kept.
 */
function withoutRepeats(alerts = []) {
  const seen = new Set();
  return [...alerts]
    .filter(Boolean)
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
    .filter((alert) => {
      if (!alert.ref_type || !alert.ref_id) return true;
      const key = `${alert.notification_type}|${alert.ref_type}|${Number(alert.ref_id)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** The students the notices are about, and the subject, by what they point at. */
const STUDENT_OF_REF = {
  learning_path_module: `SELECT lpm.id AS ref_id, u.id AS student_id, u.first_name, u.last_name, u.image_path, s.name AS subject_name
       FROM learning_path_modules lpm
       JOIN learning_paths lp ON lp.id = lpm.path_id
       JOIN users u ON u.id = lp.student_id
       JOIN subjects s ON s.id = lp.subject_id
      WHERE lpm.id IN (#)`,
  learning_path: `SELECT lp.id AS ref_id, u.id AS student_id, u.first_name, u.last_name, u.image_path, s.name AS subject_name
       FROM learning_paths lp
       JOIN users u ON u.id = lp.student_id
       JOIN subjects s ON s.id = lp.subject_id
      WHERE lp.id IN (#)`,
  focus_handout: `SELECT fh.id AS ref_id, u.id AS student_id, u.first_name, u.last_name, u.image_path, s.name AS subject_name
       FROM focus_handouts fh
       JOIN users u ON u.id = fh.student_id
       JOIN subjects s ON s.id = fh.subject_id
      WHERE fh.id IN (#)`,
  tutor_submission: `SELECT sub.id AS ref_id, u.id AS student_id, u.first_name, u.last_name, u.image_path, s.name AS subject_name
       FROM tutor_assessment_submissions sub
       JOIN users u ON u.id = sub.student_id
       JOIN tutor_assessments ta ON ta.id = sub.assessment_id
       JOIN subjects s ON s.id = ta.subject_id
      WHERE sub.id IN (#)`
};

/**
 * Each notice about a student with that student's name and photo, and the
 * subject, so the bell shows whose it is and in what — two "Module 1 assessment
 * ready to check" for the same student read alike otherwise. One query for all
 * of them, and none when no notice points at a student.
 */
async function withAlertStudents(alerts = []) {
  const idsByRef = new Map();
  for (const alert of alerts) {
    if (!alert || !STUDENT_OF_REF[alert.ref_type] || !Number(alert.ref_id)) continue;
    if (!idsByRef.has(alert.ref_type)) idsByRef.set(alert.ref_type, new Set());
    idsByRef.get(alert.ref_type).add(Number(alert.ref_id));
  }
  if (!idsByRef.size) return alerts;
  const parts = [];
  const params = [];
  for (const [refType, ids] of idsByRef) {
    const list = [...ids];
    parts.push(`SELECT '${refType}' AS ref_type, x.* FROM (${STUDENT_OF_REF[refType].replace('#', list.map(() => '?').join(','))}) x`);
    params.push(...list);
  }
  const rows = await query(parts.join(' UNION ALL '), params);
  const byRef = new Map(rows.map((row) => [`${row.ref_type}|${Number(row.ref_id)}`, row]));
  return alerts.map((alert) => {
    const student = alert && byRef.get(`${alert.ref_type}|${Number(alert.ref_id)}`);
    if (!student) return alert;
    return {
      ...alert,
      student_id: Number(student.student_id),
      student_name: [student.first_name, student.last_name].filter(Boolean).join(' '),
      student_image_path: student.image_path || null,
      subject_name: student.subject_name || null
    };
  });
}

module.exports = {
  createNotification,
  notifyAdminRoles,
  getNotificationsFor,
  countUnreadFor,
  markRead,
  markReadByRecipient,
  markReferenceRead,
  archiveNotification,
  recoverNotification,
  markReadFor,
  markAllReadFor,
  markManyReadFor,
  markRefReadFor,
  markReadWithRepeats,
  supersedeUnread,
  withoutRepeats,
  withAlertStudents,
  visibilityClause
};
