/**
 * File: scripts/test-login-and-payment-guards.js
 * Purpose: Pin down three guards that were missing on live.
 *
 * Run:  node scripts/test-login-and-payment-guards.js   (needs no database, no keys)
 *
 *   1. Login and reset codes (lib/otp.js): five wrong guesses spend a code, and
 *      an account is sent at most five codes an hour. Without both, a 4-digit
 *      code could be found by a script — and the reset code needs only an email.
 *   2. The PayMongo webhook (routes/webhook.js) settles a payment only when
 *      PayMongo itself says it was paid. A forged POST used to be enough.
 *   3. The handout rule (lib/handoutAccess.js) is the same for /uploads/handouts
 *      and /download: enrolled, Pre-Assessment done, the student's own grade.
 *
 * config/db and lib/data are replaced in the require cache with scripted stand-ins,
 * so the real code runs and nothing dials out.
 */

let failures = 0;
const ok = (label, condition, extra = '') => {
  if (condition) console.log(`  PASS  ${label}${extra ? ' — ' + extra : ''}`);
  else { failures++; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
};

// ---------------------------------------------------------------- the database
const otps = [];
let nextOtpId = 1;
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
      if (sql.startsWith('SELECT COUNT(*) AS n FROM otps')) {
        return [{ n: otps.filter((o) => o.user_id === params[0] && o.purpose === params[1]).length }];
      }
      if (sql.startsWith('UPDATE otps SET is_used = 1, updated_at') && sql.includes('WHERE user_id')) {
        otps.filter((o) => o.user_id === params[0] && o.purpose === params[1]).forEach((o) => { o.is_used = 1; });
        return [];
      }
      if (sql.startsWith('INSERT INTO otps')) {
        otps.push({ id: nextOtpId++, user_id: params[0], purpose: params[1], otp_code: params[2], expires_at: params[3], is_used: 0, failed_attempts: 0 });
        return { insertId: nextOtpId - 1 };
      }
      if (sql.startsWith('SELECT TOP 1 * FROM otps')) {
        const live = otps.filter((o) => o.user_id === params[0] && o.purpose === params[1] && !o.is_used);
        return live.length ? [live[live.length - 1]] : [];
      }
      if (sql.startsWith('UPDATE otps SET failed_attempts')) {
        const row = otps.find((o) => o.id === params[2]);
        if (row) { row.failed_attempts = params[0]; row.is_used = params[1]; }
        return [];
      }
      if (sql.startsWith('UPDATE otps SET is_used = 1')) {
        const row = otps.find((o) => o.id === params[params.length - 1]);
        if (row) row.is_used = 1;
        return [];
      }
      if (sql.includes('FROM online_payments')) {
        return params[0] === 'cs_known' ? [{ id: 42, status: 'pending' }] : [];
      }
      return [];
    }
  }
};

// ---------------------------------------------------------------- lib/data
const { moduleVisibleTo } = require('../lib/moduleGrades');
const paymongo = { answer: null, completed: [] };
const handoutWorld = {
  handout: { subject_id: 2, grade_level: 'Grade 3', target_year_levels_json: '["Grade 3"]' },
  enrolledIn: [2],
  preDone: true,
  grade: 'Grade 3'
};
const dataPath = require.resolve('../lib/data');
require.cache[dataPath] = {
  id: dataPath,
  filename: dataPath,
  loaded: true,
  exports: {
    fetchPayMongoCheckout: async () => {
      if (paymongo.answer instanceof Error) throw paymongo.answer;
      return paymongo.answer;
    },
    completeOnlinePayment: async (id, details) => { paymongo.completed.push({ id, ...details }); },
    getModuleHandoutByPath: async (p) => (p.endsWith('/known.pdf') ? handoutWorld.handout : null),
    getStudentAssignments: async () => handoutWorld.enrolledIn.map((id) => ({ subject_id: id })),
    hasCompletedPreAssessment: async () => (handoutWorld.preDone ? { id: 1 } : null),
    moduleTargetsStudent: (mod, student) => moduleVisibleTo(mod, student),
    getUserById: async () => ({ id: 7, role: 'student', grade_level: handoutWorld.grade, year_level: 'Primary Level' })
  }
};

const otp = require('../lib/otp');
const { checkHandoutAccess } = require('../lib/handoutAccess');

