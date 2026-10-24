

const { query, withTransaction } = require('../config/db');
const { billingScopeClause } = require('./rbac');
const { titleCaseName } = require('./utils');


const PAYMENT_METHODS = [
  { value: 'Cash', label: 'Cash (over the counter)' },
  { value: 'GCash', label: 'GCash' },
  { value: 'Maya', label: 'Maya' },
  { value: 'GrabPay', label: 'GrabPay' },
  { value: 'Card', label: 'Credit / debit card' },
  { value: 'Bank Transfer', label: 'Bank Transfer' }
];


const ONLINE_METHOD_LABELS = {
  gcash: 'GCash',
  paymaya: 'Maya',
  maya: 'Maya',
  grab_pay: 'GrabPay',
  card: 'Card'
};


function onlineMethodLabel(gatewayType) {
  const key = String(gatewayType || '').trim().toLowerCase();
  return ONLINE_METHOD_LABELS[key] || null;
}


const PAYMENT_PURPOSES = ['Tuition', 'Materials', 'Registration', 'Other'];


function cashPaymentLabel(branchName) {
  const branch = titleCaseName(branchName || '');
  return branch ? `Cash Pay (at ${branch})` : 'Cash Pay (at your MindQuest branch)';
}


function cashPaymentDescription(branchName) {
  const branch = titleCaseName(branchName || '');
  return branch
    ? `Pay in person at ${branch}. Show your payment slip at the counter and the office records it there.`
    : 'Pay in person at your branch. Show your payment slip at the counter and the office records it there.';
}


const STUDENT_PAYMENT_METHODS = [
  {
    value: 'cash',
    label: cashPaymentLabel(''),
    description: cashPaymentDescription(''),
    enabled: true
  },
  {
    value: 'online',
    label: 'Online payment',
    description: 'Card, GCash, GrabPay or Maya. Paid now — your balance updates once it clears.',
    enabled: true
  }
];


function studentPaymentMethodsFor(branchName) {
  return STUDENT_PAYMENT_METHODS.map((method) => (
    method.value === 'cash'
      ? { ...method, label: cashPaymentLabel(branchName), description: cashPaymentDescription(branchName) }
      : { ...method }
  ));
}

const MIN_PAYMENT = 1;
const FIRST_PAYMENT_MINIMUM = 500;


const SUBJECT_MONTHLY_FEE = 1800;


const INSTALMENT_SPLIT = 3;


function normalizeAmount(value) {
  const number = Number(String(value ?? '').replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100) / 100;
}


function hasPaidBefore(bill, ledgerPaid = 0) {
  return Number(ledgerPaid || 0) > 0 || Number(bill?.partial_payment || 0) > 0;
}


function remainingFor(bill, ledgerPaid = 0) {
  const billed = Number(bill?.full_bill || 0);
  const paid = Math.max(Number(ledgerPaid || 0), Number(bill?.partial_payment || 0));
  return Math.max(Math.round((billed - paid) * 100) / 100, 0);
}


function instalmentMinimumFor(bill, ledgerPaid = 0) {
  const remaining = remainingFor(bill, ledgerPaid);
  if (remaining <= 0) return 0;
  const billed = Number(bill?.full_bill || 0);
  return Math.min(Math.ceil(billed / INSTALMENT_SPLIT), remaining);
}


function paymentFloorFor(bill, ledgerPaid = 0) {
  const remaining = remainingFor(bill, ledgerPaid);

  const billed = Number(bill?.full_bill || 0);

  if (hasPaidBefore(bill, ledgerPaid)) {
    return {
      amount: Math.max(instalmentMinimumFor(bill, ledgerPaid), MIN_PAYMENT),
      kind: 'instalment',
      remaining,
      billed,
      split: INSTALMENT_SPLIT
    };
  }

  const amount = remaining > 0 && remaining < FIRST_PAYMENT_MINIMUM ? remaining : FIRST_PAYMENT_MINIMUM;
  return { amount, kind: 'down_payment', remaining, billed, split: INSTALMENT_SPLIT };
}


function minimumPaymentFor(bill, ledgerPaid = 0) {
  return paymentFloorFor(bill, ledgerPaid).amount;
}


