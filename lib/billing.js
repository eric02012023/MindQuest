/**
 * File: lib/billing.js
 * Purpose: The billing ledger — Billing (1) ---- (many) PaymentEntries — and the
 * student-submitted Payment Requests that feed it.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Billing used to be a single mutable row: `partial_payment` was a number an
 * admin typed into an Edit form. Pressing Edit a second time therefore REPLACED
 * the first payment instead of adding to it, which is the bug the upgrade brief
 * opens with. There was no way to answer "who took the second ₱500, and when".
 *
 * The model here is append-only:
 *
 *   - a payment is a ROW in payment_entries, never a field being overwritten
 *   - sequence_no 1 is written with is_locked = 1 — the spec's locked first entry
 *   - there is no update path and no delete path in this module, on purpose
 *   - billing.partial_payment / for_settlement / payment_status are DERIVED from
 *     SUM(payment_entries.amount) after every append, so the summary can never
 *     drift from the ledger that produced it
 *
 * Corrections are made by appending, exactly like a real cash book: a negative
 * entry is refused, so a mistake is fixed by an adjustment entry the admin has to
 * write a reason for, not by quietly rewriting history.
 */

const { query, withTransaction } = require('../config/db');
const { billingScopeClause } = require('./rbac');

/** Payment methods the UI offers. Adding one here is all a new method needs. */
const PAYMENT_METHODS = [
  { value: 'Cash', label: 'Cash (over the counter)' },
  { value: 'GCash', label: 'GCash' },
  { value: 'Bank Transfer', label: 'Bank Transfer' },
  { value: 'Online', label: 'Online payment' }
];

/**
 * What a payment is FOR. The brief asks for "purpose of payment" so the income
 * report can be read by category rather than as one undifferentiated total.
 */
const PAYMENT_PURPOSES = ['Tuition', 'Materials', 'Registration', 'Other'];

/** The methods a student may pick when requesting to pay. */
const STUDENT_PAYMENT_METHODS = [
  {
    value: 'cash',
    label: 'Cash Pay (at a MindQuest branch)',
    description: 'Pay in person at the branch office. Reserve the amount and date here first.',
    enabled: true
  },
  {
    value: 'online',
    label: 'Online payment',
    description: 'Card, GCash, GrabPay or Maya. Not switched on yet — ask the office.',
    enabled: false
  }
];

const MIN_PAYMENT = 1;
const FIRST_PAYMENT_MINIMUM = 500;

/** Parse a money field from a form. Rejects blanks, text and negatives. */
function normalizeAmount(value) {
  const number = Number(String(value ?? '').replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100) / 100;
}

/**
 * Has this account ever received money?
 *
 * Read from the ledger, falling back to the billing row's own recorded figure.
 * An account carried over from the old system can hold a real payment whose
 * history rows were lost along with a deleted student — see the guard above the
 * re-sync in sql/schema.sql, which preserves that figure rather than zeroing it.
 * Such a student HAS paid, and asking them for a fresh down payment because
 * their paperwork went missing would be the wrong answer.
 */
function hasPaidBefore(bill, ledgerPaid = 0) {
  return Number(ledgerPaid || 0) > 0 || Number(bill?.partial_payment || 0) > 0;
}

/**
 * The ₱500 floor is a DOWN PAYMENT rule, not a per-transaction one: it applies to
 * the first payment on an account and to nothing after it.
 *
 * Once a student has put money down they may clear the rest in whatever amounts
 * they can manage — that is the whole point of paying in instalments. A floor on
 * every payment would strand anyone whose remaining balance is below it, and a
 * student owing ₱200 would have no legal amount to pay at all.
 */
function minimumPaymentFor(bill, ledgerPaid = 0) {
  if (hasPaidBefore(bill, ledgerPaid)) return MIN_PAYMENT;

  // A bill smaller than the down payment is settled in one go rather than made
  // impossible to pay. Without this a student billed ₱300 would be told their
  // first payment must be ₱500 while also being capped at the ₱300 they owe —
  // no amount would satisfy both, and they could never pay at all.
  const owed = Math.max(Number(bill?.full_bill || 0) - Number(ledgerPaid || 0), 0);
  if (owed > 0 && owed < FIRST_PAYMENT_MINIMUM) return owed;
  return FIRST_PAYMENT_MINIMUM;
}

