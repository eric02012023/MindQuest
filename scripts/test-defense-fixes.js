/**
 * File: scripts/test-defense-fixes.js
 * Purpose: Pin shut five bugs that reached production.
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
 *   4. A subject enrolled between 12 AM and 8 AM Manila time ended a day early
 *      (29 Sep -> 28 Oct): its end was counted on the server's clock, which is
 *      UTC. This test runs on a UTC clock too, so the bug would show here.
 *   5. A tutor's Student Results listed every submission in the subjects they
 *      teach, other tutors' students included, and its per-student figures came
 *      from retired tables, so every student read "-" and 0.
 *
 * config/db is replaced in the require cache before lib/data.js loads, so the
 * real functions run against a scripted database.
 */

// The live server's clock: UTC, eight hours behind Manila.
process.env.TZ = 'UTC';

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
  state.statements = [];       // every statement, writes and reads
  state.script = null;         // (sql, params) => answer, or undefined to fall through
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
  state.statements.push({ sql: s, params });
  if (/^(INSERT|UPDATE|DELETE)/i.test(s)) state.writes.push({ sql: s, params });
  if (state.script) {
    const scripted = state.script(s, params);
    if (scripted !== undefined) return scripted;
  }

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

const {
  acceptNotification, updateUser, repairShortSubjectCycles,
  getTutorStudentResults, tutorTeachesStudentIn, getTutorStudentsForAnalytics
} = require('../lib/data');
const { addPaymentEntry, createPaymentRequest, overpaymentError } = require('../lib/billing');
const { normalizeArray, plusOneMonth, todayDate } = require('../lib/utils');

const refuse = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

