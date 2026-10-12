/**
 * File: scripts/test-notification-bell.js
 * Purpose: Pin down two things this release fixed.
 *
 * Run:  node scripts/test-notification-bell.js      (needs no database, no keys)
 *
 *   1. "Can't acquire connection for the request. There is another request in
 *      progress." — what a student saw when picking a tutor. A transaction owns
 *      one connection, and the code ran three reads on it at once
 *      (Promise.all). config/db.js now queues a transaction's statements. The
 *      mssql driver is replaced here by one that throws exactly that error on
 *      overlapping requests, so the test fails the way the page did.
 *   2. The topbar bell's list (lib/bell.js): one shape for every role, an × only
 *      on what can be put away, newest first.
 */

let failures = 0;
const ok = (l, c, e = '') => {
  if (c) console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`);
  else { failures++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};

// --- a driver that refuses overlapping requests on one transaction -----------
const BUSY = "Can't acquire connection for the request. There is another request in progress.";
let failNext = false;
class FakeRequest {
  constructor(owner) { this.owner = owner; }
  input() { return this; }
  async query(text) {
    if (this.owner.busy) throw new Error(BUSY);
    this.owner.busy = true;
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.owner.busy = false;
    if (failNext) { failNext = false; throw new Error('Invalid column name.'); }
    this.owner.ran.push(text);
    return { recordset: [{ ok: 1 }], recordsets: [[{ ok: 1 }]], rowsAffected: [1] };
  }
}
class FakeTransaction {
  constructor() { this.busy = false; this.ran = []; FakeTransaction.last = this; }
  async begin() {}
  request() { return new FakeRequest(this); }
  async commit() {}
  async rollback() {}
}
class FakePool {
  on() {}
  async connect() { return this; }
  request() { return new FakeRequest({ busy: false, ran: [] }); }
  async close() {}
}
const type = () => 'type';
const mssqlPath = require.resolve('mssql');
require.cache[mssqlPath] = {
  id: mssqlPath, filename: mssqlPath, loaded: true,
  exports: {
    ConnectionPool: FakePool, Transaction: FakeTransaction,
    NVarChar: type, Decimal: type, Bit: 'bit', DateTime: 'datetime', MAX: 'max'
  }
};

const { withTransaction } = require('../config/db');
const { buildBellItems } = require('../lib/bell');

(async () => {
  console.log('\n== a transaction runs its statements one at a time ==');
  const results = await withTransaction((connection) => Promise.all([
    connection.query('SELECT 1'),
    connection.query('SELECT 2'),
    connection.query('SELECT 3')
  ])).catch((error) => error);
  ok('three reads side by side do not collide', Array.isArray(results), results instanceof Error ? results.message : '');
  ok('each answers in the [rows] shape', Array.isArray(results) && results.every((r) => Array.isArray(r) && Array.isArray(r[0])));
  ok('all three ran, in order', FakeTransaction.last.ran.join(',') === 'SELECT 1,SELECT 2,SELECT 3', FakeTransaction.last.ran.join(','));

  failNext = true;
  const afterFailure = await withTransaction(async (connection) => {
    const first = connection.query('SELECT bad').catch((error) => error.message);
    const second = connection.query('SELECT after');
    return Promise.all([first, second]);
  }).catch((error) => error);
  ok('a failed statement does not block the next one',
    Array.isArray(afterFailure) && afterFailure[0] === 'Invalid column name.' && Array.isArray(afterFailure[1]),
    afterFailure instanceof Error ? afterFailure.message : JSON.stringify(afterFailure && afterFailure[0]));

  console.log('\n== the bell: admin ==');
  const admin = buildBellItems({
    basePath: '/admin',
    inbox: [
      { id: 5, submission_type: 'student', first_name: 'Ana', last_name: 'Cruz', branch_name: 'MAIN BRANCH', created_at: '2026-10-08T10:00:00Z' },
      { id: 9, notification_type: 'subject_enrollment_request', first_name: 'Ben', last_name: 'Reyes', subject_name: 'FILIPINO', created_at: '2026-10-09T10:00:00Z' }
    ],
    alerts: [{ id: 3, title: 'Pending payment slip — Carla Diaz', message: 'PS-0003 for ₱600.00', link_url: '/admin/billing?slip=3', created_at: '2026-10-10T10:00:00Z' }]
  });
  ok('every item is listed', admin.length === 3);
  ok('newest first', admin[0].key === 'alert-3' && admin[2].key === 'registration-5', admin.map((i) => i.key).join(','));
  ok('a registration has no × (it waits for a decision)', admin.find((i) => i.kind === 'registration').dismissUrl === null);
  ok('a subject request names the subject', /FILIPINO/.test(admin.find((i) => i.kind === 'subject_request').text));
  ok('an alert can be marked read from the bell', admin[0].dismissUrl === '/admin/alerts/3/read');
  ok('an alert opens where it points', admin[0].href === '/admin/billing?slip=3');
  ok('decisions open the Notifications page', admin[2].href === '/admin/notifications#inbox');

  console.log('\n== the bell: tutor and student ==');
  const tutor = buildBellItems({
    basePath: '/tutor',
    scheduleRequests: [{ id: 11, student_first_name: 'Dina', student_last_name: 'Lim', subject_name: 'ENGLISH', preferred_days: 'Weekend', time_slot: '1:00-2:00 PM', created_at: '2026-10-11T01:00:00Z' }]
  });
  ok('a student request says the days and time', /Weekend, 1:00-2:00 PM/.test(tutor[0].text), tutor[0].text);
  ok('and is answered on the Notifications page', tutor[0].href === '/tutor/notifications#requests' && tutor[0].dismissUrl === null);

  const student = buildBellItems({
    basePath: '/student',
    scheduleUpdates: [{ id: 12, status: 'accepted', tutor_first_name: 'Eli', tutor_last_name: 'Tan', subject_name: 'SCIENCE', time_slot: '9:00-10:00 AM', preferred_days: 'Weekdays', updated_at: '2026-10-11T02:00:00Z' }],
    alerts: [{ id: 4, title: 'Payment reminder', message: 'Your next payment is due.', created_at: '2026-10-01T00:00:00Z' }]
  });
  ok('a tutor\'s answer reads as accepted', /^Accepted your request for SCIENCE/.test(student[0].text), student[0].text);
  ok('it can be marked read', student[0].dismissUrl === '/student/notifications/12/read');
  ok('a reminder with no link opens the Notifications page', student[1].href === '/student/notifications');
  ok('nothing at all is an empty list', buildBellItems({ basePath: '/student' }).length === 0);

  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'Transactions queue their statements, and the bell lists every role the same way.'}`);
  process.exit(failures ? 1 : 0);
})().catch((error) => { console.error('ERROR', error.message, error.stack); process.exit(1); });
