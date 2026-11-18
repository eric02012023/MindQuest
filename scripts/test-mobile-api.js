/**
 * File: scripts/test-mobile-api.js
 * Purpose: Pin down the student app's API (routes/mobileApi.js) and what it lets
 *          out (lib/mobileSerializers.js).
 *
 * Run:  node scripts/test-mobile-api.js     (needs no database, no mail, no keys)
 *
 * WHAT MUST HOLD
 *   1. Only students: a tutor (or any staff) is refused at login, and a token
 *      made for one is refused on every request.
 *   2. A student whose registration is not approved is refused.
 *   3. A new phone needs the 4-digit code (stored before it is emailed, within
 *      the hourly limit); a phone verified before skips it; a different phone
 *      with the same device token does not.
 *   4. Forged, expired and "pending" tokens are refused where an access token
 *      is needed; logging out ends the token; an archived student is refused.
 *   5. No response ever carries a password hash (or the word password_hash).
 *   6. While an assessment is being answered, the answer key never leaves the
 *      server; after submission the result shows the correct answer only on
 *      the items the student missed, as the website does.
 *   7. A student cannot open another student's result.
 *   8. Paying online answers { external: <PayMongo checkout> }.
 *   9. The app never gets a cookie; study files pass the website's own guard.
 *
 * config/db, lib/data, lib/otp and lib/email are replaced in the require cache
 * before anything loads them, so the real routes run and nothing dials out.
 * Every name and address below is made up.
 */
process.env.MOBILE_TOKEN_SECRET = 'test-only-secret-for-the-mobile-api-0123456789';
process.env.MOBILE_TOKEN_DAYS = '30';

const bcrypt = require('bcryptjs');
const express = require('express');

let failures = 0;
const ok = (label, condition, extra = '') => {
  if (condition) console.log(`  PASS  ${label}${extra ? ' — ' + extra : ''}`);
  else { failures++; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
};

// ---------------------------------------------------------------- the world
const world = {
  users: [],                 // users rows (password_hash included, as in the DB)
  devices: [],               // trusted_devices rows
  codes: [],                 // login codes stored: { userId, code }
  mails: [],                 // OTP emails sent: { to, otp }
  order: [],                 // 'store' / 'mail', to prove the order
  rateLimited: false,        // storeOtp refuses (five codes this hour)
  submissions: {},           // getSubmissionWithAnswers by id
  assessment: null,          // getTutorAssessmentById
  checkoutUrl: 'https://checkout.paymongo.com/cs_test_made_up'
};
const userById = (id) => world.users.find((u) => Number(u.id) === Number(id)) || null;
const userByEmail = (email) => world.users.find((u) => u.email.toLowerCase() === String(email).toLowerCase()) || null;

// ---------------------------------------------------------------- config/db
function answer(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  if (sql.includes('FROM users') && sql.includes('WHERE LOWER(email) = ?')) {
    const user = userByEmail(params[0]);
    return user && !user.is_archived ? [{ ...user }] : [];
  }
  if (sql.includes('device_active') && sql.includes('FROM users u')) {
    const [deviceId, userId] = params;
    const user = userById(userId);
    if (!user || user.is_archived) return [];
    const device = world.devices.find((d) => d.id === Number(deviceId) && d.user_id === user.id);
    return [{ ...user, device_active: device ? device.is_active : null }];
  }
  if (sql.includes('FROM users u WHERE u.id = ?')) {
    const user = userById(params[0]);
    return user && !user.is_archived ? [{ ...user }] : [];
  }
  if (sql.startsWith('SELECT TOP 1 id FROM trusted_devices')) {
    const device = world.devices.find((d) => d.user_id === params[0] && d.device_token === params[1] && d.is_active === 1);
    return device ? [{ id: device.id }] : [];
  }
  if (sql.startsWith('UPDATE trusted_devices SET is_active = 0') && sql.includes('WHERE id = ?')) {
    const device = world.devices.find((d) => d.id === params[0] && d.user_id === params[1]);
    if (device) device.is_active = 0;
    return [];
  }
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
    query: async (text, params = []) => answer(text, params),
    withTransaction: async (work) => work({ query: async (text, params = []) => [answer(text, params)] })
  }
};

