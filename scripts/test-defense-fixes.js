/**
 * File: scripts/test-defense-fixes.js
 * Purpose: Pin shut three bugs that reached production.
 *
 * Run:  node scripts/test-defense-fixes.js      (needs no database, no keys)
 *
 *   1. Accepting a learner registration failed with "Violation of UNIQUE KEY
 *      constraint 'UQ__billing__…'": enrolling the student opened their billing
 *      account, and acceptNotification then inserted a second one.
 *   2. A tutor (or student) pressing Save on their own profile re-read the
 *      stored subject list as a string and split it on commas —
 *      ["ENGLISH","FILIPINO"] became '["ENGLISH"' and '"FILIPINO"]', the tutor
 *      vanished from My Subjects and every one of their students lost them.
 *   3. A payment larger than the balance went straight through: ₱4,000 against
 *      ₱3,600 was recorded and the account shown as paid. It is refused, with
 *      the exact amount to pay — except a cleared online payment, which is
 *      money already taken and must still be recorded.
 *
 * config/db is replaced in the require cache before lib/data.js loads, so the
 * real functions run against a scripted database.
 */

let failures = 0;
const ok = (label, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`);
  else { failures++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
};

// --- the scripted database ------------------------------------------------
const state = {};
function reset() {
  state.billing = [];          // { id, student_id, full_bill, partial_payment }
  state.entries = [];          // { billing_id, amount }
  state.assignments = [];      // { id, student_id, subject_id, is_archived }
  state.writes = [];
  state.users = {
    500: {
      id: 500, role: 'tutor', branch_id: 1, first_name: 'Juan', last_name: 'Dela Cruz',
      subjects_json: JSON.stringify(['ENGLISH', 'FILIPINO']), support_json: '[]', extra_json: '{}', email: 'juan@gmail.com'
    }
  };
}
reset();

const SUBJECTS = [{ id: 4, name: 'ENGLISH' }, { id: 6, name: 'FILIPINO' }];

function answer(text, params = []) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  if (/^(INSERT|UPDATE|DELETE)/i.test(s)) state.writes.push({ sql: s, params });

  // acceptNotification: the registration being accepted
  if (/FROM notifications n INNER JOIN submissions s ON s\.id = n\.submission_id WHERE n\.id = \?/i.test(s)) {
    return [{
      notification_id: 7, submission_id: 70, submission_id_value: 70, branch_id: 1, submission_type: 'student',
      password_hash: 'x', first_name: 'Maria', middle_name: '', last_name: 'Santos', birth_date: null, age: 12,
      gender: 'Female', contact_number: '09170000000', email: 'maria.santos@gmail.com', facebook_account: '',
      address: '', year_level: 'Primary Level', grade_level: 'Grade 6', parent_guardian_name: 'Ana',
      parent_contact_number: '', parent_email: '', parent_facebook: '', image_path: null,
      subjects_json: JSON.stringify(['ENGLISH', 'FILIPINO']), support_json: '[]', extra_json: '{}',
      submission_status: 'pending'
    }];
  }
  if (/^SELECT TOP 1 id FROM users WHERE LOWER\(email\) = \?/i.test(s)) return [];
  if (/^INSERT INTO users/i.test(s)) return { insertId: 321 };
  if (/^SELECT id, name FROM subjects WHERE is_archived = 0/i.test(s)) return SUBJECTS;
  if (/^SELECT \* FROM user_subject_assignments WHERE student_id = \? AND subject_id = \?/i.test(s)) {
    return state.assignments.filter((a) => a.student_id === Number(params[0]) && a.subject_id === Number(params[1]));
  }
  if (/^INSERT INTO user_subject_assignments/i.test(s)) {
    state.assignments.push({ id: state.assignments.length + 1, student_id: Number(params[0]), subject_id: Number(params[1]), is_archived: 0 });
    return { insertId: state.assignments.length };
  }
  if (/^SELECT id, subject_id FROM user_subject_assignments WHERE student_id = \?/i.test(s)) {
    return state.assignments.filter((a) => a.student_id === Number(params[0]));
  }
  if (/SELECT COUNT\(\*\) AS subject_count/i.test(s)) {
    const count = state.assignments.filter((a) => a.student_id === Number(params[0]) && !a.is_archived).length;
    return [{ subject_count: count, next_end_date: '2026-11-06' }];
  }
  if (/^SELECT TOP 1 id, full_bill(, partial_payment)? FROM billing WHERE student_id = \?/i.test(s)) {
    return state.billing.filter((b) => b.student_id === Number(params[0]));
  }
  if (/^INSERT INTO billing/i.test(s)) {
    const studentId = Number(params[0]);
    // billing.student_id is UNIQUE, as in the real schema.
    if (state.billing.some((b) => b.student_id === studentId)) {
      throw new Error(`Violation of UNIQUE KEY constraint 'UQ__billing__2A33069BCED9A9A2'. Cannot insert duplicate key in object 'dbo.billing'. The duplicate key value is (${studentId}).`);
    }
    state.billing.push({ id: state.billing.length + 1, student_id: studentId, full_bill: Number(params[1]), partial_payment: 0 });
    return { insertId: state.billing.length };
  }
  if (/^UPDATE billing SET full_bill = \?/i.test(s)) {
    const bill = state.billing.find((b) => b.id === Number(params[params.length - 1]));
    if (bill) bill.full_bill = Number(params[0]);
    return [];
  }
  if (/SELECT COALESCE\(SUM\(amount\), 0\) AS paid FROM payment_entries WHERE billing_id = \?/i.test(s)) {
    const paid = state.entries.filter((e) => e.billing_id === Number(params[0])).reduce((sum, e) => sum + e.amount, 0);
    return [{ paid }];
  }
  if (/SELECT COALESCE\(MAX\(sequence_no\), 0\) AS last_seq/i.test(s)) {
    const list = state.entries.filter((e) => e.billing_id === Number(params[0]));
    return [{ last_seq: list.length, paid: list.reduce((sum, e) => sum + e.amount, 0) }];
  }
  if (/^INSERT INTO payment_entries/i.test(s)) {
    state.entries.push({ billing_id: Number(params[0]), amount: Number(params[3]) });
    return { insertId: state.entries.length };
  }
  if (/SELECT COALESCE\(SUM\(amount\), 0\) AS paid, MAX\(paid_at\)/i.test(s)) {
    const list = state.entries.filter((e) => e.billing_id === Number(params[0]));
    return [{ paid: list.reduce((sum, e) => sum + e.amount, 0), last_paid_at: null, entry_count: list.length }];
  }
  if (/^SELECT TOP 1 full_bill FROM billing WHERE id = \?/i.test(s)) {
    return state.billing.filter((b) => b.id === Number(params[0]));
  }
  if (/^SELECT TOP 1 id FROM payment_requests WHERE student_id = \? AND status = 'pending'/i.test(s)) return [];
  if (/^INSERT INTO payment_requests/i.test(s)) return { insertId: 9 };

  // updateUser / getUserById
  if (/FROM users u LEFT JOIN branches b ON b\.id = u\.branch_id WHERE u\.id = \?/i.test(s)) {
    const user = state.users[Number(params[0])];
    return user ? [{ ...user }] : [];
  }
  if (/^SELECT TOP 1 id FROM users WHERE LOWER\(email\)/i.test(s)) return [];
  if (/FROM user_subject_assignments usa INNER JOIN subjects s ON s\.id = usa\.subject_id INNER JOIN users st/i.test(s)) return [];
  return [];
}

const dbPath = require.resolve('../config/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    sql: {}, baseConfig: {},
    getPool: async () => { throw new Error('the test must never open a connection'); },
    query: async (text, params) => answer(text, params),
    withTransaction: async (work) => work({ query: async (text, params) => [answer(text, params)] })
  }
};

const { acceptNotification, updateUser } = require('../lib/data');
const { addPaymentEntry, createPaymentRequest, overpaymentError } = require('../lib/billing');
const { normalizeArray } = require('../lib/utils');

const refuse = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

(async () => {
  console.log('\n== accepting a learner registration ==');
  reset();
  const failure = await refuse(() => acceptNotification(7, { id: 1, role: 'admin' }));
  ok('is accepted without a database error', failure === null, failure || '');
  const inserts = state.writes.filter((w) => /^INSERT INTO billing/i.test(w.sql));
  ok('opens exactly ONE billing account', inserts.length === 1, `${inserts.length} insert(s)`);
  ok('priced from the subjects enrolled (2 × ₱1,800)', state.billing[0] && state.billing[0].full_bill === 3600,
    state.billing[0] ? String(state.billing[0].full_bill) : 'no bill');
  ok('both subjects are enrolled', state.assignments.length === 2);

  console.log('\n== a stored subject list is read as a list ==');
  ok('a JSON list is not split on commas',
    normalizeArray('["ENGLISH","FILIPINO"]').join('|') === 'ENGLISH|FILIPINO',
    JSON.stringify(normalizeArray('["ENGLISH","FILIPINO"]')));
  ok('a plain comma list still works', normalizeArray('ENGLISH, FILIPINO').join('|') === 'ENGLISH|FILIPINO');

  console.log('\n== a tutor saving their own profile keeps their subjects ==');
  reset();
  const tutor = state.users[500];
  // What routes/tutor.js now sends: the parsed list, never the raw JSON.
  await updateUser(500, {
    first_name: 'Juan', last_name: 'Dela Cruz', contact_number: '09171234567',
    branch_id: tutor.branch_id, subjects: ['ENGLISH', 'FILIPINO'], supports: [], image_path: null, extra: {}
  });
  const write = state.writes.find((w) => /^UPDATE users SET branch_id = \?/i.test(w.sql));
  const saved = write ? JSON.parse(write.params[18]) : null;
  ok('the subjects are written back as they were', saved && saved.join('|') === 'ENGLISH|FILIPINO', JSON.stringify(saved));

  // A list the OLD save already damaged is repaired on the way through.
  reset();
  state.users[500].subjects_json = JSON.stringify(['["ENGLISH"', '"FILIPINO"]']);
  await updateUser(500, { first_name: 'Juan', last_name: 'Dela Cruz', branch_id: 1, extra: {} });
  const repaired = state.writes.find((w) => /^UPDATE users SET branch_id = \?/i.test(w.sql));
  const fixed = repaired ? JSON.parse(repaired.params[18]) : null;
  ok('a damaged list is saved back clean', fixed && fixed.join('|') === 'ENGLISH|FILIPINO', JSON.stringify(fixed));

  console.log('\n== never more than is owed ==');
  reset();
  state.billing.push({ id: 1, student_id: 46, full_bill: 3600, partial_payment: 0 });
  const over = await refuse(() => addPaymentEntry({ studentId: 46, amount: 4000, actor: { id: 1, role: 'admin' } }));
  ok('₱4,000 against ₱3,600 is refused', over !== null, over || 'it was recorded');
  ok('and the refusal gives the exact amount', /exact amount \(₱3,600\.00\)/.test(over || ''), over || '');
  ok('nothing was recorded', state.entries.length === 0);

  const exact = await refuse(() => addPaymentEntry({ studentId: 46, amount: 3600, actor: { id: 1, role: 'admin' } }));
  ok('the exact amount is accepted', exact === null, exact || '');
  const after = await refuse(() => addPaymentEntry({ studentId: 46, amount: 1, actor: { id: 1, role: 'admin' } }));
  ok('a fully paid account takes nothing more', /already fully paid/.test(after || ''), after || 'went through');

  reset();
  state.billing.push({ id: 1, student_id: 46, full_bill: 3600, partial_payment: 0 });
  const instalment = await refuse(() => addPaymentEntry({ studentId: 46, amount: 1200, actor: { id: 1, role: 'admin' } }));
  ok('a part payment is still allowed', instalment === null, instalment || '');

  reset();
  state.billing.push({ id: 1, student_id: 46, full_bill: 3600, partial_payment: 0 });
  const online = await refuse(() => addPaymentEntry({ studentId: 46, amount: 4000, source: 'online', allowOverpayment: true }));
  ok('a cleared ONLINE payment is still recorded (the money is already taken)', online === null, online || '');

  reset();
  state.billing.push({ id: 1, student_id: 46, full_bill: 3600, partial_payment: 0 });
  const slip = await refuse(() => createPaymentRequest({ student: { id: 46, branch_id: 1, first_name: 'Kim' }, amount: 4000, branchId: 1 }));
  ok('a ₱4,000 cash slip against ₱3,600 is refused', slip !== null, slip || 'issued');
  ok('telling the student the exact amount', /Please enter the exact amount: ₱3,600\.00/.test(slip || ''), slip || '');
  const fine = await refuse(() => createPaymentRequest({ student: { id: 46, branch_id: 1, first_name: 'Kim' }, amount: 3600, branchId: 1 }));
  ok('a slip for the balance is issued', fine === null, fine || '');

  ok('the student wording', /your remaining balance/.test(overpaymentError(4000, 3600, { audience: 'student' })));

  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'Registration, profile save and overpayment fixes — hold.'}`);
  process.exit(failures ? 1 : 0);
})().catch((error) => { console.error('ERROR', error.message, error.stack); process.exit(1); });