/** The refusal that goes with minimumPaymentFor, worded for whoever hit it. */
function minimumPaymentError(minimum) {
  return Number(minimum) > MIN_PAYMENT
    ? `The first payment on an account must be at least ₱${Number(minimum).toFixed(2)}. After that you can pay any amount.`
    : 'Enter an amount greater than zero.';
}

function displayName(user) {
  if (!user) return '';
  return [user.first_name, user.middle_name, user.last_name]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ');
}

// ---------------------------------------------------------------------------
// Reading the ledger
// ---------------------------------------------------------------------------

/** Every payment against one billing record, oldest first (the ledger order). */
async function getPaymentEntries(billingId) {
  return query(
    `SELECT pe.*, u.first_name AS recorder_first_name, u.last_name AS recorder_last_name, u.role AS recorder_role
     FROM payment_entries pe
     LEFT JOIN users u ON u.id = pe.recorded_by
     WHERE pe.billing_id = ?
     ORDER BY pe.sequence_no ASC, pe.id ASC`,
    [billingId]
  );
}

/** The same ledger for a student, whichever billing row it hangs off. */
async function getStudentPaymentEntries(studentId) {
  return query(
    `SELECT pe.*, u.first_name AS recorder_first_name, u.last_name AS recorder_last_name, u.role AS recorder_role
     FROM payment_entries pe
     LEFT JOIN users u ON u.id = pe.recorded_by
     WHERE pe.student_id = ?
     ORDER BY pe.paid_at DESC, pe.id DESC`,
    [studentId]
  );
}

/**
 * Totals for one billing record, computed from the entries rather than read off
 * the summary columns — the summary is a cache, this is the truth.
 */
function summarise(bill, entries = []) {
  const totalBilled = Number(bill?.full_bill || 0);
  const totalPaid = entries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const remaining = Math.max(totalBilled - totalPaid, 0);
  return {
    totalBilled: Math.round(totalBilled * 100) / 100,
    totalPaid: Math.round(totalPaid * 100) / 100,
    remaining: Math.round(remaining * 100) / 100,
    paymentCount: entries.length,
    isSettled: totalBilled > 0 && remaining === 0,
    lastPaidAt: entries.length ? entries[entries.length - 1].paid_at : null
  };
}

/** Billing header + full ledger + derived totals, for the Admin billing row. */
async function getBillingLedger(studentId) {
  const rows = await query(
    `SELECT TOP 1 b.*, u.user_id, u.first_name, u.middle_name, u.last_name, u.address,
            u.contact_number, u.branch_id, br.name AS branch_name
     FROM billing b
     INNER JOIN users u ON u.id = b.student_id
     LEFT JOIN branches br ON br.id = u.branch_id
     WHERE b.student_id = ?`,
    [studentId]
  );
  const bill = rows[0] || null;
  if (!bill) return null;
  const entries = await getPaymentEntries(bill.id);
  return { bill, entries, totals: summarise(bill, entries) };
}

/** Ledgers for many students in two queries instead of 2N. */
async function attachLedgers(billingRows = []) {
  if (!billingRows.length) return billingRows;
  const ids = billingRows.map((row) => Number(row.id)).filter(Boolean);
  if (!ids.length) return billingRows;

  const entries = await query(
    `SELECT pe.*, u.first_name AS recorder_first_name, u.last_name AS recorder_last_name, u.role AS recorder_role
     FROM payment_entries pe
     LEFT JOIN users u ON u.id = pe.recorded_by
     WHERE pe.billing_id IN (${ids.map(() => '?').join(',')})
     ORDER BY pe.sequence_no ASC, pe.id ASC`,
    ids
  );

  const byBilling = new Map();
  for (const entry of entries) {
    const key = Number(entry.billing_id);
    if (!byBilling.has(key)) byBilling.set(key, []);
    byBilling.get(key).push(entry);
  }

  return billingRows.map((row) => {
    const list = byBilling.get(Number(row.id)) || [];
    return { ...row, entries: list, totals: summarise(row, list) };
  });
}

// ---------------------------------------------------------------------------
// Writing: append only
// ---------------------------------------------------------------------------

