/**
 * File: scripts/test-payment-reminders.js
 * Purpose: Pin down the weekly payment reminders, and that an online payment is
 *          filed under the method the student used (GCash), never "Online".
 *
 * Run:  node scripts/test-payment-reminders.js     (needs no database, no keys)
 *
 * WHY THIS EXISTS
 * The reminder schedule reads as one line — 1st week, 2nd week, last week —
 * and hides the traps:
 *
 *   1. The weeks are Manila's. The server runs in UTC, so 7:30 AM on the 8th in
 *      Manila is still the 7th on the server's own clock.
 *   2. "The last week" is the final seven days of THAT month: 25-31 in
 *      October, 22-28 in a February, 23-29 in a leap February.
 *   3. The amount must be one the payment form accepts (₱500 down, then a
 *      third of the bill, the last instalment being the rest) — a reminder
 *      asking for less than the form allows sends the student to a refusal.
 *   4. Running every hour must not send a second copy.
 *
 * And for Payment Collection: a payment made with GCash through PayMongo was
 * written as "Online", so the GCash filter could not find it.
 *
 * `config/db` is replaced in the require cache before anything loads, and
 * `fetch` is replaced too, so nothing dials out.
 */

let failures = 0;
const ok = (l, c, e = '') => {
  if (c) console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`);
  else { failures++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};

// --- no network, no PayMongo key unless a test sets one ---------------------
process.env.PAYMONGO_SECRET_KEY = '';
const fetchCalls = [];
let fetchAnswer = null;
global.fetch = async (url) => {
  fetchCalls.push(String(url));
  if (!fetchAnswer) throw new Error('the test must never reach the network');
  return { ok: true, json: async () => fetchAnswer };
};

// --- the scripted database --------------------------------------------------
const db = { statements: [], accounts: [], onlinePayment: null, onlineEntries: [] };
function answer(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  db.statements.push({ sql, params });
  if (/^UPDATE an SET is_read = 1/i.test(sql)) return [{ id: 1 }, { id: 2 }];
  if (/^DELETE FROM app_notifications/i.test(sql)) return [{ id: 9 }];
  if (/^SELECT b\.student_id, b\.full_bill/i.test(sql)) return db.accounts;
  if (/^SELECT TOP 1 \* FROM online_payments/i.test(sql)) return db.onlinePayment ? [{ ...db.onlinePayment }] : [];
  if (/^UPDATE online_payments/i.test(sql)) return [{ claimed_id: db.onlinePayment.id }];
  if (/^SELECT TOP 1 id, full_bill, partial_payment FROM billing/i.test(sql)) return [{ id: 3, full_bill: 1800, partial_payment: 500 }];
  if (/^SELECT COALESCE\(MAX\(sequence_no\)/i.test(sql)) return [{ last_seq: 1, paid: 500 }];
  if (/^SELECT COALESCE\(SUM\(amount\), 0\) AS paid, MAX/i.test(sql)) return [{ paid: 1100, last_paid_at: null, entry_count: 2 }];
  if (/^SELECT TOP 1 full_bill FROM billing/i.test(sql)) return [{ full_bill: 1800 }];
  if (/^SELECT TOP 100 id, reference_no, payment_method FROM payment_entries/i.test(sql)) return db.onlineEntries;
  if (/^INSERT/i.test(sql)) return { insertId: 77 };
  return [];
}
const dbPath = require.resolve('../config/db');
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    sql: {},
    baseConfig: {},
    getPool: async () => { throw new Error('the test must never open a connection'); },
    query: async (text, params) => answer(text, params),
    withTransaction: async (work) => work({ query: async (text, params) => [answer(text, params)] })
  }
};

const { reminderWeekFor, composeReminder, sendPaymentReminders, startPaymentReminders } = require('../lib/paymentReminders');
const { PAYMENT_METHODS, onlineMethodLabel } = require('../lib/billing');
const { completeOnlinePayment, resolveOnlinePaymentMethods } = require('../lib/data');

/** A Manila wall-clock time as the instant the server sees. */
const manila = (text) => new Date(`${text}+08:00`);
const bill = (full, partial = 0, due = null) => ({ full_bill: full, partial_payment: partial, payment_due: due });

(async () => {
  console.log('\n== which week it is, in Manila ==');
  const first = reminderWeekFor(manila('2026-10-01T09:00:00'));
  ok('1 October is the 1st week', first && first.slot === 1, JSON.stringify(first && first.label));
  ok('its key is month + week', first && first.key === 2026101, String(first && first.key));
  ok('7:30 AM on the 8th in Manila is the 2nd week (still the 7th in UTC)',
    reminderWeekFor(manila('2026-10-08T07:30:00')).slot === 2);
  ok('11:30 PM on the 7th is still the 1st week', reminderWeekFor(manila('2026-10-07T23:30:00')).slot === 1);
  ok('the 14th is the 2nd week', reminderWeekFor(manila('2026-10-14T12:00:00')).slot === 2);
  ok('nothing on the 15th', reminderWeekFor(manila('2026-10-15T12:00:00')) === null);
  ok('nothing on 24 October', reminderWeekFor(manila('2026-10-24T12:00:00')) === null);
  const last = reminderWeekFor(manila('2026-10-25T08:00:00'));
  ok('25 October starts the last week', last && last.slot === 3 && last.weekStart === '2026-10-25', JSON.stringify(last));
  ok('a February\'s last week starts on the 22nd', reminderWeekFor(manila('2027-02-22T08:00:00')).slot === 3
    && reminderWeekFor(manila('2027-02-21T08:00:00')) === null);
  ok('a leap February\'s on the 23rd', reminderWeekFor(manila('2028-02-23T08:00:00')).slot === 3
    && reminderWeekFor(manila('2028-02-22T08:00:00')) === null);
  ok('December\'s key does not run into January\'s',
    reminderWeekFor(manila('2026-12-31T08:00:00')).key === 2026123
    && reminderWeekFor(manila('2027-01-01T08:00:00')).key === 2027011);

  console.log('\n== what the 1st and 2nd week ask for ==');
  const w1 = reminderWeekFor(manila('2026-10-03T08:00:00'));
  const w2 = reminderWeekFor(manila('2026-10-09T08:00:00'));
  const fresh = composeReminder(w1, bill(1800), 0);
  ok('nothing paid: the ₱500 down payment', /₱500\.00 this week/.test(fresh.title) && /down payment/.test(fresh.message), fresh.message);
  ok('and says what is left', /₱1,800\.00/.test(fresh.message));
  const instalment = composeReminder(w2, bill(1800, 500), 500);
  ok('after the down payment: a third of the bill', /₱600\.00 this week/.test(instalment.title), instalment.title);
  ok('…and the ₱1,300 still owed', /₱1,300\.00/.test(instalment.message), instalment.message);
  ok('the 2nd week says so', /^2nd week of October/.test(instalment.message));
  const tail = composeReminder(w1, bill(1800, 1700), 1700);
  ok('the last ₱100: asks for exactly that', /₱100\.00 this week/.test(tail.title) && /the remaining ₱100\.00/.test(tail.message), tail.message);
  ok('a small bill is asked for in full, not ₱500',
    /₱300\.00 this week/.test(composeReminder(w1, bill(300), 0).title));
  ok('a migrated payment counts as paid (no fresh down payment)',
    /₱600\.00 this week/.test(composeReminder(w1, bill(1800, 500), 0).title));
  ok('already paid this week: no reminder', composeReminder(w2, bill(1800, 500), 500, '2026-10-08') === null);
  ok('paid last week: reminded', composeReminder(w2, bill(1800, 500), 500, '2026-10-07') !== null);
  ok('settled: nothing to say', composeReminder(w1, bill(1800, 1800), 1800) === null);

  console.log('\n== the last week names the day ==');
  const lw = reminderWeekFor(manila('2026-10-26T08:00:00'));
  const dueSoon = composeReminder(lw, bill(1800, 500, new Date('2026-10-28T00:00:00Z')), 500);
  ok('the account\'s own due date', dueSoon.title === 'Payment due Wed, Oct 28', dueSoon.title);
  ok('in full, with the whole balance', /₱1,300\.00 is due on Wednesday, October 28, 2026/.test(dueSoon.message), dueSoon.message);
  ok('as a warning', dueSoon.severity === 'warning');
  ok('a paid-this-week student still hears the due date',
    composeReminder(lw, bill(1800, 1100, new Date('2026-10-28T00:00:00Z')), 1100, '2026-10-25') !== null);
  const noDate = composeReminder(lw, bill(1800), 0);
  ok('no due date on the account: the last day of the month', noDate.title === 'Payment due Sat, Oct 31', noDate.title);
  const overdue = composeReminder(lw, bill(1800, 500, new Date('2026-09-19T00:00:00Z')), 500);
  ok('a date already gone: overdue', /^Payment overdue since Sat, Sep 19/.test(overdue.title) && overdue.severity === 'danger', overdue.title);
  const later = composeReminder(lw, bill(1800, 500, new Date('2026-11-05T00:00:00Z')), 500);
  ok('due next month: this week\'s instalment and the day it is all due',
    /₱600\.00 this week/.test(later.title) && /Thursday, November 5, 2026/.test(later.message), later.message);

  console.log('\n== sending: once per student per week ==');
  db.statements.length = 0;
  db.accounts = [
    { student_id: 1, full_bill: 1800, partial_payment: 0, payment_due: null, ledger_paid: 0, last_paid_local: null },
    { student_id: 1, full_bill: 1800, partial_payment: 0, payment_due: null, ledger_paid: 0, last_paid_local: null },
    { student_id: 2, full_bill: 1800, partial_payment: 1800, payment_due: null, ledger_paid: 1800, last_paid_local: null },
    ...Array.from({ length: 249 }, (_, i) => ({
      student_id: 100 + i, full_bill: 3600, partial_payment: 500, payment_due: null, ledger_paid: 500, last_paid_local: null
    }))
  ];
  const outcome = await sendPaymentReminders({ now: manila('2026-10-02T09:00:00') });
  const inserts = db.statements.filter((s) => /^INSERT INTO app_notifications/i.test(s.sql));
  ok('one each: a duplicate account row is not a second reminder, a settled one gets none', outcome.sent === 250, String(outcome.sent));
  ok('in batches of 100 (SQL Server takes 2,100 parameters)', inserts.length === 3
    && inserts.every((s) => s.params.length <= 2100), inserts.map((s) => s.params.length / 8).join(', '));
  ok('each row is addressed to the student, typed and keyed by week',
    inserts[0].params[0] === 'payment_reminder' && inserts[0].params[5] === 2026101 && inserts[0].params[6] === 1);
  ok('and opens Billing Data', inserts[0].params[3] === '/student/billing');
  const select = db.statements.find((s) => /^SELECT b\.student_id/i.test(s.sql));
  ok('students who already have this week\'s reminder are not asked again',
    /NOT EXISTS/.test(select.sql) && select.params.includes(2026101));
  ok('only approved, active students', /u\.status = 'approved'/.test(select.sql) && /u\.is_archived = 0/.test(select.sql));
  const del = db.statements.find((s) => /^DELETE FROM app_notifications/i.test(s.sql));
  ok('earlier weeks\' reminders give way to this one', del && del.params[1] === 2026101);
  ok('reminders the student has answered are marked read', outcome.cleared === 2);

  db.statements.length = 0;
  const quiet = await sendPaymentReminders({ now: manila('2026-10-20T09:00:00') });
  ok('between the 2nd and the last week nothing is sent or deleted',
    quiet.sent === 0 && !db.statements.some((s) => /^(INSERT|DELETE)/i.test(s.sql)));

  process.env.PAYMENT_REMINDERS = 'off';
  ok('PAYMENT_REMINDERS=off turns the schedule off', startPaymentReminders({ log: { log() {}, error() {} } }) === null);
  delete process.env.PAYMENT_REMINDERS;

  console.log('\n== Payment Collection files GCash under GCash ==');
  ok('there is no "Online" method to pick or filter by', !PAYMENT_METHODS.some((m) => /online/i.test(m.value)));
  ok('every method PayMongo offers has a name the filter knows',
    ['gcash', 'paymaya', 'grab_pay', 'card'].every((type) => PAYMENT_METHODS.some((m) => m.value === onlineMethodLabel(type))));
  ok('gcash -> GCash', onlineMethodLabel('gcash') === 'GCash');
  ok('unknown -> nothing (never a guess)', onlineMethodLabel('something_new') === null && onlineMethodLabel(null) === null);

  db.statements.length = 0;
  db.onlinePayment = { id: 5, student_id: 9, amount: 600, provider: 'PayMongo', provider_reference: 'cs_abc', status: 'pending', notes: '' };
  await completeOnlinePayment(5, { transactionReference: 'pay_xyz', method: 'gcash' });
  const entry = db.statements.find((s) => /^INSERT INTO payment_entries/i.test(s.sql));
  ok('a GCash checkout is written to the ledger as GCash', entry && entry.params[4] === 'GCash', entry && entry.params[4]);
  ok('without asking PayMongo again when the caller knew', fetchCalls.length === 0);

  db.statements.length = 0;
  db.onlinePayment = { ...db.onlinePayment, status: 'pending' };
  process.env.PAYMONGO_SECRET_KEY = 'sk_test_scripted_key_123';
  fetchAnswer = { data: { attributes: { payment_method_used: 'paymaya' } } };
  await completeOnlinePayment(5, { transactionReference: 'pay_xyz' });
  const asked = db.statements.find((s) => /^INSERT INTO payment_entries/i.test(s.sql));
  ok('otherwise PayMongo is asked, and Maya is written', asked && asked.params[4] === 'Maya'
    && fetchCalls[0] === 'https://api.paymongo.com/v1/payments/pay_xyz', `${asked && asked.params[4]} via ${fetchCalls[0]}`);

  db.statements.length = 0;
  fetchAnswer = null; // PayMongo unreachable
  await completeOnlinePayment(5, { transactionReference: 'pay_xyz' });
  const offline = db.statements.find((s) => /^INSERT INTO payment_entries/i.test(s.sql));
  ok('PayMongo unreachable: the payment is still recorded', offline && offline.params[3] === 600);

  console.log('\n== older "Online" entries are re-filed ==');
  fetchAnswer = { data: { attributes: { source: { type: 'gcash' } } } };
  db.onlineEntries = [{ id: 13, reference_no: 'pay_1DHkg7RVCr4k31gJvFZ3pGEb', payment_method: 'Online' }];
  db.statements.length = 0;
  const report = await resolveOnlinePaymentMethods({ commit: false });
  ok('a report-only run names the change', report.changed.length === 1 && report.changed[0].to === 'GCash');
  ok('…and writes nothing', !db.statements.some((s) => /^UPDATE payment_entries/i.test(s.sql)));
  const fixed = await resolveOnlinePaymentMethods();
  const update = db.statements.find((s) => /^UPDATE payment_entries/i.test(s.sql));
  ok('a real run changes only the method label', update && update.params[0] === 'GCash' && update.params[1] === 13
    && /SET payment_method = \? WHERE/.test(update.sql), update && update.sql);
  ok('and only if it still says Online', update && /LOWER\(payment_method\) = 'online'/.test(update.sql));
  fetchAnswer = null;
  const unresolved = await resolveOnlinePaymentMethods();
  ok('PayMongo cannot say: left as it is', unresolved.changed.length === 0 && unresolved.unresolved[0] === 13);

  console.log(failures ? `\n${failures} FAILED` : '\nAll payment reminder and method checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