// Stop the clock at one moment: `new Date()` with no argument returns it.
const RealDate = Date;
function freezeClock(iso) {
  const fixed = RealDate.parse(iso);
  global.Date = class extends RealDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(fixed);
    }
    static now() { return fixed; }
  };
}
const thawClock = () => { global.Date = RealDate; };

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

  console.log("\n== a subject's month is counted on Manila's day, not the server's ==");
  ok('this test runs on a UTC clock, like the live server', new Date('2026-10-07T00:00:00').getTimezoneOffset() === 0);
  const midnight = new Date('2026-09-28T16:20:00Z'); // 12:20 AM, 29 September in Manila
  ok('12:20 AM on 29 September is the 29th', todayDate(midnight) === '2026-09-29', todayDate(midnight));
  ok('so a subject enrolled then ends 29 October, not 28 October',
    plusOneMonth(todayDate(midnight)) === '2026-10-29', plusOneMonth(todayDate(midnight)));
  ok("a moment handed straight to plusOneMonth is read as Manila's day too",
    plusOneMonth(midnight) === '2026-10-29', plusOneMonth(midnight));
  const lateNight = new Date('2026-09-28T15:16:00Z'); // 11:16 PM, 28 September in Manila
  ok('one enrolled at 11:16 PM on 28 September still ends 28 October',
    plusOneMonth(lateNight) === '2026-10-28', plusOneMonth(lateNight));

  // The registration accepted at 7:35 AM on 7 October (still the 6th in UTC).
  reset();
  freezeClock('2026-10-06T23:35:00Z');
  const morning = await refuse(() => acceptNotification(7, { id: 1, role: 'admin' }));
  thawClock();
  const enrolments = state.writes.filter((w) => /^INSERT INTO user_subject_assignments/i.test(w.sql));
  ok('a registration accepted at 7:35 AM goes through', morning === null, morning || '');
  ok('its subjects start on 7 October', enrolments.length === 2 && enrolments.every((w) => w.params[4] === '2026-10-07'),
    enrolments.map((w) => w.params[4]).join(', '));
  ok('and end on 7 November, not 6 November', enrolments.length === 2 && enrolments.every((w) => w.params[5] === '2026-11-07'),
    enrolments.map((w) => w.params[5]).join(', '));

  console.log('\n== enrolments that already lost the day get it back ==');
  const shortCycles = (dueOf) => {
    let moved = false;
    return (s, params) => {
      if (/^SELECT usa\.id, usa\.student_id, s\.name AS subject_name/i.test(s)) {
        return [
          { id: 505, student_id: 46, subject_name: 'ARALING PANLIPUNAN (AP)', start_date: '2026-09-29', end_date: '2026-10-28' },
          { id: 537, student_id: 322, subject_name: 'ENGLISH', start_date: '2026-10-07', end_date: '2026-11-06' },
          { id: 538, student_id: 322, subject_name: 'READING & WRITING', start_date: '2026-10-07', end_date: '2026-11-06' }
        ];
      }
      // Student 46 has another subject ending 28 October, so their soonest end stays.
      if (/MIN\(end_date\), 23\) AS due/i.test(s)) {
        return [{ student_id: 46, due: '2026-10-28' }, { student_id: 322, due: moved ? '2026-11-07' : '2026-11-06' }];
      }
      if (/^UPDATE usa SET end_date/i.test(s)) { moved = true; return []; }
      if (/^SELECT TOP 1 id, CONVERT\(varchar\(10\), payment_due, 23\) AS due FROM billing/i.test(s)) {
        return [{ id: 900 + Number(params[0]), due: dueOf[Number(params[0])] }];
      }
      return undefined;
    };
  };

  reset();
  state.script = shortCycles({ 46: '2026-10-28', 322: '2026-11-06' });
  const report = await repairShortSubjectCycles({ commit: false });
  ok('report only: it finds the three short enrolments', report.changed.length === 3, `${report.changed.length}`);
  ok('each gets one month after its own start',
    report.changed.map((c) => c.to).join(', ') === '2026-10-29, 2026-11-07, 2026-11-07', report.changed.map((c) => c.to).join(', '));
  ok('and nothing is written', state.writes.length === 0, `${state.writes.length} write(s)`);

  const repaired2 = await repairShortSubjectCycles();
  const moves = state.writes.filter((w) => /^UPDATE usa SET end_date/i.test(w.sql));
  ok('one update moves exactly those rows', moves.length === 1 && moves[0].params.join(',') === '505,537,538',
    moves.map((w) => w.params.join(',')).join(' | '));
  ok('and only while they still carry the short date',
    /DATEADD\(month, 1, DATEADD\(day, -1, usa\.start_date\)\)/.test(moves[0] ? moves[0].sql : ''));
  const dueMoves = state.writes.filter((w) => /^UPDATE billing SET payment_due/i.test(w.sql));
  ok("the new student's payment due date moves with their subjects (6 -> 7 November)",
    dueMoves.length === 1 && dueMoves[0].params[0] === '2026-11-07' && dueMoves[0].params[1] === 900 + 322,
    dueMoves.map((w) => w.params.join(',')).join(' | '));
  ok("student 46's stays 28 October: another subject still ends then",
    repaired2.dueDates.length === 1 && repaired2.dueDates[0].studentId === 322);

  reset();
  state.script = shortCycles({ 46: '2026-10-28', 322: '2026-11-15' });
  await repairShortSubjectCycles();
  ok('a due date the office set by hand is left as they set it',
    !state.writes.some((w) => /^UPDATE billing SET payment_due/i.test(w.sql)));

  console.log("\n== a tutor's Student Results: their own students only ==");
  reset();
  await getTutorStudentResults(33);
  const resultsQuery = state.statements.find((x) => /FROM tutor_assessment_submissions tas/i.test(x.sql));
  ok('a submission counts only if the student is enrolled with THIS tutor in that subject',
    resultsQuery && /usa\.tutor_id = \?/.test(resultsQuery.sql) && /usa\.student_id = tas\.student_id/.test(resultsQuery.sql)
      && /usa\.subject_id = ta\.subject_id/.test(resultsQuery.sql) && /usa\.is_archived = 0/.test(resultsQuery.sql));
  ok('not every submission in a subject the tutor teaches',
    resultsQuery && !/ta\.subject_id IN/.test(resultsQuery.sql) && !/ta\.tutor_id = \?/.test(resultsQuery.sql));
  ok('for this tutor', resultsQuery && resultsQuery.params.length === 1 && Number(resultsQuery.params[0]) === 33);

  reset();
  await tutorTeachesStudentIn(33, 43, 6);
  const guard = state.statements.find((x) => /FROM user_subject_assignments/i.test(x.sql));
  ok('Check Answers opens only for that tutor, student and subject, while active',
    guard && /tutor_id = \? AND student_id = \? AND subject_id = \? AND is_archived = 0/.test(guard.sql)
      && guard.params.map(Number).join(',') === '33,43,6');

  reset();
  state.script = (s) => {
    if (/^SELECT usa\.student_id, usa\.subject_id, s\.name AS subject_name/i.test(s)) {
      return [
        { student_id: 43, subject_id: 4, subject_name: 'ENGLISH', user_id: 'STD-0043', first_name: 'Rafael', last_name: 'Tolentino', branch_name: 'MAIN BRANCH' },
        { student_id: 43, subject_id: 6, subject_name: 'FILIPINO', user_id: 'STD-0043', first_name: 'Rafael', last_name: 'Tolentino', branch_name: 'MAIN BRANCH' },
        { student_id: 44, subject_id: 6, subject_name: 'FILIPINO', user_id: 'STD-0044', first_name: 'Lourdes', last_name: 'Macaraeg', branch_name: 'MAIN BRANCH' }
      ];
    }
    if (/FROM student_subject_levels ssl/i.test(s)) return [{ student_id: 43, subject_id: 6, level: 'Intermediate' }];
    if (/FROM tutor_assessment_submissions tas INNER JOIN tutor_assessments ta/i.test(s)) {
      return [{ student_id: 43, handed_in: 2, graded: 2, percent_sum: 63.4, activities_done: 1 }];
    }
    if (/FROM student_module_reads smr/i.test(s)) {
      return [
        { student_id: 43, subject_id: 6, module_id: 20, first_opened_at: '2026-10-02T02:00:00Z', last_opened_at: '2026-10-03T02:00:00Z', order_number: 1, title: 'Pagbasa' },
        { student_id: 43, subject_id: 6, module_id: 20, first_opened_at: '2026-10-02T02:00:00Z', last_opened_at: '2026-10-02T02:00:00Z', order_number: 1, title: 'Pagbasa' }
      ];
    }
    if (/FROM assessment_violations v/i.test(s)) return [{ student_id: 43, total: 3 }];
    return undefined;
  };
  const progress = await getTutorStudentsForAnalytics(33);
  const rafael = progress.students.find((row) => row.id === 43) || {};
  const lourdes = progress.students.find((row) => row.id === 44) || {};
  ok('one row per student, not one per subject', progress.students.length === 2, `${progress.students.length}`);
  ok('listing the subjects this tutor teaches them', rafael.subjects === 'ENGLISH, FILIPINO', rafael.subjects);
  ok('a level for each, "Not assessed" where there is none yet',
    (rafael.levels || []).map((l) => `${l.subject_name}:${l.level}`).join(' ') === 'ENGLISH:Not assessed FILIPINO:Intermediate',
    (rafael.levels || []).map((l) => `${l.subject_name}:${l.level}`).join(' '));
  ok('the average of their graded work', rafael.avg_score === '31.7%', rafael.avg_score);
  ok('a module opened twice counts once', rafael.modules_read === 1, `${rafael.modules_read}`);
  ok('module activities handed in', rafael.activities_done === 1, `${rafael.activities_done}`);
  ok('the module they opened last, and in which subject',
    rafael.current_module === 'Module 1 — Pagbasa' && rafael.current_module_subject === 'FILIPINO',
    `${rafael.current_module} / ${rafael.current_module_subject}`);
  ok('violations', rafael.total_violations === 3, `${rafael.total_violations}`);
  ok('a student with nothing yet reads "-" and 0',
    lourdes.avg_score === '-' && lourdes.modules_read === 0 && lourdes.levels && lourdes.levels[0].level === 'Not assessed');
  ok('the summary: 2 students, 1 active, 31.7% average',
    progress.summary.totalStudents === 2 && progress.summary.activeStudents === 1 && progress.summary.avgScore === 31.7,
    JSON.stringify(progress.summary));
  const figures = state.statements.filter((x) => /student_subject_levels|tutor_assessment_submissions|student_module_reads|assessment_violations/.test(x.sql));
  ok('every figure is limited to the subjects this tutor teaches the student',
    figures.length === 4 && figures.every((x) => /usa\.tutor_id = \?/.test(x.sql) && Number(x.params[0]) === 33),
    `${figures.length} queries`);
  ok('and none is read from the retired tables',
    !state.statements.some((x) => /assessment_results|\bmodule_reads\b|student_learning_cycles|assessment_anti_cheat_logs/.test(x.sql)));

  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'Registration, profile save, overpayment, enrolment dates and tutor results fixes — hold.'}`);
  process.exit(failures ? 1 : 0);
})().catch((error) => { console.error('ERROR', error.message, error.stack); process.exit(1); });