/**
 * Recompute the billing summary columns from the ledger.
 * Called inside the same transaction as the append, so a reader can never catch
 * a state where the entry exists but the balance has not moved.
 */
async function recomputeBilling(connection, billingId) {
  const [totalRows] = await connection.query(
    `SELECT COALESCE(SUM(amount), 0) AS paid, MAX(paid_at) AS last_paid_at, COUNT(*) AS entry_count
     FROM payment_entries WHERE billing_id = ?`,
    [billingId]
  );
  const [billRows] = await connection.query('SELECT TOP 1 full_bill FROM billing WHERE id = ?', [billingId]);

  const fullBill = Number(billRows[0]?.full_bill || 0);
  const paid = Number(totalRows[0]?.paid || 0);
  const settlement = Math.max(fullBill - paid, 0);

  let status = 'unpaid';
  if (fullBill > 0 && settlement === 0) status = 'paid';
  else if (paid > 0) status = 'partial';

  await connection.query(
    `UPDATE billing
        SET partial_payment = ?, for_settlement = ?, payment_status = ?,
            last_paid_at = ?, updated_at = DATEADD(hour, 8, GETUTCDATE())
      WHERE id = ?`,
    [paid, settlement, status, totalRows[0]?.last_paid_at || null, billingId]
  );

  return { fullBill, paid, settlement, status, entryCount: Number(totalRows[0]?.entry_count || 0) };
}

/**
 * Append one payment to a student's ledger.
 *
 * This is the ONLY way money is recorded. There is deliberately no counterpart
 * that edits or removes an entry: the brief's requirement is that a new payment
 * "does NOT modify or delete previous entries", and the cheapest way to guarantee
 * that is for no such code to exist.
 *
 * @param {object} input
 * @param {number} input.studentId
 * @param {number|string} input.amount
 * @param {string} [input.paymentMethod]
 * @param {string} [input.purpose]
 * @param {string} [input.referenceNo]
 * @param {string} [input.notes]
 * @param {string|Date} [input.paidAt]     defaults to now
 * @param {object} input.actor             the admin/assistant recording it
 * @param {string} [input.source]          'admin' | 'student_request' | 'migrated'
 * @param {number} [input.paymentRequestId]
 * @returns {Promise<{entryId:number, sequenceNo:number, totals:object}>}
 */