// ---------------------------------------------------------------- lib/otp
const otpPath = require.resolve('../lib/otp');
require.cache[otpPath] = {
  id: otpPath,
  filename: otpPath,
  loaded: true,
  exports: {
    generateOtp: () => String(1000 + world.codes.length),
    storeOtp: async ({ userId, code }) => {
      world.order.push('store');
      if (world.rateLimited) {
        const error = new Error('Too many codes were requested for this account. Please wait an hour, then try again.');
        error.code = 'OTP_RATE_LIMIT';
        throw error;
      }
      world.codes.push({ userId: Number(userId), code: String(code), used: false });
    },
    verifyOtp: async ({ userId, code }) => {
      const live = world.codes.filter((c) => c.userId === Number(userId) && !c.used).pop();
      if (!live) return { ok: false, reason: 'No active OTP found. Please request a new code.' };
      if (live.code !== String(code)) return { ok: false, reason: 'Invalid OTP. 4 tries left before you need a new code.' };
      live.used = true;
      return { ok: true, row: live };
    },
    getDeviceFingerprint: (req) => String(req.get('user-agent') || ''),
    getTrustedDevice: async (userId, token, fingerprint) => world.devices.find((d) => d.user_id === Number(userId)
      && d.device_token === token && d.device_fingerprint === fingerprint && d.is_active === 1) || null,
    touchTrustedDevice: async () => {},
    // Like the real one: the token and its expiry, not the row id.
    registerTrustedDevice: async (userId, req) => {
      const device = {
        id: 900 + world.devices.length,
        user_id: Number(userId),
        device_token: `devtoken${world.devices.length}abcdef`,
        device_fingerprint: String(req.get('user-agent') || ''),
        is_active: 1
      };
      world.devices.push(device);
      return { token: device.device_token, expiresAt: new Date(Date.now() + 86400000) };
    },
    deactivateTrustedDevice: async (userId, token) => {
      world.devices.filter((d) => d.user_id === Number(userId) && d.device_token === token).forEach((d) => { d.is_active = 0; });
    },
    parseCookieHeader: () => ({}),
    TRUSTED_DEVICE_DAYS: 30,
    MAX_OTP_ATTEMPTS: 5,
    MAX_CODES_PER_HOUR: 5
  }
};

// ---------------------------------------------------------------- lib/email
const emailPath = require.resolve('../lib/email');
require.cache[emailPath] = {
  id: emailPath,
  filename: emailPath,
  loaded: true,
  exports: {
    sendOtpEmail: async ({ to, otp }) => { world.order.push('mail'); world.mails.push({ to, otp }); },
    sendEmail: async () => {}
  }
};

// ---------------------------------------------------------------- lib/data
// The real module is loaded (its constants are used at load time elsewhere),
// then replaced by a copy whose functions on the tested paths answer from the
// world above. Its other functions only ever meet the stubbed database.
const realData = require('../lib/data');
const dataPath = require.resolve('../lib/data');
const student = () => userById(7);
const ownAssignment = { subject_id: 2, subject_name: 'MATHEMATICS', tutor_internal_id: 30, tutor_name: 'Rico Bautista', time_slot: '1:00 PM - 2:00 PM', preferred_days: 'Mon, Wed' };
require.cache[dataPath].exports = {
  ...realData,
  getStudentScheduleNotifications: async () => [],
  getAppNotifications: async () => [],
  getUserById: async (id) => ({ ...userById(id), subjects: [], supports: [], extra: {} }),
  getStudentDashboardData: async (id) => ({
    user: { ...userById(id) },
    assignments: [ownAssignment],
    attendance: { present: 3, late: 1, absent: 0, excused: 0 },
    latestSoa: null
  }),
  getStudentSubjectsOverview: async () => ({ enrolledSubjects: [ownAssignment], allSubjects: [] }),
  getStudentAssignments: async () => [ownAssignment],
  getTutorAssessmentById: async () => (world.assessment ? JSON.parse(JSON.stringify(world.assessment)) : null),
  getModuleById: async () => ({ id: 9, subject_id: 2, title: 'Fractions', created_at: '2026-11-01 09:00:00' }),
  moduleTargetsStudent: () => true,
  hasCompletedPreAssessment: async () => ({ id: 1, level: 'Intermediate', percentage: 66 }),
  getStudentSubmissions: async () => [],
  getSubmissionWithAnswers: async (id) => (world.submissions[id] ? JSON.parse(JSON.stringify(world.submissions[id])) : null),
  getWeakAreasForSubmission: async () => [
    { order_number: 1, module_title: 'Fractions', handout_name: 'fractions.pdf', correct: 1, total: 2, percentage: 50, is_weak: true }
  ],
  createPayMongoPayment: async () => ({ checkoutUrl: world.checkoutUrl }),
  recordViolation: async () => ({ sessionCount: 1, totalCount: 1, limit: 3, shouldAutoSubmit: false, label: 'Left the app' })
};

