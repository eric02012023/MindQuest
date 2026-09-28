/**
 * File: scripts/test-subject-pricing.js
 * Purpose: Pin down Phase 4 — ₱1,800 PER SUBJECT, and one independent month per
 *          subject.
 *
 * Run:  node scripts/test-subject-pricing.js      (needs no database, no keys)
 *
 * WHY THIS EXISTS
 * Both halves of this look obvious and both have a trap that costs real money:
 *
 *   1. Pricing is DERIVED (subjects × fee), not incremented. An "add ₱1,800 when
 *      a subject is added" implementation double-charges the moment any path
 *      runs twice — and there are three separate places a subject can be added.
 *      Deriving the total makes a repeat harmless.
 *   2. Re-pricing must never drop the bill below money already received, or
 *      un-enrolling a subject quietly erases a payment.
 *   3. The one-month cycle belongs to the SUBJECT, not the student. English on
 *      3 June and Filipino on 6 June end on 3 July and 6 July. Anchoring both to
 *      the student's first enrolment — the obvious shortcut — silently shortens
 *      or extends whatever was added later.
 *
 * config/db is replaced in the require cache before lib/data.js loads, so
 * recalculateStudentBilling runs its REAL code against a scripted database.
 */

let failures = 0;
const ok = (l, c, e = '') => {
  if (c) console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`);
  else { failures++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};

// --- the scripted database ------------------------------------------------
const db = {
  bill: null,        // the billing row
  subjectCount: 0,   // active user_subject_assignments
  nextEndDate: null, // MIN(end_date) across them
  ledgerPaid: 0,
  updates: [],       // every UPDATE billing, as its parameter list
  inserts: []        // every INSERT INTO billing, as its parameter list
};

const dbPath = require.resolve('../config/db');
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    sql: {},
    baseConfig: {},
    getPool: async () => { throw new Error('the test must never open a connection'); },
    withTransaction: async (work) => work({ query: async () => [[]] }),
    query: async (text, params = []) => {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      if (/^INSERT INTO billing/i.test(sql)) {
        db.inserts.push(params);
        db.bill = { id: 99, full_bill: params[1], partial_payment: 0 };
        return { insertId: 99, rowsAffected: [1] };
      }
      if (/^UPDATE billing/i.test(sql)) { db.updates.push(params); return []; }
      if (/FROM billing/i.test(sql)) return db.bill ? [db.bill] : [];
      if (/COUNT\(\*\) AS subject_count/i.test(sql)) {
        return [{ subject_count: db.subjectCount, next_end_date: db.nextEndDate }];
      }
      if (/FROM payment_entries/i.test(sql)) return [{ paid: db.ledgerPaid }];
      return [];
    }
  }
};

const { SUBJECT_MONTHLY_FEE, recalculateStudentBilling } = require('../lib/data');
const { plusOneMonth, todayDate } = require('../lib/utils');

/** Run a re-price against a scripted account and report what it wrote. */
async function reprice({ subjects, fullBill = 1800, partialPayment = 0, ledgerPaid = 0, nextEndDate = null }) {
  db.bill = { id: 7, full_bill: fullBill, partial_payment: partialPayment };
  db.subjectCount = subjects;
  db.ledgerPaid = ledgerPaid;
  db.nextEndDate = nextEndDate;
  db.updates = [];
  const result = await recalculateStudentBilling(null, 42);
  return { result, wrote: db.updates[0] || null };
}

(async () => {
  console.log('\n== the price the office set ==');
  ok('a subject costs 1800', SUBJECT_MONTHLY_FEE === 1800, `${SUBJECT_MONTHLY_FEE}`);

  console.log('\n== total = subjects x 1800 ==');
  for (const [subjects, expected] of [[1, 1800], [2, 3600], [3, 5400], [6, 10800]]) {
    const { result } = await reprice({ subjects });
    ok(`${subjects} subject${subjects === 1 ? '' : 's'} -> ${expected}`,
      result.fullBill === expected, `${result.fullBill}`);
  }

  console.log('\n== adding a subject adds exactly 1800, however often it runs ==');
  const one = await reprice({ subjects: 1 });
  const two = await reprice({ subjects: 2 });
  ok('the second subject adds 1800', two.result.fullBill - one.result.fullBill === 1800);
  const twoAgain = await reprice({ subjects: 2, fullBill: two.result.fullBill });
  ok('re-running the same change does NOT add it twice',
    twoAgain.result.fullBill === 3600, `${twoAgain.result.fullBill}`);

  console.log('\n== a payment is never erased by re-pricing ==');
  // Dropping from 3 subjects to 1 on an account that has already paid 4,000.
  const shrunk = await reprice({ subjects: 1, fullBill: 5400, ledgerPaid: 4000 });
  ok('the bill is held at what was paid, not cut to 1800',
    shrunk.result.fullBill === 4000, `${shrunk.result.fullBill}`);
  ok('so nothing is owed rather than a negative balance', shrunk.result.settlement === 0);
  ok('and the account reads as settled', shrunk.result.status === 'paid', shrunk.result.status);

  // The migrated account: partial_payment holds money the ledger cannot show.
  const migrated = await reprice({ subjects: 1, fullBill: 1800, partialPayment: 500, ledgerPaid: 0 });
  ok('a migrated payment still counts', migrated.result.paid === 500, `${migrated.result.paid}`);
  ok('and leaves 1300 owed', migrated.result.settlement === 1300, `${migrated.result.settlement}`);

  console.log('\n== an account with no active subject is left alone ==');
  const none = await reprice({ subjects: 0, fullBill: 1800 });
  ok('nothing is written', none.wrote === null);
  ok('the bill is not zeroed', none.result === null);

  console.log('\n== an enrolled student with no account gets one ==');
  // Enrolled from the profile (or created by staff) without ever passing
  // through registration acceptance: there was no billing row, so the student
  // was enrolled and never billed.
  db.bill = null;
  db.subjectCount = 2;
  db.ledgerPaid = 0;
  db.nextEndDate = '2026-10-28';
  db.updates = [];
  db.inserts = [];
  const opened = await recalculateStudentBilling(null, 42, 1);
  ok('a billing row is opened', db.inserts.length === 1, `${db.inserts.length} insert(s)`);
  ok('it is recorded as posted by whoever enrolled them', db.inserts[0] && db.inserts[0][4] === 1);
  ok('and priced from the enrolments, like any other account',
    opened && opened.fullBill === 3600, opened ? `${opened.fullBill}` : 'nothing returned');

  db.bill = null;
  db.subjectCount = 0;
  db.inserts = [];
  const nothing = await recalculateStudentBilling(null, 42, 1);
  ok('no subjects -> no account is opened', db.inserts.length === 0 && nothing === null);

  console.log('\n== status follows the money ==');
  ok('nothing paid -> unpaid', (await reprice({ subjects: 1 })).result.status === 'unpaid');
  ok('part paid -> partial', (await reprice({ subjects: 1, ledgerPaid: 800 })).result.status === 'partial');
  ok('fully paid -> paid', (await reprice({ subjects: 1, ledgerPaid: 1800 })).result.status === 'paid');

  console.log('\n== payment_due follows the SOONEST subject to expire ==');
  const due = await reprice({ subjects: 2, nextEndDate: '2026-07-03' });
  ok('the earliest end date is written as the due date',
    due.wrote && String(due.wrote[4]) === '2026-07-03', due.wrote ? String(due.wrote[4]) : 'nothing written');

  console.log("\n== each subject runs its own month (the office's example) ==");
  ok('English enrolled 3 June ends 3 July', plusOneMonth('2026-06-03') === '2026-07-03', plusOneMonth('2026-06-03'));
  ok('Filipino added 6 June ends 6 July', plusOneMonth('2026-06-06') === '2026-07-06', plusOneMonth('2026-06-06'));
  ok('the two cycles are genuinely different',
    plusOneMonth('2026-06-03') !== plusOneMonth('2026-06-06'));
  ok('a later subject is NOT cut short to the first one\'s end date',
    plusOneMonth('2026-06-06') > plusOneMonth('2026-06-03'));

  console.log('\n== month arithmetic that catches people out ==');
  ok('31 Jan -> 28 Feb (no 31st exists)', plusOneMonth('2026-01-31') === '2026-02-28', plusOneMonth('2026-01-31'));
  ok('31 Dec rolls the year', plusOneMonth('2026-12-31') === '2027-01-31', plusOneMonth('2026-12-31'));
  ok('29 Feb in a leap year', plusOneMonth('2028-02-29') === '2028-03-29', plusOneMonth('2028-02-29'));

  console.log('\n== the start date is a plain day, not a timestamp ==');
  ok('todayDate is YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(todayDate()), todayDate());
  ok('a cycle from today ends one month later',
    plusOneMonth(todayDate()) > todayDate());

  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'Subject pricing and per-subject cycles hold.'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message, e.stack); process.exit(1); });
