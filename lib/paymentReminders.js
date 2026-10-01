/**
 * File: lib/paymentReminders.js
 * Purpose: Remind every student who owes money, in their bell, what to pay —
 *          in the 1st week, the 2nd week and the last week of each month.
 *
 * THE SCHEDULE (calendar month, Manila time)
 *   1st week   days 1-7          "Pay ₱600.00 this week"
 *   2nd week   days 8-14         "Pay ₱600.00 this week"
 *   last week  the final 7 days  "Your balance of ₱1,300.00 is due on
 *                                 Wednesday, October 28, 2026"
 * Nothing is sent between the 2nd and the last week.
 *
 * The amount is the floor the payment form itself enforces (lib/billing.js,
 * paymentFloorFor): the ₱500 down payment first, then a third of the bill, the
 * last instalment being whatever is left. So a reminder never asks for an
 * amount the form would refuse. The last week asks for the whole balance and
 * names the day it is due: the account's own due date — the one Billing Data
 * shows — or the last day of the month when the account has none.
 *
 * ONE REMINDER AT A TIME
 * A new week's reminder replaces the last one rather than piling up beside it:
 * last week's figures are out of date the moment this week's are written, and
 * the database is capped at 30 MB (DEPLOYMENT.md), so a few hundred students x
 * three a month must not accumulate forever. A reminder is marked read once the
 * student pays after receiving it, or clears the account.
 *
 * HOW IT RUNS
 * server.js calls startPaymentReminders() once the server is listening. It runs
 * shortly after start and then hourly. Render's free instance sleeps when idle,
 * so "at start" is what usually catches a new week. Running it again never
 * sends a second copy: each reminder carries its month and week in ref_id, and
 * a student who already has this week's is skipped.
 */

const { query } = require('../config/db');
const { paymentFloorFor, remainingFor } = require('./billing');

const NOTIFICATION_TYPE = 'payment_reminder';
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEK_LABELS = { 1: '1st week', 2: '2nd week', 3: 'Last week' };

/** A calendar day as 'YYYY-MM-DD'. Days compare correctly as plain strings. */
function isoDay(year, monthIndex, day) {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

/**
 * A stored date as 'YYYY-MM-DD'. The driver hands a DATE column back as UTC
 * midnight of that day, so the UTC calendar day is the stored one.
 */
function toIsoDay(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const match = String(value).match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

/** 'Wednesday, October 28, 2026' */
function longDate(day) {
  const [year, month, date] = day.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, date)).getUTCDay()];
  return `${weekday}, ${MONTHS[month - 1]} ${date}, ${year}`;
}

/** 'Wed, Oct 28' */
function shortDate(day) {
  const [year, month, date] = day.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, date)).getUTCDay()];
  return `${weekday.slice(0, 3)}, ${MONTHS[month - 1].slice(0, 3)} ${date}`;
}

