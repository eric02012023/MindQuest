/**
 * File: lib/bell.js
 * Purpose: The topbar bell's list — one shape for every role.
 *
 * Every role has a bell now, to the left of the ☰ menu. Clicking it drops a
 * list: the person (photo or initials), what happened, when, and an × that
 * puts the notice away. Its footer has "See all" (the Notifications page) and
 * "Mark all read".
 *
 * The sources differ per role, so each is turned into the same item here:
 *
 *   admin / assistant   registrations and subject requests waiting for a
 *                       decision, and their unread alerts (payment slips,
 *                       payments recorded)
 *   tutor               students' requests waiting on them, and their alerts
 *                       (a focus area ready, a student's module assessment or
 *                       Post-Assessment to check, a module passed or not yet,
 *                       an activity answered) — each with that student's photo,
 *                       opening the very page it is about
 *   student             tutors' answers to their requests, and their alerts
 *                       (payment reminders)
 *
 * A waiting DECISION (a registration, a request to a tutor) has no ×: putting
 * it away would not decide it. It goes away once it is accepted or declined.
 *
 * Pure: no database, so the shape is testable on its own.
 */

/** "Ana Cruz" from any row that has first/middle/last name columns. */
function nameOf(row, prefix = '') {
  return [row[`${prefix}first_name`], row[`${prefix}middle_name`], row[`${prefix}last_name`]]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ');
}

/** "Weekdays, 1:00-2:00 PM" — whichever halves are known. */
function scheduleText(row) {
  return [row.preferred_days, row.time_slot].filter(Boolean).join(', ');
}

function byNewest(a, b) {
  return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
}

/**
 * An unread app_notifications row as a bell item. A notice about a student
 * (student_name, student_image_path — appNotifications.withAlertStudents) shows
 * that student's photo. With `openAlerts` it opens through the role's
 * /alerts/:id/open, which marks it read and goes where it points.
 */
function alertItem(alert, basePath, openAlerts = false) {
  const message = alert.message || '';
  return {
    key: `alert-${alert.id}`,
    kind: 'alert',
    avatarSrc: alert.student_image_path || null,
    avatarName: alert.student_name || 'MindQuest',
    title: alert.title,
    // The subject first, so two alike notices about one student tell apart.
    text: alert.subject_name ? `${alert.subject_name}${message ? ` · ${message}` : ''}` : message,
    createdAt: alert.created_at,
    href: openAlerts ? `${basePath}/alerts/${alert.id}/open` : (alert.link_url || `${basePath}/notifications`),
    dismissUrl: `${basePath}/alerts/${alert.id}/read`
  };
}

/**
 * @param {object} input
 * @param {string} input.basePath          '/admin' | '/assistant' | '/student' | '/tutor'
 * @param {Array}  [input.inbox]           admin/assistant: registrations and subject requests
 * @param {Array}  [input.alerts]          unread app notifications
 * @param {Array}  [input.scheduleRequests] tutor: pending student requests
 * @param {Array}  [input.scheduleUpdates] student: tutors' unread answers
 * @param {boolean} [input.openAlerts]     tutor: alerts open through /alerts/:id/open
 * @returns {Array<{key, kind, avatarSrc, avatarName, title, text, createdAt, href, dismissUrl}>}
 */
function buildBellItems(input = {}) {
  const basePath = input.basePath || '';
  const items = [];

  for (const row of input.inbox || []) {
    const name = nameOf(row) || 'New registration';
    if (row.notification_type === 'subject_enrollment_request') {
      items.push({
        key: `subject-request-${row.id}`,
        kind: 'subject_request',
        avatarSrc: row.image_path || null,
        avatarName: name,
        title: name,
        text: `Asked to enroll in ${row.subject_name || 'a subject'} — waiting for your approval`,
        createdAt: row.created_at,
        href: `${basePath}/notifications#inbox`,
        dismissUrl: null
      });
    } else {
      items.push({
        key: `registration-${row.id}`,
        kind: 'registration',
        avatarSrc: row.image_path || null,
        avatarName: name,
        title: name,
        text: `${row.submission_type === 'tutor' ? 'Applied as a tutor' : 'Registered as a learner'}`
          + `${row.branch_name ? ` at ${row.branch_name}` : ''} — waiting for your approval`,
        createdAt: row.created_at,
        href: `${basePath}/notifications#inbox`,
        dismissUrl: null
      });
    }
  }

  for (const row of input.scheduleRequests || []) {
    const name = nameOf(row, 'student_') || 'A student';
    items.push({
      key: `schedule-request-${row.id}`,
      kind: 'schedule_request',
      avatarSrc: row.student_image_path || null,
      avatarName: name,
      title: name,
      text: `Asked you to teach ${row.subject_name || 'a subject'}${scheduleText(row) ? ` · ${scheduleText(row)}` : ''}`,
      createdAt: row.created_at,
      href: `${basePath}/notifications#requests`,
      dismissUrl: null
    });
  }

  for (const row of input.scheduleUpdates || []) {
    const name = nameOf(row, 'tutor_') || 'Your tutor';
    const accepted = String(row.status || '').toLowerCase() === 'accepted';
    items.push({
      key: `schedule-update-${row.id}`,
      kind: 'schedule_update',
      avatarSrc: row.tutor_image_path || null,
      avatarName: name,
      title: name,
      text: `${accepted ? 'Accepted' : 'Declined'} your request for ${row.subject_name || 'a subject'}`
        + `${scheduleText(row) ? ` · ${scheduleText(row)}` : ''}`,
      createdAt: row.updated_at || row.created_at,
      href: `${basePath}/subjects`,
      dismissUrl: `${basePath}/notifications/${row.id}/read`
    });
  }

  for (const alert of input.alerts || []) items.push(alertItem(alert, basePath, !!input.openAlerts));

  return items.sort(byNewest);
}

module.exports = { buildBellItems, nameOf, scheduleText };