const createMobileApi = require('../routes/mobileApi');
const { signToken, STUDENTS_ONLY } = createMobileApi;

// ---------------------------------------------------------------- the server
const guardCalls = [];
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/api/mobile', createMobileApi({
  // Stand-ins for server.js's own: record who reached them.
  serveUploadFolder: (folder) => (req, res) => res.type('application/pdf').send(Buffer.from(`%PDF ${folder}${req.path}`)),
  guardHandoutAccess: (req, res, next) => {
    guardCalls.push(req.session && req.session.user ? req.session.user.id : null);
    if (req.path === '/locked.pdf') return res.status(403).type('text/plain').send('Finish the Pre-Assessment first.');
    return next();
  }
}));

const bodies = [];      // every response body, to look for a password hash
const cookies = [];     // every Set-Cookie header
let base = '';
async function call(method, path, { token, body, ua = 'MindQuestStudentApp (Android)' } = {}) {
  const headers = { 'user-agent': ua, connection: 'close' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}/api/mobile${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await response.text();
  bodies.push(text);
  if (response.headers.get('set-cookie')) cookies.push(response.headers.get('set-cookie'));
  let json = null;
  try { json = JSON.parse(text); } catch (_error) { json = null; }
  return { status: response.status, json, text, type: response.headers.get('content-type') || '' };
}

async function main() {
  const hash = await bcrypt.hash('Secret#2026', 4);
  world.users.push(
    { id: 7, user_id: 'STD-9001', role: 'student', status: 'approved', is_archived: 0, email: 'mark.santos.mq@gmail.com', password_hash: hash, first_name: 'Mark', middle_name: '', last_name: 'Santos', branch_id: 15, image_path: null, grade_level: 'Grade 5', year_level: 'Primary Level' },
    { id: 8, user_id: 'STD-9002', role: 'student', status: 'pending', is_archived: 0, email: 'ana.reyes.mq@gmail.com', password_hash: hash, first_name: 'Ana', last_name: 'Reyes', branch_id: 15 },
    { id: 30, user_id: 'TTR-9001', role: 'tutor', status: 'approved', is_archived: 0, email: 'rico.bautista.mq@gmail.com', password_hash: hash, first_name: 'Rico', last_name: 'Bautista', branch_id: 15 },
    { id: 1, user_id: 'ADM-0001', role: 'admin', status: 'approved', is_archived: 0, email: 'office@mindquest.local', password_hash: hash, first_name: 'Office', last_name: 'Admin' },
    { id: 9, user_id: 'STD-9003', role: 'student', status: 'approved', is_archived: 0, email: 'leo.cruz.mq@gmail.com', password_hash: hash, first_name: 'Leo', last_name: 'Cruz', branch_id: 15 }
  );

  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  const quietError = console.error;
  console.error = () => {};
  try {
    console.log('\n== only students ==');
    let r = await call('POST', '/auth/login', { body: { email: 'rico.bautista.mq@gmail.com', password: 'Secret#2026' } });
    ok('a tutor with the right password is refused at login', r.status === 403 && r.json.error === STUDENTS_ONLY, r.json && r.json.error);
    ok('…and is sent no code', world.mails.length === 0);
    r = await call('POST', '/auth/login', { body: { email: 'office@mindquest.local', password: 'Secret#2026' } });
    ok('the admin is refused the same way', r.status === 403 && r.json.error === STUDENTS_ONLY);
    r = await call('POST', '/auth/login', { body: { email: 'rico.bautista.mq@gmail.com', password: 'wrong' } });
    ok('a wrong password does not reveal that the email is staff', r.status === 401 && r.json.error === 'Invalid email or password.');
    world.devices.push({ id: 50, user_id: 30, device_token: 'tutordevice', device_fingerprint: 'x', is_active: 1 });
    const tutorToken = signToken({ typ: 'access', sub: 30, dev: 50 }, 3600000);
    r = await call('GET', '/student', { token: tutorToken });
    ok('a validly signed token for a tutor is refused on every request', r.status === 403 && r.json.error === STUDENTS_ONLY && r.json.auth === false);
    r = await call('GET', '/me', { token: tutorToken });
    ok('…/me included', r.status === 403);

    console.log('\n== approval ==');
    r = await call('POST', '/auth/login', { body: { email: 'ana.reyes.mq@gmail.com', password: 'Secret#2026' } });
    ok('a student still waiting for approval is refused', r.status === 403 && /Waiting for admin approval/.test(r.json.error));
    r = await call('POST', '/auth/login', { body: { email: 'nobody.mq@gmail.com', password: 'Secret#2026' } });
    ok('an unknown email is refused', r.status === 401 && r.json.error === 'Invalid email or password.');

    console.log('\n== a new phone needs the code; a trusted one does not ==');
    world.order = [];
    r = await call('POST', '/auth/login', { body: { email: 'MARK.SANTOS.MQ@gmail.com ', password: 'Secret#2026' } });
    ok('a new phone: a code is required', r.status === 200 && r.json.otpRequired === true && !!r.json.pendingToken && !r.json.token);
    ok('…sent to the student, the address masked in the answer', world.mails.length === 1 && world.mails[0].to === 'mark.santos.mq@gmail.com'
      && r.json.maskedEmail === 'ma************@gmail.com', r.json.maskedEmail);
    ok('…the code is stored BEFORE it is emailed', world.order.join(',') === 'store,mail', world.order.join(','));
    const pendingToken = r.json.pendingToken;
    r = await call('GET', '/student', { token: pendingToken });
    ok('the pending token is not an access token', r.status === 401 && r.json.auth === false);
    r = await call('POST', '/auth/verify-otp', { body: { pendingToken, otp: '9999' } });
    ok('a wrong code: refused', r.status === 400 && /Invalid OTP/.test(r.json.error));
    r = await call('POST', '/auth/verify-otp', { body: { pendingToken, otp: world.mails[0].otp } });
    ok('the right code: an access token, a device token and the student', r.status === 200 && !!r.json.token && !!r.json.deviceToken && r.json.user.code === 'STD-9001');
    const token = r.json.token;
    const deviceToken = r.json.deviceToken;
    const mailsBefore = world.mails.length;
    r = await call('POST', '/auth/login', { body: { email: 'mark.santos.mq@gmail.com', password: 'Secret#2026', deviceToken } });
    ok('the same phone next time: logged in at once, no code', r.status === 200 && !!r.json.token && !r.json.otpRequired && world.mails.length === mailsBefore);
    r = await call('POST', '/auth/login', { body: { email: 'mark.santos.mq@gmail.com', password: 'Secret#2026', deviceToken }, ua: 'SomeOtherPhone/1.0' });
    ok('the device token copied to another phone: the code again', r.status === 200 && r.json.otpRequired === true);
    r = await call('POST', '/auth/resend-otp', { body: { pendingToken: r.json.pendingToken } });
    ok('resend: a new code', r.status === 200 && world.mails.length === mailsBefore + 2);
    world.rateLimited = true;
    const mailsAtLimit = world.mails.length;
    r = await call('POST', '/auth/login', { body: { email: 'leo.cruz.mq@gmail.com', password: 'Secret#2026' } });
    ok('five codes this hour: refused (429), and no email goes out', r.status === 429 && world.mails.length === mailsAtLimit);
    world.rateLimited = false;
    r = await call('POST', '/auth/verify-otp', { body: { pendingToken: token, otp: '1234' } });
    ok('an access token is not a pending token', r.status === 401);

    console.log('\n== forged, expired and logged-out tokens ==');
    r = await call('GET', '/me', { token });
    ok('the real token works', r.status === 200 && r.json.user.code === 'STD-9001');
    const [payload, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const raised = Buffer.from(JSON.stringify({ ...claims, sub: 9 })).toString('base64url');
    r = await call('GET', '/me', { token: `${raised}.${signature}` });
    ok('a token edited to another student is refused', r.status === 401 && r.json.auth === false);
    r = await call('GET', '/me', { token: `${payload}.${Buffer.alloc(32).toString('base64url')}` });
    ok('a made-up signature is refused', r.status === 401);
    const realSecret = process.env.MOBILE_TOKEN_SECRET;
    process.env.MOBILE_TOKEN_SECRET = 'someone-elses-secret';
    const foreign = signToken({ typ: 'access', sub: 7, dev: claims.dev }, 3600000);
    process.env.MOBILE_TOKEN_SECRET = realSecret;
    r = await call('GET', '/me', { token: foreign });
    ok('a token signed with another secret is refused', r.status === 401);
    r = await call('GET', '/me', { token: signToken({ typ: 'access', sub: 7, dev: claims.dev }, -1000) });
    ok('an expired token is refused', r.status === 401);
    r = await call('GET', '/me', { token: 'not-a-token' });
    ok('garbage is refused', r.status === 401);
    r = await call('GET', '/me');
    ok('no token at all is refused', r.status === 401 && r.json.auth === false);

    console.log('\n== what the student pages let out ==');
    r = await call('GET', '/student', { token });
    ok('Home: rendered as JSON, the page named', r.status === 200 && r.json.view === 'student-dashboard' && r.json.data.firstName === 'Mark');
    r = await call('GET', '/student/profile', { token });
    ok('My Profile: the student\'s fields', r.status === 200 && r.json.data.profile.code === 'STD-9001' && r.json.data.profile.gradeLevel === 'Grade 5');

    world.assessment = {
      id: 5, title: 'Fractions Quiz', subject_id: 2, module_id: 9, is_published: 1, is_archived: 0,
      assessment_kind: 'tutor_assessment', purpose: 'activity', for_student_id: null, level_module_id: null,
      created_at: '2026-11-02 09:00:00', instructions: 'Answer all.',
      questions: [
        {
          id: 101, question_type: 'multiple_choice', question_text: 'What is 1/2 + 1/4?', points: 1,
          correct_answer: 'C', explanation: 'EXPLANATION-NEVER-SHOWN', answer_rubric: 'RUBRIC-NEVER-SHOWN',
          options: [
            { option_label: 'A', option_text: '2/6', is_correct: 0 },
            { option_label: 'B', option_text: '1/8', is_correct: 0 },
            { option_label: 'C', option_text: '3/4', is_correct: 1 }
          ]
        },
        { id: 102, question_type: 'true_false', question_text: '1/2 equals 2/4.', points: 1, correct_answer: 'True', explanation: 'EXPLANATION-NEVER-SHOWN' },
        { id: 103, question_type: 'essay', question_text: 'Explain fractions.', points: 5, correct_answer: 'MODEL-ANSWER-NEVER-SHOWN', answer_rubric: 'RUBRIC-NEVER-SHOWN' }
      ]
    };
    r = await call('GET', '/student/tutor-assessments/5', { token });
    ok('an activity being answered: its questions come', r.status === 200 && r.json.view === 'student-take-tutor-assessment' && r.json.data.questions.length === 3);
    ok('…with no answer key: no correct_answer, explanation, answer_rubric or is_correct',
      !/correct_answer|explanation|answer_rubric|is_correct|correctAnswer/.test(r.text)
      && !/NEVER-SHOWN/.test(r.text) && !r.json.data.questions[0].choices.some((c) => 'isCorrect' in c));
    ok('…and what the app needs to answer it', r.json.data.submitPath === '/tutor-assessments/5/submit'
      && r.json.data.antiCheat && r.json.data.antiCheat.endpoint === '/assessments/5/violation' && !!r.json.data.startedAt
      && r.json.data.questions[1].choices.map((c) => c.value).join('/') === 'True/False');
    r = await call('POST', '/student/assessments/5/violation', { token, body: { type: 'tab_switch', detail: 'left the app', session_key: 's1' } });
    ok('the anti-cheat strike answer passes through unchanged (the server counts)', r.status === 200 && r.json.count === 1 && r.json.limit === 3 && r.json.autoSubmit === false);

    world.submissions[77] = {
      id: 77, student_id: 7, title: 'Fractions Quiz', subject_id: 2, subject_name: 'MATHEMATICS', percentage: 50, level: 'Beginner', score: 1, total_points: 2,
      assessment_kind: 'tutor_assessment', assessment_purpose: 'activity', for_student_id: null,
      answers: [
        { question_text: 'What is 1/2 + 1/4?', question_type: 'multiple_choice', student_answer: 'A', correct_answer: 'C', is_correct: 0, points: 1, points_earned: 0, explanation: 'Add the quarters.', options: [{ option_label: 'A', option_text: '2/6' }, { option_label: 'C', option_text: '3/4' }] },
        { question_text: '1/2 equals 2/4.', question_type: 'true_false', student_answer: 'True', correct_answer: 'True', is_correct: 1, points: 1, points_earned: 1, explanation: 'EXPLANATION-OF-A-RIGHT-ANSWER' }
      ]
    };
    world.submissions[78] = { ...world.submissions[77], id: 78, student_id: 9 };
    r = await call('GET', '/student/results/77', { token });
    const missed = r.json && r.json.data && r.json.data.answers[0];
    const right = r.json && r.json.data && r.json.data.answers[1];
    ok('a result after submission: the missed item shows the correct answer and why',
      r.status === 200 && missed.correctAnswer === 'C' && missed.correctAnswerText === '3/4' && missed.explanation === 'Add the quarters.');
    ok('…an item answered right shows no key (as on the website)', right && right.isCorrect && !('correctAnswer' in right) && !/EXPLANATION-OF-A-RIGHT-ANSWER/.test(r.text));
    ok('…the bands and the weakest topics first', r.json.data.bands.length === 3 && r.json.data.topics[0].percentage === 50);
    r = await call('GET', '/student/results/78', { token });
    ok('another student\'s result: refused, sent to My Subjects', r.status === 200 && r.json.redirect === '/subjects'
      && /only view your own results/.test(r.json.flash.message) && !r.json.data);

    r = await call('POST', '/student/billing/pay-online', { token, body: { amount: 500 } });
    ok('Pay now: the PayMongo checkout comes back as { external }', r.status === 200 && r.json.external === world.checkoutUrl);
    r = await call('POST', '/student/billing/pay-online', { token, body: { amount: 0 } });
    ok('…a zero amount: back to Billing with the reason', r.json.redirect === '/billing' && /greater than zero/.test(r.json.flash.message));

    console.log('\n== files and cookies ==');
    r = await call('GET', '/uploads/handouts/known.pdf');
    ok('a handout without a token: refused before the guard', r.status === 401 && guardCalls.length === 0);
    r = await call('GET', '/uploads/handouts/locked.pdf', { token });
    ok('with a token, the website\'s handout guard decides (here: locked)', r.status === 403 && guardCalls[guardCalls.length - 1] === 7);
    r = await call('GET', '/uploads/handouts/known.pdf', { token });
    ok('…and serves it when it allows', r.status === 200 && /pdf/.test(r.type));
    r = await call('GET', '/uploads/modules/a.pdf', { token });
    ok('other study folders need the token too', r.status === 200 && (await call('GET', '/uploads/modules/a.pdf')).status === 401);
    r = await call('GET', '/nothing/here', { token });
    ok('an unknown address: a JSON 404, not the website', r.status === 404 && r.json && r.json.ok === false);
    r = await call('GET', '/health');
    ok('health answers without a login', r.status === 200 && r.json.ok === true);

    console.log('\n== logging out, and an archived account ==');
    r = await call('POST', '/auth/logout', { token, body: { deviceToken } });
    ok('logout answers ok', r.status === 200 && r.json.ok === true);
    r = await call('GET', '/me', { token });
    ok('…and the token no longer works', r.status === 401 && r.json.auth === false);
    r = await call('POST', '/auth/login', { body: { email: 'mark.santos.mq@gmail.com', password: 'Secret#2026', deviceToken } });
    ok('…and the phone needs the code again', r.json.otpRequired === true);
    r = await call('POST', '/auth/verify-otp', { body: { pendingToken: r.json.pendingToken, otp: world.mails[world.mails.length - 1].otp } });
    const fresh = r.json.token;
    userById(7).is_archived = 1;
    r = await call('GET', '/student', { token: fresh });
    ok('a student archived after logging in is refused at once', r.status === 401 && r.json.auth === false);
    userById(7).is_archived = 0;

    console.log('\n== nothing secret in any answer ==');
    ok(`no response carries a password hash (${bodies.length} checked)`, !bodies.some((text) => text.includes(hash) || /password_hash|passwordHash/.test(text)));
    ok('no response sets a cookie', cookies.length === 0, cookies.join(' | '));
  } finally {
    console.error = quietError;
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'The app API lets in students only, keeps the answer key and the password hash on the server, and uses the website\'s own rules.'}`);
  // exitCode, not exit(): exiting while sockets close trips a libuv assertion on Windows.
  process.exitCode = failures ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