function peso(amount) {
  return `₱${Number(amount || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * The reminder week `now` falls in, in Manila — or null between the 2nd and the
 * last week, when nothing is sent.
 */
function reminderWeekFor(now = new Date()) {
  const manila = new Date(now.getTime() + MANILA_OFFSET_MS);
  const year = manila.getUTCFullYear();
  const monthIndex = manila.getUTCMonth();
  const day = manila.getUTCDate();
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

  let slot = null;
  let firstDay = 1;
  if (day <= 7) slot = 1;
  else if (day <= 14) { slot = 2; firstDay = 8; }
  else if (day > lastDay - 7) { slot = 3; firstDay = lastDay - 6; }
  if (!slot) return null;

  return {
    slot,
    // One number per month and week — October 2026's last week is 2026103. It
    // is stored as the reminder's ref_id, which is how "already sent" is told.
    key: (year * 100 + monthIndex + 1) * 10 + slot,
    label: WEEK_LABELS[slot],
    monthName: MONTHS[monthIndex],
    today: isoDay(year, monthIndex, day),
    weekStart: isoDay(year, monthIndex, firstDay),
    monthEnd: isoDay(year, monthIndex, lastDay)
  };
}

/**
 * What one student is told this week, or null when there is nothing to say.
 *
 * @param {object} week            from reminderWeekFor
 * @param {object} bill            billing row: full_bill, partial_payment, payment_due
 * @param {number} [ledgerPaid]    SUM(payment_entries.amount) for the account
 * @param {string} [lastPaidDay]   'YYYY-MM-DD' (Manila) of their latest payment
 * @returns {{title:string, message:string, severity:string}|null}
 */
function composeReminder(week, bill, ledgerPaid = 0, lastPaidDay = null) {
  if (!week || !bill) return null;
  const remaining = remainingFor(bill, ledgerPaid);
  if (remaining <= 0) return null;

  const floor = paymentFloorFor(bill, ledgerPaid);
  const due = Math.min(floor.amount, remaining);
  const settlesIt = due >= remaining;

  if (week.slot !== 3) {
    // Already paid this week: this week's reminder would ask for money they
    // have just handed over.
    if (lastPaidDay && lastPaidDay >= week.weekStart) return null;
    const ask = settlesIt
      ? `the remaining ${peso(remaining)}`
      : floor.kind === 'down_payment' ? `your ${peso(due)} down payment` : `at least ${peso(due)}`;
    return {
      title: `Payment reminder: ${peso(due)} this week`,
      message: `${week.label} of ${week.monthName} — please pay ${ask} this week.`
        + (settlesIt ? '' : ` Your remaining balance is ${peso(remaining)}.`),
      severity: 'info'
    };
  }

  // The last week names the day.
  const dueDay = toIsoDay(bill.payment_due) || week.monthEnd;
  if (dueDay < week.today) {
    return {
      title: `Payment overdue since ${shortDate(dueDay)}`,
      message: `Your balance of ${peso(remaining)} was due on ${longDate(dueDay)}. Please settle it this week.`,
      severity: 'danger'
    };
  }
  if (dueDay <= week.monthEnd) {
    return {
      title: `Payment due ${shortDate(dueDay)}`,
      message: `${week.label} of ${week.monthName} — your remaining balance of ${peso(remaining)} `
        + `is due on ${longDate(dueDay)}. Please settle it on or before that day.`,
      severity: 'warning'
    };
  }
  // Due after this month ends: this week's instalment, and the day it all falls due.
  return {
    title: `Payment reminder: ${peso(due)} this week`,
    message: `${week.label} of ${week.monthName} — please pay `
      + `${settlesIt ? `the remaining ${peso(remaining)}` : `at least ${peso(due)}`} this week. `
      + `Your balance of ${peso(remaining)} is due on ${longDate(dueDay)}.`,
    severity: 'warning'
  };
}

/**
 * Mark read every unread reminder the student has since acted on: they paid
 * after it was sent, or the account is settled. paid_at is stored in UTC and
 * created_at in Manila time, hence the eight hours.
 */
async function clearAnsweredReminders() {
  const rows = await query(
    `UPDATE an
        SET is_read = 1, read_at = DATEADD(hour, 8, GETUTCDATE()), updated_at = DATEADD(hour, 8, GETUTCDATE())
     OUTPUT inserted.id
       FROM app_notifications an
      WHERE an.notification_type = ? AND an.is_read = 0
        AND (EXISTS (SELECT 1 FROM billing b
                      WHERE b.student_id = an.recipient_user_id AND b.full_bill > 0 AND b.for_settlement <= 0)
             OR EXISTS (SELECT 1 FROM payment_entries pe
                         WHERE pe.student_id = an.recipient_user_id
                           AND DATEADD(hour, 8, pe.paid_at) >= an.created_at))`,
    [NOTIFICATION_TYPE]
  );
  return rows.length;
}

/**
 * Send this week's reminder to every approved student who owes money and does
 * not have it yet. Safe to run as often as you like.
 *
 * @param {object} [options]
 * @param {Date} [options.now]  the moment to plan for (tests pass one)
 */
async function sendPaymentReminders({ now = new Date() } = {}) {
  const week = reminderWeekFor(now);
  const outcome = { week: week ? week.key : null, sent: 0, cleared: 0, replaced: 0 };

  outcome.cleared = await clearAnsweredReminders();
  if (!week) return outcome;

  // Earlier weeks' reminders give way to this week's.
  const replaced = await query(
    `DELETE FROM app_notifications
     OUTPUT deleted.id
      WHERE notification_type = ? AND (ref_id IS NULL OR ref_id <> ?)`,
    [NOTIFICATION_TYPE, week.key]
  );
  outcome.replaced = replaced.length;

  const accounts = await query(
    `SELECT b.student_id, b.full_bill, b.partial_payment, b.payment_due,
            (SELECT COALESCE(SUM(pe.amount), 0) FROM payment_entries pe WHERE pe.billing_id = b.id) AS ledger_paid,
            (SELECT MAX(DATEADD(hour, 8, pe.paid_at)) FROM payment_entries pe WHERE pe.billing_id = b.id) AS last_paid_local
       FROM billing b
       INNER JOIN users u ON u.id = b.student_id
      WHERE u.role = 'student' AND u.status = 'approved' AND u.is_archived = 0
        AND b.full_bill > 0
        AND NOT EXISTS (SELECT 1 FROM app_notifications an
                         WHERE an.notification_type = ? AND an.recipient_user_id = b.student_id AND an.ref_id = ?)
      ORDER BY b.student_id, b.id`,
    [NOTIFICATION_TYPE, week.key]
  );

  const seen = new Set();
  const reminders = [];
  for (const account of accounts) {
    // One reminder per student, even if an old duplicate billing row exists.
    if (seen.has(account.student_id)) continue;
    seen.add(account.student_id);
    const reminder = composeReminder(week, account, account.ledger_paid, toIsoDay(account.last_paid_local));
    if (reminder) reminders.push({ ...reminder, studentId: account.student_id });
  }

  // 100 rows (900 parameters) per statement — SQL Server allows 2,100.
  for (let start = 0; start < reminders.length; start += 100) {
    const batch = reminders.slice(start, start + 100);
    await query(
      `INSERT INTO app_notifications
         (notification_type, title, message, link_url, ref_type, ref_id, recipient_user_id, severity, is_read)
       VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, 0)').join(', ')}`,
      batch.flatMap((reminder) => [
        NOTIFICATION_TYPE, reminder.title, reminder.message, '/student/billing',
        NOTIFICATION_TYPE, week.key, reminder.studentId, reminder.severity
      ])
    );
    outcome.sent += batch.length;
  }
  return outcome;
}

