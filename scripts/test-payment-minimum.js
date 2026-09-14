/**
 * File: scripts/test-payment-minimum.js
 * Purpose: Pin down the payment floor — ₱500 down, then a THIRD of whatever is
 *          still owed on each payment after it.
 *
 * Run:  node scripts/test-payment-minimum.js       (needs no database, no keys)
 *
 * WHY THIS EXISTS
 * The rule reads as one sentence and hides four traps, each of which quietly
 * locks a real student out of paying:
 *
 *   1. Applying the ₱500 floor to every payment. Someone owing ₱200 then has no
 *      legal amount to pay — the floor is above their balance and the balance
 *      caps them.
 *   2. Applying it to a bill below ₱500 for the same reason.
 *   3. Reading "has paid before" from the ledger alone. An account migrated from
 *      the old system can hold a real payment whose history rows were deleted
 *      along with the student (see the guard above the re-sync in sql/schema.sql).
 *      That student has paid, and must not be asked for a fresh down payment.
 *   4. Letting the instalment third round UP past the balance. On the last few
 *      pesos that would again leave no amount that is both "at least the floor"
 *      and "at most what is owed".
 *
 * `config/db` is replaced in the require cache before lib/billing.js loads, so
 * createPaymentRequest runs its REAL code path against a scripted database. The
 * pool is built lazily inside query(), so nothing ever dials out.
 */