function peso(value) {
  return `₱${Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}


function overpaymentError(amount, remaining, options = {}) {
  const forStudent = options.audience === 'student';
  if (!(Number(remaining) > 0)) {
    return forStudent
      ? 'Your account is already fully paid — there is nothing left to pay.'
      : 'This account is already fully paid — there is nothing left to pay.';
  }
  return forStudent
    ? `${peso(amount)} is more than your remaining balance of ${peso(remaining)}. `
      + `Please enter the exact amount: ${peso(remaining)}.`
    : `${peso(amount)} is more than the remaining balance of ${peso(remaining)}. `
      + `Enter the exact amount (${peso(remaining)}) or less.`;
}


function exceedsBalance(amount, remaining) {
  return Math.round(Number(amount || 0) * 100) > Math.round(Number(remaining || 0) * 100);
}


function minimumPaymentError(floor) {
  const detail = typeof floor === 'object' && floor !== null ? floor : { amount: floor, kind: 'down_payment' };
  const amount = Number(detail.amount || 0);
  if (!(amount > MIN_PAYMENT)) return 'Enter an amount greater than zero.';

  if (detail.kind === 'instalment') {
    if (Number(detail.remaining || 0) <= amount) {
      return `The next payment must be the full ₱${amount.toFixed(2)} still owed — `
        + 'it is the last instalment on this account.';
    }
    return `The next payment must be at least ₱${amount.toFixed(2)} — one third of the `
      + `₱${Number(detail.billed || 0).toFixed(2)} bill, so the balance is cleared in at most three payments after the first.`;
  }
  return `The first payment on an account must be at least ₱${amount.toFixed(2)}. `
    + 'After that the balance is paid in three instalments.';
}


async function getDownPaymentStatus(studentId) {
  const rows = await query(
    `SELECT TOP 1 b.id, b.full_bill, b.partial_payment,
            (SELECT COALESCE(SUM(pe.amount), 0) FROM payment_entries pe WHERE pe.billing_id = b.id) AS ledger_paid
       FROM billing b
      WHERE b.student_id = ?`,
    [studentId]
  );
  const bill = rows[0] || null;

  const paid = bill
    ? Math.max(Number(bill.ledger_paid || 0), Number(bill.partial_payment || 0))
    : 0;
  const billed = Number(bill?.full_bill || 0);

  
  
  
  const required = billed > 0 ? Math.min(FIRST_PAYMENT_MINIMUM, billed) : FIRST_PAYMENT_MINIMUM;

  return {
    hasBill: Boolean(bill),
    paid: Math.round(paid * 100) / 100,
    billed,
    required,
    satisfied: paid >= required,
    shortfall: Math.round(Math.max(required - paid, 0) * 100) / 100
  };
}


function downPaymentBlockMessage(status) {
  const required = Number(status?.required || FIRST_PAYMENT_MINIMUM).toFixed(2);
  if (!status?.hasBill) {
    return `A ₱${required} down payment is required before the Pre-Assessment. `
      + 'Your account has not been billed yet — please contact the office.';
  }
  return `Pay at least ₱${required} of your tuition before taking the Pre-Assessment. `
    + `You have paid ₱${Number(status.paid || 0).toFixed(2)}, so ₱${Number(status.shortfall || 0).toFixed(2)} is still needed. `
    + 'Open Billing Data to pay.';
}

function displayName(user) {
  if (!user) return '';
  return [user.first_name, user.middle_name, user.last_name]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ');
}




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


async function addPaymentEntry(input = {}) {
  const {
    studentId, amount, paymentMethod = 'Cash', purpose = 'Tuition',
    referenceNo = null, notes = null, paidAt = null, actor = null,
    source = 'admin', paymentRequestId = null, allowOverpayment = false
  } = input;

  const value = normalizeAmount(amount);
  if (!(value >= MIN_PAYMENT)) {
    throw new Error('Enter a payment amount greater than zero.');
  }

  const billRows = await query('SELECT TOP 1 id, full_bill, partial_payment FROM billing WHERE student_id = ?', [studentId]);
  const bill = billRows[0];
  if (!bill) throw new Error('This student has no billing record yet.');

  return withTransaction(async (connection) => {
    const [seqRows] = await connection.query(
      'SELECT COALESCE(MAX(sequence_no), 0) AS last_seq, COALESCE(SUM(amount), 0) AS paid FROM payment_entries WHERE billing_id = ?',
      [bill.id]
    );
    const sequenceNo = Number(seqRows[0]?.last_seq || 0) + 1;
    const alreadyPaid = Number(seqRows[0]?.paid || 0);

    
    
    
    const remaining = remainingFor(bill, alreadyPaid);
    if (!allowOverpayment && exceedsBalance(value, remaining)) {
      throw new Error(overpaymentError(value, remaining));
    }

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
        
        sequenceNo === 1 ? 1 : 0,
        source,
        paymentRequestId || null
      ]
    );

    const totals = await recomputeBilling(connection, bill.id);
    return { entryId: inserted.insertId, sequenceNo, billingId: bill.id, totals };
  });
}


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
  if (!known.enabled) {
    throw new Error(`${cashPaymentLabel(input.branchName)} is not available yet. Please choose another payment method.`);
  }

  const billRows = await query('SELECT TOP 1 id, full_bill, partial_payment FROM billing WHERE student_id = ?', [student.id]);
  const bill = billRows[0] || null;
  if (!bill) throw new Error('Your account has not been billed yet, so there is nothing to pay. Please contact the office.');

  
  const paidRows = await query('SELECT COALESCE(SUM(amount), 0) AS paid FROM payment_entries WHERE billing_id = ?', [bill.id]);

  
  
  const remaining = remainingFor(bill, paidRows[0]?.paid);
  if (exceedsBalance(value, remaining)) {
    throw new Error(overpaymentError(value, remaining, { audience: 'student' }));
  }

  const floor = paymentFloorFor(bill, paidRows[0]?.paid);
  if (value < floor.amount) throw new Error(minimumPaymentError(floor));

  
  
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


async function getPaymentRequestById(id) {
  const rows = await query(
    `SELECT pr.*, u.user_id AS student_code, u.first_name, u.middle_name, u.last_name,
            u.contact_number, u.email, br.name AS branch_name,
            p.first_name AS processor_first_name, p.last_name AS processor_last_name,
            bl.for_settlement AS balance_due
     FROM payment_requests pr
     INNER JOIN users u ON u.id = pr.student_id
     LEFT JOIN branches br ON br.id = pr.branch_id
     LEFT JOIN users p ON p.id = pr.processed_by
     LEFT JOIN billing bl ON bl.student_id = pr.student_id
     WHERE pr.id = ?`,
    [id]
  );
  return rows[0] || null;
}


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
            p.first_name AS processor_first_name, p.last_name AS processor_last_name,
            bl.for_settlement AS balance_due
     FROM payment_requests pr
     INNER JOIN users u ON u.id = pr.student_id
     LEFT JOIN branches br ON br.id = pr.branch_id
     LEFT JOIN users p ON p.id = pr.processed_by
     LEFT JOIN billing bl ON bl.student_id = pr.student_id
     WHERE 1 = 1 ${scoped.sql}${filterSql}
     ORDER BY CASE WHEN pr.status = 'pending' THEN 0 ELSE 1 END, pr.created_at DESC`,
    params
  );
}


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

  
  
  
  
  let entry;
  try {
    entry = await addPaymentEntry({
      studentId: request.student_id,
      amount: received,
      paymentMethod: request.payment_method === 'cash' ? 'Cash' : String(request.payment_method || 'Cash'),
      purpose: request.purpose || 'Tuition',
      referenceNo: `REQ-${id}`,
      notes: options.note
        ? `Payment slip #${id} recorded on the POS — ${options.note}`
        : `Payment slip #${id} recorded on the POS at the counter.`,
      actor,
      source: 'student_request',
      paymentRequestId: id
    });
  } catch (error) {
    await query(
      `UPDATE payment_requests
          SET status = 'pending', processed_by = NULL, processed_by_name = NULL, processed_by_role = NULL,
              processed_at = NULL, processed_note = NULL, recorded_amount = NULL,
              updated_at = DATEADD(hour, 8, GETUTCDATE())
        WHERE id = ? AND status = 'completed'`,
      [id]
    ).catch(() => {});
    throw error;
  }

  return { request: await getPaymentRequestById(id), entry };
}


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
    
    
    minimumPayment: minimumPaymentFor(ledger?.bill, ledger?.totals?.totalPaid),
    
    
    paymentFloor: paymentFloorFor(ledger?.bill, ledger?.totals?.totalPaid)
  };
}

module.exports = {
  PAYMENT_METHODS,
  onlineMethodLabel,
  PAYMENT_PURPOSES,
  STUDENT_PAYMENT_METHODS,
  studentPaymentMethodsFor,
  cashPaymentLabel,
  cashPaymentDescription,
  MIN_PAYMENT,
  FIRST_PAYMENT_MINIMUM,
  INSTALMENT_SPLIT,
  SUBJECT_MONTHLY_FEE,
  normalizeAmount,
  hasPaidBefore,
  remainingFor,
  instalmentMinimumFor,
  paymentFloorFor,
  minimumPaymentFor,
  minimumPaymentError,
  overpaymentError,
  exceedsBalance,
  getDownPaymentStatus,
  downPaymentBlockMessage,
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