/**
 * Run sendPaymentReminders shortly after start and then every hour, one run at
 * a time. PAYMENT_REMINDERS=off in the environment turns it off.
 */
function startPaymentReminders({ log = console, firstRunMs = 20 * 1000, everyMs = HOUR_MS } = {}) {
  if (String(process.env.PAYMENT_REMINDERS || '').trim().toLowerCase() === 'off') {
    log.log('Payment reminders: off (PAYMENT_REMINDERS=off)');
    return null;
  }

  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const outcome = await sendPaymentReminders();
      if (outcome.sent || outcome.cleared || outcome.replaced) {
        log.log(`Payment reminders (week ${outcome.week || 'none'}): ${outcome.sent} sent, `
          + `${outcome.replaced} replaced, ${outcome.cleared} answered by a payment.`);
      }
    } catch (error) {
      log.error('[payment reminders]', error.message);
    } finally {
      running = false;
    }
  };

  const first = setTimeout(run, firstRunMs);
  const timer = setInterval(run, everyMs);
  // Never the reason the process stays alive.
  if (first.unref) first.unref();
  if (timer.unref) timer.unref();
  log.log('Payment reminders: on — 1st, 2nd and last week of each month');
  return { run, stop: () => { clearTimeout(first); clearInterval(timer); } };
}

module.exports = {
  NOTIFICATION_TYPE,
  reminderWeekFor,
  composeReminder,
  clearAnsweredReminders,
  sendPaymentReminders,
  startPaymentReminders
};