let failures = 0;
const ok = (l, c, e = '') => {
  if (c) console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`);
  else { failures++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};

// --- the scripted database ------------------------------------------------
const db = { bill: null, ledgerPaid: 0, pending: [], inserted: [] };

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
    query: async (text, params) => {
      const sql = String(text).replace(/\s+/g, ' ');
      if (sql.includes('FROM billing')) return db.bill ? [db.bill] : [];
      if (sql.includes('FROM payment_entries')) return [{ paid: db.ledgerPaid }];
      if (sql.includes('FROM payment_requests')) return db.pending;
      if (sql.startsWith('INSERT INTO payment_requests')) {
        db.inserted.push(params);
        return { insertId: 99 };
      }
      return [];
    }
  }
};

const billing = require('../lib/billing');
const {
  minimumPaymentFor, hasPaidBefore, minimumPaymentError, createPaymentRequest,
  paymentFloorFor, remainingFor, cashPaymentLabel, studentPaymentMethodsFor
} = billing;

console.log('\n== the constants are the ones the office agreed ==');
ok('the down payment is 500', billing.FIRST_PAYMENT_MINIMUM === 500, `${billing.FIRST_PAYMENT_MINIMUM}`);
ok('anything above zero passes afterwards', billing.MIN_PAYMENT === 1, `${billing.MIN_PAYMENT}`);
ok('the balance is split three ways', billing.INSTALMENT_SPLIT === 3, `${billing.INSTALMENT_SPLIT}`);

console.log('\n== a brand new account ==');
const fresh = { id: 1, full_bill: 1800, partial_payment: 0 };
ok('has not paid before', hasPaidBefore(fresh, 0) === false);
ok('must put down 500', minimumPaymentFor(fresh, 0) === 500, `${minimumPaymentFor(fresh, 0)}`);
ok('and says so because it is the down payment', paymentFloorFor(fresh, 0).kind === 'down_payment');

console.log("\n== the office's own example: 1800 billed, 500 down ==");
ok('1300 is left', remainingFor(fresh, 500) === 1300, `${remainingFor(fresh, 500)}`);
ok('the next payment must be 434 (1300/3, rounded up)',
  minimumPaymentFor(fresh, 500) === 434, `${minimumPaymentFor(fresh, 500)}`);
ok('and it is an instalment, not a down payment', paymentFloorFor(fresh, 500).kind === 'instalment');
ok('a 20-peso top-up is now BELOW the floor', 20 < minimumPaymentFor(fresh, 500));
ok('paying the whole balance is still legal', 1300 >= minimumPaymentFor(fresh, 500));

console.log('\n== the third is recomputed from what is left, every time ==');
ok('after 500 + 434 the floor drops', minimumPaymentFor(fresh, 934) === 289, `${minimumPaymentFor(fresh, 934)}`);
ok('866 left splits into 289', remainingFor(fresh, 934) === 866);

console.log('\n== the third never rounds past the balance ==');
for (const left of [1, 2, 3, 4, 5, 7, 10, 100]) {
  const bill = { id: 9, full_bill: 1800, partial_payment: 1800 - left };
  const floor = minimumPaymentFor(bill, 1800 - left);
  ok(`with ₱${left} left the floor is payable`, floor <= left && floor >= 1, `floor ${floor}`);
}

console.log('\n== the migrated account whose history was deleted ==');
// billing #1 on live: records 500 paid, ledger cannot account for it.
const migrated = { id: 1, full_bill: 1800, partial_payment: 500 };
ok('counts as having paid', hasPaidBefore(migrated, 0) === true);
ok('is NOT asked for another down payment', paymentFloorFor(migrated, 0).kind === 'instalment');
ok('its ₱500 is not charged twice', remainingFor(migrated, 0) === 1300, `${remainingFor(migrated, 0)}`);
ok('so its floor is the instalment third', minimumPaymentFor(migrated, 0) === 434,
  `${minimumPaymentFor(migrated, 0)}`);

console.log('\n== a bill smaller than the down payment ==');
const small = { id: 2, full_bill: 300, partial_payment: 0 };
ok('the floor drops to what is owed', minimumPaymentFor(small, 0) === 300, `${minimumPaymentFor(small, 0)}`);
ok('the floor never exceeds the balance', minimumPaymentFor(small, 0) <= small.full_bill);
ok('paying it in full is legal', 300 >= minimumPaymentFor(small, 0));

console.log('\n== a settled account asks for nothing ==');
const settled = { id: 3, full_bill: 1800, partial_payment: 1800 };
ok('nothing remains', remainingFor(settled, 1800) === 0);

console.log('\n== the wording a student actually sees ==');
ok('the first payment is explained', /first payment/i.test(minimumPaymentError(500)));
ok('it names the instalments that follow', /three instalments/i.test(minimumPaymentError(500)));
const instalmentMsg = minimumPaymentError(paymentFloorFor(fresh, 500));
ok('the instalment refusal names the amount', /434\.00/.test(instalmentMsg), instalmentMsg);
ok('and explains it is a third', /one third/i.test(instalmentMsg));
ok('afterwards it just asks for a real number', minimumPaymentError(1) === 'Enter an amount greater than zero.');

console.log('\n== cash pay names the branch, wherever it is shown ==');
ok('main branch', cashPaymentLabel('MAIN BRANCH') === 'Cash Pay (at Main Branch)', cashPaymentLabel('MAIN BRANCH'));
ok('mabuhay branch', cashPaymentLabel('MABUHAY BRANCH') === 'Cash Pay (at Mabuhay Branch)', cashPaymentLabel('MABUHAY BRANCH'));
ok('no branch on file still reads sensibly', /your MindQuest branch/.test(cashPaymentLabel('')));
const methods = studentPaymentMethodsFor('BAWING BRANCH');
ok('the picker uses the same sentence',
  methods.find((m) => m.value === 'cash').label === 'Cash Pay (at Bawing Branch)');
ok('the constant itself is not mutated',
  billing.STUDENT_PAYMENT_METHODS.find((m) => m.value === 'cash').label === 'Cash Pay (at your MindQuest branch)');

// --- the real request path -------------------------------------------------
const student = { id: 7, first_name: 'Test', last_name: 'Student', branch_id: 1 };
const request = (amount) => createPaymentRequest({ student, amount, paymentMethod: 'cash' });
const refuse = async (amount) => {
  try { await request(amount); return null; } catch (e) { return e.message; }
};

(async () => {
  console.log('\n== createPaymentRequest, first payment ==');
  db.bill = { id: 1, full_bill: 1800, partial_payment: 0 };
  db.ledgerPaid = 0;
  db.pending = [];

  const short = await refuse(499);
  ok('499 is refused', short !== null, short || 'it went through');
  ok('the refusal names the 500', /500/.test(short || ''));

  db.inserted = [];
  const exact = await request(500);
  ok('500 is accepted', exact.id === 99 && exact.amount === 500);

  console.log('\n== createPaymentRequest, after the down payment ==');
  db.ledgerPaid = 500;
  db.bill = { id: 1, full_bill: 1800, partial_payment: 500 };
  db.pending = [];

  const tooSmall = await refuse(20);
  ok('20 is refused — it is under the third', tooSmall !== null, tooSmall || 'it went through');
  ok('the refusal names 434', /434/.test(tooSmall || ''), tooSmall || '');

  db.inserted = [];
  const instalment = await request(434);
  ok('434 is accepted', instalment.amount === 434, `${instalment.amount}`);
  ok('it was really written', db.inserted.length === 1);

  db.pending = [];
  db.inserted = [];
  const payAll = await request(1300);
  ok('clearing the whole balance is accepted', payAll.amount === 1300, `${payAll.amount}`);

  console.log('\n== zero and rubbish are still refused, always ==');
  ok('0 is refused on a fresh account', (await refuse(0)) !== null);
  db.ledgerPaid = 500;
  ok('0 is refused after paying too', (await refuse(0)) !== null);
  ok('text is refused', (await refuse('abc')) !== null);
  ok('a negative is refused', (await refuse(-100)) !== null);

  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'The down-payment rule holds.'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message, e.stack); process.exit(1); });