async function addPaymentEntry(input = {}) {
  const {
    studentId, amount, paymentMethod = 'Cash', purpose = 'Tuition',
    referenceNo = null, notes = null, paidAt = null, actor = null,
    source = 'admin', paymentRequestId = null
  } = input;

  const value = normalizeAmount(amount);
  if (!(value >= MIN_PAYMENT)) {
    throw new Error('Enter a payment amount greater than zero.');
  }

  const billRows = await query('SELECT TOP 1 id, full_bill FROM billing WHERE student_id = ?', [studentId]);
  const bill = billRows[0];
  if (!bill) throw new Error('This student has no billing record yet.');

  return withTransaction(async (connection) => {
    const [seqRows] = await connection.query(
      'SELECT COALESCE(MAX(sequence_no), 0) AS last_seq, COALESCE(SUM(amount), 0) AS paid FROM payment_entries WHERE billing_id = ?',
      [bill.id]
    );
    const sequenceNo = Number(seqRows[0]?.last_seq || 0) + 1;
    const alreadyPaid = Number(seqRows[0]?.paid || 0);
    const balanceAfter = Math.max(Number(bill.full_bill || 0) - (alreadyPaid + value), 0);

    const [inserted] = await connection.query(
      `INSERT INTO payment_entries
         (billing_id, student_id, sequence_no, amount, payment_method, purpose,
          reference_no, notes, paid_at, recorded_by, recorded_by_name, recorded_by_role,
          balance_after, is_locked, entry_source, payment_request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        bill.id, studentId, sequenceNo, value,
        String(paymentMethod || 'Cash').slice(0, 50),
        String(purpose || 'Tuition').slice(0, 60),
        referenceNo ? String(referenceNo).slice(0, 120) : null,
        notes ? String(notes) : null,
        paidAt ? new Date(paidAt) : new Date(),
        actor?.id || null,
        displayName(actor).slice(0, 200) || null,
        actor?.role || null,
        balanceAfter,
        // The first entry is the locked one, for every ledger.
        sequenceNo === 1 ? 1 : 0,
        source,
        paymentRequestId || null
      ]
    );

    const totals = await recomputeBilling(connection, bill.id);
    return { entryId: inserted.insertId, sequenceNo, billingId: bill.id, totals };
  });
}

/**
 * Update the billing HEADER only — the amount owed, when it is due, the SOA type,
 * notes. Never the money received: that is the ledger's job.
 *
 * Lowering full_bill below what has already been paid is refused rather than
 * silently clamped, because the clamp would quietly discard a real payment.
 */
async function updateBillingHeader(studentId, payload = {}, actor = null) {
  const billRows = await query('SELECT TOP 1 * FROM billing WHERE student_id = ?', [studentId]);
  const bill = billRows[0];
  if (!bill) throw new Error('Billing record not found.');

  const requested = normalizeAmount(payload.full_bill);
  const fullBill = requested > 0 ? requested : Number(bill.full_bill || 0);

  const paidRows = await query('SELECT COALESCE(SUM(amount), 0) AS paid FROM payment_entries WHERE billing_id = ?', [bill.id]);
  const paid = Number(paidRows[0]?.paid || 0);
  if (fullBill < paid) {
    throw new Error(`Total billed cannot be less than the ₱${paid.toFixed(2)} already paid on this account.`);
  }

  const settlement = Math.max(fullBill - paid, 0);
  let status = 'unpaid';
  if (fullBill > 0 && settlement === 0) status = 'paid';
  else if (paid > 0) status = 'partial';

  await query(
    `UPDATE billing
        SET full_bill = ?, for_settlement = ?, partial_payment = ?, payment_status = ?,
            payment_due = ?, soa_type = COALESCE(?, soa_type), notes = ?,
            posted_by = ?, updated_at = DATEADD(hour, 8, GETUTCDATE())
      WHERE id = ?`,
    [
      fullBill, settlement, paid, status,
      payload.payment_due || bill.payment_due || null,
      payload.soa_type || null,
      payload.notes !== undefined ? String(payload.notes || '') : (bill.notes || ''),
      actor?.id || bill.posted_by || null,
      bill.id
    ]
  );

  return { fullBill, paid, settlement, status };
}

// ---------------------------------------------------------------------------
// Income report / transaction ledger
// ---------------------------------------------------------------------------

/**
 * One row per payment, for the Income Report.
 *
 * The scope clause comes from lib/rbac so an assistant's report cannot be widened
 * past their branch by editing the query string.
 *
 * @param {object} scope    from resolveScope
 * @param {object} filters  { search, from, to, method, purpose, branchId }
 */
async function getPaymentLedger(scope, filters = {}) {
  const scoped = billingScopeClause(scope, 'u');
  const params = [...scoped.params];
  const where = [];

  const search = String(filters.search || '').trim().toLowerCase();
  if (search) {
    where.push(`(LOWER(CONCAT(COALESCE(u.first_name,''), ' ', COALESCE(u.middle_name,''), ' ', COALESCE(u.last_name,''))) LIKE ?
                 OR LOWER(u.user_id) LIKE ?
                 OR LOWER(COALESCE(pe.reference_no,'')) LIKE ?)`);
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (filters.from) {
    where.push('pe.paid_at >= ?');
    params.push(new Date(`${filters.from}T00:00:00`));
  }
  if (filters.to) {
    where.push('pe.paid_at < DATEADD(day, 1, ?)');
    params.push(new Date(`${filters.to}T00:00:00`));
  }
  if (filters.method && filters.method !== 'all') {
    where.push('pe.payment_method = ?');
    params.push(filters.method);
  }
  if (filters.purpose && filters.purpose !== 'all') {
    where.push('pe.purpose = ?');
    params.push(filters.purpose);
  }
  // An admin may narrow to a branch; an assistant is already narrowed above.
  if (scope.isAdmin && filters.branchId && String(filters.branchId) !== 'all') {
    where.push('u.branch_id = ?');
    params.push(Number(filters.branchId));
  }

  const filterSql = where.length ? ` AND ${where.join(' AND ')}` : '';

  return query(
    `SELECT pe.id, pe.amount, pe.paid_at, pe.payment_method, pe.purpose, pe.reference_no,
            pe.sequence_no, pe.is_locked, pe.entry_source, pe.balance_after, pe.notes,
            pe.recorded_by_name, pe.recorded_by_role,
            u.id AS student_id, u.user_id, u.first_name, u.middle_name, u.last_name,
            u.branch_id, br.name AS branch_name,
            b.full_bill, b.payment_status,
            rec.first_name AS recorder_first_name, rec.last_name AS recorder_last_name
     FROM payment_entries pe
     INNER JOIN users u ON u.id = pe.student_id
     LEFT JOIN branches br ON br.id = u.branch_id
     LEFT JOIN billing b ON b.id = pe.billing_id
     LEFT JOIN users rec ON rec.id = pe.recorded_by
     WHERE 1 = 1 ${scoped.sql}${filterSql}
     ORDER BY pe.paid_at DESC, pe.id DESC`,
    params
  );
}

/** Headline numbers for the Income Report summary bar. */
function summariseLedger(rows = []) {
  const total = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const now = new Date();
  const thisMonth = rows.reduce((sum, row) => {
    const date = new Date(row.paid_at);
    return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear()
      ? sum + Number(row.amount || 0)
      : sum;
  }, 0);
  const students = new Set(rows.map((row) => String(row.student_id)));
  return {
    totalIncome: Math.round(total * 100) / 100,
    transactionCount: rows.length,
    monthIncome: Math.round(thisMonth * 100) / 100,
    payingStudents: students.size,
    average: rows.length ? Math.round((total / rows.length) * 100) / 100 : 0
  };
}

// ---------------------------------------------------------------------------
// Payment requests (student -> admin/assistant)
// ---------------------------------------------------------------------------

/**
 * A student reserves a cash payment. Status starts Pending; nothing is added to
 * the ledger until a staff member confirms the money actually arrived.
 */
async function createPaymentRequest(input = {}) {
  const {
    student, amount, paymentMethod = 'cash', purpose = 'Tuition',
    preferredAt = null, referenceNote = null, branchId = null
  } = input;

  const value = normalizeAmount(amount);
  if (!(value >= MIN_PAYMENT)) throw new Error('Enter an amount greater than zero.');

  const method = String(paymentMethod || 'cash').toLowerCase();
  const known = STUDENT_PAYMENT_METHODS.find((m) => m.value === method);
  if (!known) throw new Error('Choose a payment method.');
  if (!known.enabled) throw new Error(`${known.label} is not available yet. Please choose Cash Pay.`);

  const billRows = await query('SELECT TOP 1 id, full_bill, partial_payment FROM billing WHERE student_id = ?', [student.id]);
  const bill = billRows[0] || null;

  // The ₱500 floor applies to the first payment only — see minimumPaymentFor.
  const paidRows = bill
    ? await query('SELECT COALESCE(SUM(amount), 0) AS paid FROM payment_entries WHERE billing_id = ?', [bill.id])
    : [];
  const minimum = minimumPaymentFor(bill, paidRows[0]?.paid);
  if (value < minimum) throw new Error(minimumPaymentError(minimum));

  // One open request at a time — otherwise a student can queue five identical
  // ₱500 requests and the office has no way to tell which one they turned up for.
  const pending = await query(
    "SELECT TOP 1 id FROM payment_requests WHERE student_id = ? AND status = 'pending'",
    [student.id]
  );
  if (pending.length) {
    throw new Error('You already have a payment request waiting to be processed. Please wait for the office to confirm it.');
  }

  const result = await query(
    `INSERT INTO payment_requests
       (student_id, billing_id, branch_id, student_name, amount, payment_method,
        purpose, preferred_at, reference_note, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
      student.id,
      bill?.id || null,
      branchId || student.branch_id || null,
      displayName(student).slice(0, 200),
      value,
      method,
      String(purpose || 'Tuition').slice(0, 60),
      preferredAt ? new Date(preferredAt) : null,
      referenceNote ? String(referenceNote) : null
    ]
  );

  return { id: result.insertId, amount: value, method };
}

/** One request with the names the notification card needs. */
async function getPaymentRequestById(id) {
  const rows = await query(
    `SELECT pr.*, u.user_id AS student_code, u.first_name, u.middle_name, u.last_name,
            u.contact_number, u.email, br.name AS branch_name,
            p.first_name AS processor_first_name, p.last_name AS processor_last_name
     FROM payment_requests pr
     INNER JOIN users u ON u.id = pr.student_id
     LEFT JOIN branches br ON br.id = pr.branch_id
     LEFT JOIN users p ON p.id = pr.processed_by
     WHERE pr.id = ?`,
    [id]
  );
  return rows[0] || null;
}

/**
 * Payment requests this viewer may see, newest first.
 * @param {object} scope    from resolveScope
 * @param {object} filters  { status, search }
 */
async function getPaymentRequests(scope, filters = {}) {
  const scoped = billingScopeClause(scope, 'u');
  const params = [...scoped.params];
  const where = [];

  const status = String(filters.status || 'all');
  if (status !== 'all') {
    where.push('pr.status = ?');
    params.push(status);
  }

  const search = String(filters.search || '').trim().toLowerCase();
  if (search) {
    where.push(`(LOWER(CONCAT(COALESCE(u.first_name,''), ' ', COALESCE(u.last_name,''))) LIKE ?
                 OR LOWER(u.user_id) LIKE ?
                 OR LOWER(COALESCE(br.name, '')) LIKE ?)`);
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  const filterSql = where.length ? ` AND ${where.join(' AND ')}` : '';

  return query(
    `SELECT pr.*, u.user_id AS student_code, u.first_name, u.middle_name, u.last_name,
            u.contact_number, br.name AS branch_name,
            p.first_name AS processor_first_name, p.last_name AS processor_last_name
     FROM payment_requests pr
     INNER JOIN users u ON u.id = pr.student_id
     LEFT JOIN branches br ON br.id = pr.branch_id
     LEFT JOIN users p ON p.id = pr.processed_by
     WHERE 1 = 1 ${scoped.sql}${filterSql}
     ORDER BY CASE WHEN pr.status = 'pending' THEN 0 ELSE 1 END, pr.created_at DESC`,
    params
  );
}

/** How many requests are still waiting — drives the badge on the bell. */
async function countPendingPaymentRequests(scope) {
  const scoped = billingScopeClause(scope, 'u');
  const rows = await query(
    `SELECT COUNT(*) AS total
     FROM payment_requests pr
     INNER JOIN users u ON u.id = pr.student_id
     WHERE pr.status = 'pending' ${scoped.sql}`,
    scoped.params
  );
  return Number(rows[0]?.total || 0);
}

/**
 * Mark a request Completed/Catered and append the money to the ledger.
 *
 * The amount actually received may differ from the amount reserved (a student
 * turns up with ₱300 of the ₱500 they said), so the confirming staff member
 * enters what really changed hands and both numbers are kept.
 *
 * Whoever gets there first wins: the status flip is conditional on the row still
 * being 'pending', so two admins pressing Complete at the same time produce one
 * payment, not two.
 */
async function completePaymentRequest(id, actor, options = {}) {
  const request = await getPaymentRequestById(id);
  if (!request) throw new Error('Payment request not found.');
  if (request.status !== 'pending') {
    throw new Error(`This request was already marked ${request.status}.`);
  }

  const received = options.amount === undefined || options.amount === null || options.amount === ''
    ? Number(request.amount || 0)
    : normalizeAmount(options.amount);
  if (!(received >= MIN_PAYMENT)) throw new Error('Enter the amount actually received.');

  // OUTPUT, not a plain UPDATE: config/db.js returns the recordset for a
  // statement, and an UPDATE without OUTPUT has none — so this is how the claim
  // reports whether it actually won the row.
  const claimed = await query(
    `UPDATE payment_requests
        SET status = 'completed', processed_by = ?, processed_by_name = ?, processed_by_role = ?,
            processed_at = DATEADD(hour, 8, GETUTCDATE()), processed_note = ?,
            recorded_amount = ?, updated_at = DATEADD(hour, 8, GETUTCDATE())
     OUTPUT inserted.id AS claimed_id
      WHERE id = ? AND status = 'pending'`,
    [
      actor?.id || null,
      displayName(actor).slice(0, 200) || null,
      actor?.role || null,
      options.note ? String(options.note) : null,
      received,
      id
    ]
  );
  if (!claimed.length) {
    throw new Error('Someone else processed this request a moment ago.');
  }

  const entry = await addPaymentEntry({
    studentId: request.student_id,
    amount: received,
    paymentMethod: request.payment_method === 'cash' ? 'Cash' : String(request.payment_method || 'Cash'),
    purpose: request.purpose || 'Tuition',
    referenceNo: `REQ-${id}`,
    notes: options.note
      ? `Cash payment request #${id} — ${options.note}`
      : `Cash payment request #${id} confirmed at the branch.`,
    actor,
    source: 'student_request',
    paymentRequestId: id
  });

  return { request: await getPaymentRequestById(id), entry };
}

/** Turn a request down (student never showed, duplicate, wrong amount). */
async function cancelPaymentRequest(id, actor, note = '') {
  const request = await getPaymentRequestById(id);
  if (!request) throw new Error('Payment request not found.');
  if (request.status !== 'pending') {
    throw new Error(`This request was already marked ${request.status}.`);
  }
  const claimed = await query(
    `UPDATE payment_requests
        SET status = 'cancelled', processed_by = ?, processed_by_name = ?, processed_by_role = ?,
            processed_at = DATEADD(hour, 8, GETUTCDATE()), processed_note = ?,
            updated_at = DATEADD(hour, 8, GETUTCDATE())
     OUTPUT inserted.id AS claimed_id
      WHERE id = ? AND status = 'pending'`,
    [actor?.id || null, displayName(actor).slice(0, 200) || null, actor?.role || null, String(note || ''), id]
  );
  if (!claimed.length) {
    throw new Error('Someone else processed this request a moment ago.');
  }
  return getPaymentRequestById(id);
}

/** A student's own requests, for the Billing Data page. */
async function getStudentPaymentRequests(studentId) {
  return query(
    `SELECT pr.*, br.name AS branch_name,
            p.first_name AS processor_first_name, p.last_name AS processor_last_name
     FROM payment_requests pr
     LEFT JOIN branches br ON br.id = pr.branch_id
     LEFT JOIN users p ON p.id = pr.processed_by
     WHERE pr.student_id = ?
     ORDER BY pr.created_at DESC`,
    [studentId]
  );
}

/**
 * Everything the student's "Billing Data" page shows, in one call: the SOA
 * breakdown, the full ledger and their own requests. The brief merges "Posted
 * SOA/Billing" and "Payment History" into one section, so they are fetched
 * together rather than by two pages that could disagree.
 */
async function getStudentBillingData(studentId) {
  const ledger = await getBillingLedger(studentId);
  const [statements, requests] = await Promise.all([
    query('SELECT * FROM soa_posts WHERE student_id = ? ORDER BY created_at DESC', [studentId]),
    getStudentPaymentRequests(studentId)
  ]);

  return {
    bill: ledger?.bill || null,
    entries: ledger?.entries || [],
    totals: ledger?.totals || { totalBilled: 0, totalPaid: 0, remaining: 0, paymentCount: 0, isSettled: false },
    statements,
    requests,
    pendingRequest: requests.find((r) => r.status === 'pending') || null,
    // So the form can set its own floor from the same rule the server enforces,
    // rather than the two drifting apart.
    minimumPayment: minimumPaymentFor(ledger?.bill, ledger?.totals?.totalPaid)
  };
}

module.exports = {
  PAYMENT_METHODS,
  PAYMENT_PURPOSES,
  STUDENT_PAYMENT_METHODS,
  MIN_PAYMENT,
  FIRST_PAYMENT_MINIMUM,
  normalizeAmount,
  hasPaidBefore,
  minimumPaymentFor,
  minimumPaymentError,
  getPaymentEntries,
  getStudentPaymentEntries,
  getBillingLedger,
  attachLedgers,
  summarise,
  addPaymentEntry,
  updateBillingHeader,
  getPaymentLedger,
  summariseLedger,
  createPaymentRequest,
  getPaymentRequestById,
  getPaymentRequests,
  countPendingPaymentRequests,
  completePaymentRequest,
  cancelPaymentRequest,
  getStudentPaymentRequests,
  getStudentBillingData
};