(async () => {
  // -------------------------------------------------------------- 1. codes
  console.log('\n== a login code survives five wrong guesses, no more ==');
  ok('codes are four digits', /^\d{4}$/.test(otp.generateOtp()));
  await otp.storeOtp({ userId: 7, purpose: 'login', code: '4821' });
  let result;
  for (let i = 1; i <= 4; i++) result = await otp.verifyOtp({ userId: 7, purpose: 'login', code: '0000' });
  ok('each wrong guess says how many are left', /1 try left/.test(result.reason), result.reason);
  result = await otp.verifyOtp({ userId: 7, purpose: 'login', code: '0000' });
  ok('the fifth wrong guess spends the code', !result.ok && /Too many wrong codes/.test(result.reason), result.reason);
  result = await otp.verifyOtp({ userId: 7, purpose: 'login', code: '4821' });
  ok('after that even the right code fails', !result.ok, result.reason);

  await otp.storeOtp({ userId: 7, purpose: 'login', code: '1357' });
  result = await otp.verifyOtp({ userId: 7, purpose: 'login', code: '1357' });
  ok('a fresh code works the first time', result.ok);

  console.log('\n== five codes an hour, then no more ==');
  for (let i = otps.filter((o) => o.purpose === 'login').length; i < otp.MAX_CODES_PER_HOUR; i++) {
    await otp.storeOtp({ userId: 7, purpose: 'login', code: '2468' });
  }
  let refused = null;
  try { await otp.storeOtp({ userId: 7, purpose: 'login', code: '9999' }); } catch (error) { refused = error; }
  ok('the sixth code in an hour is refused', refused && refused.code === 'OTP_RATE_LIMIT', refused && refused.message);
  let other = null;
  try { await otp.storeOtp({ userId: 7, purpose: 'reset', code: '1111' }); } catch (error) { other = error; }
  ok('the reset codes are counted on their own', !other);

  // -------------------------------------------------------------- 2. webhook
  console.log('\n== the PayMongo webhook believes PayMongo, not the message ==');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/webhook', require('../routes/webhook'));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}/webhook/paymongo`;
  const deliver = (sessionId) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ data: { attributes: { type: 'checkout_session.payment.paid', data: { id: sessionId, attributes: { payments: [{ id: 'pay_forged', attributes: { status: 'paid' } }] } } } } })
  });
  const quiet = console.log; const quietWarn = console.warn; const quietErr = console.error;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try {
    paymongo.answer = { attributes: { payments: [] }, paidPayment: null };
    let res = await deliver('cs_known');
    const forged = paymongo.completed.length;
    paymongo.answer = null;
    const unreachable = await deliver('cs_known');
    const afterUnreachable = paymongo.completed.length;
    paymongo.answer = { attributes: { payment_method_used: 'gcash', payments: [] }, paidPayment: { id: 'pay_real', attributes: { status: 'paid' } } };
    const paid = await deliver('cs_known');
    const unknown = await deliver('cs_nobody');
    console.log = quiet; console.warn = quietWarn; console.error = quietErr;
    ok('a "paid" message PayMongo does not confirm records nothing', forged === 0 && res.status === 503, `${res.status}, ${forged} recorded`);
    ok('when PayMongo cannot be asked, it is retried later (503), not recorded', unreachable.status === 503 && afterUnreachable === 0, `${unreachable.status}, ${afterUnreachable} recorded`);
    ok('a payment PayMongo confirms is recorded', paid.status === 200 && paymongo.completed.length === 1);
    ok('…under PayMongo\'s payment id and method, not the message\'s', paymongo.completed[0] && paymongo.completed[0].transactionReference === 'pay_real' && paymongo.completed[0].method === 'gcash', JSON.stringify(paymongo.completed[0]));
    ok('an unknown checkout is acknowledged and ignored', unknown.status === 200 && paymongo.completed.length === 1);
  } finally {
    console.log = quiet; console.warn = quietWarn; console.error = quietErr;
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  // -------------------------------------------------------------- 3. handouts
  console.log('\n== one handout rule for every door ==');
  const student = { id: 7, role: 'student' };
  ok('staff are not gated', (await checkHandoutAccess({ id: 1, role: 'tutor' }, '/uploads/handouts/known.pdf')).ok);
  ok('nobody logged in is turned away', (await checkHandoutAccess(null, '/uploads/handouts/known.pdf')).status === 401);
  ok('an unknown file is not found', (await checkHandoutAccess(student, '/uploads/handouts/other.pdf')).status === 404);
  ok('a student of that grade, enrolled, Pre-Assessment done, may open it', (await checkHandoutAccess(student, '/uploads/handouts/known.pdf')).ok);
  handoutWorld.grade = 'Grade 6';
  let verdict = await checkHandoutAccess(student, '/uploads/handouts/known.pdf');
  ok('a student of another grade may not', verdict.status === 403 && /year level/.test(verdict.message), verdict.message);
  handoutWorld.grade = 'Grade 3';
  handoutWorld.preDone = false;
  verdict = await checkHandoutAccess(student, '/uploads/handouts/known.pdf');
  ok('nor one who has not sat the Pre-Assessment', verdict.status === 403 && /Pre-Assessment/.test(verdict.message), verdict.message);
  handoutWorld.preDone = true;
  handoutWorld.enrolledIn = [5];
  verdict = await checkHandoutAccess(student, '/uploads/handouts/known.pdf');
  ok('nor one not enrolled in the subject', verdict.status === 403 && /not enrolled/.test(verdict.message), verdict.message);

  const download = require('fs').readFileSync(require.resolve('../routes/download'), 'utf8');
  ok('/download asks the same rule for a handout', /checkHandoutAccess/.test(download) && /\/uploads\/handouts\//.test(download));

  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'All login, payment and handout guards hold.'}`);
  // exitCode, not exit(): exiting while the test server's sockets are still
  // closing trips a libuv assertion on Windows.
  process.exitCode = failures ? 1 : 0;
})().catch((error) => { console.error('ERROR', error); process.exitCode = 1; });
