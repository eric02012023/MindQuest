/**
 * File: routes/mobileApi.js
 * Purpose: The JSON API of the MindQuest student app (Android), mounted at
 *          /api/mobile by server.js.
 *
 * WHO MAY USE IT
 *   Students only. An admin, an assistant admin or a tutor is refused at login
 *   AND on every request with STUDENTS_ONLY, even holding a valid token.
 *
 * HOW A STUDENT SIGNS IN (the same checks as the website's POST /login)
 *   1. POST /auth/login {email, password, deviceToken?}
 *        the account exists and is not archived, the password matches (bcrypt),
 *        the role is student, the registration is approved. A phone the student
 *        verified before (a valid trusted-device token) gets an access token at
 *        once; any other phone gets a 4-digit code by email first.
 *   2. POST /auth/verify-otp {pendingToken, otp}  -> {token, deviceToken, user}
 *   3. POST /auth/resend-otp {pendingToken}       -> a new code, same hourly limit
 *   4. POST /auth/logout                          -> the phone is no longer trusted
 *                                                   and its access token stops working
 *
 * WHY TOKENS, NOT THE WEBSITE'S COOKIES
 *   A phone app does not keep browser cookies well, and a cookie session would
 *   also invite CSRF. So the app sends "Authorization: Bearer <token>". The token
 *   is signed here with HMAC-SHA256 (Node's own crypto, no new dependency):
 *
 *       base64url(JSON payload) . base64url(HMAC-SHA256(secret, payload))
 *
 *   Nobody without the secret can make or change one; the signature is compared
 *   with crypto.timingSafeEqual. Two kinds exist and neither works as the other:
 *     - "pending": 15 minutes, only between the password and the emailed code;
 *     - "access":  MOBILE_TOKEN_DAYS days (30), for everything else, and tied to
 *                  the trusted-device row, so logging out ends it for good.
 *   The secret is MOBILE_TOKEN_SECRET, or SESSION_SECRET when that is not set.
 *   With neither, the API refuses to sign anything (there is no built-in
 *   fallback secret: this repository is public, and a known secret would let
 *   anyone forge a token).
 *
 * HOW THE APP GETS ITS PAGES — the "JSON bridge"
 *   The app does NOT get a second copy of the business rules. /api/mobile/student
 *   runs the website's own routes/student.js, so every gate (down payment,
 *   Pre-Assessment lock, grade level, month rule, one result per student) is the
 *   very same code. Only the response changes:
 *     res.render(view, locals) -> { ok, view, title, notificationCount, flash, data }
 *                                 where data = lib/mobileSerializers.js's whitelist
 *     res.redirect('/student/x') -> { ok, redirect: '/x', flash }  (an app path)
 *     res.redirect('https://…')  -> { ok, external: url }          (PayMongo checkout)
 *     res.redirect('/login')     -> 401 { ok:false, auth:false }
 *     res.json / res.send        -> unchanged (anti-cheat strikes, PDFs)
 *
 *   There is no session store behind the app: requireToken re-reads the student
 *   from the database on every request and sets req.session = { user } for that
 *   one request only, which is all the student routes read. The mount sits
 *   BEFORE express-session in server.js, so no cookie is ever set for the app.
 *
 * STUDY MATERIAL
 *   /api/mobile/uploads/{handouts,modules,resources,ai-modules} and
 *   /api/mobile/download serve the same files as the website, behind the token
 *   and the SAME guards: guardHandoutAccess (server.js) and checkHandoutAccess
 *   (lib/handoutAccess.js) — enrolled, Pre-Assessment done, the student's grade.
 */
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../config/db');
const otp = require('../lib/otp');
const { sendOtpEmail } = require('../lib/email');
const { serialize, viewKeyOf, appPath } = require('../lib/mobileSerializers');

/** The one sentence every staff account gets, at login and on every request. */
const STUDENTS_ONLY = 'The MindQuest app is for students only. Please use the website.';

/** Said when the code could not be emailed (the website's own wording). */
const OTP_EMAIL_FAILED = 'We could not send the code to your email just now. Please try again in a minute.';

const PENDING_MINUTES = 15;
const tokenDays = () => {
  const days = Number(process.env.MOBILE_TOKEN_DAYS || 30);
  return Number.isFinite(days) && days > 0 ? days : 30;
};

// ---------------------------------------------------------------------------
// Signed tokens
// ---------------------------------------------------------------------------

/** The signing secret, read on every use so a changed setting applies at once. */
function tokenSecret() {
  return String(process.env.MOBILE_TOKEN_SECRET || process.env.SESSION_SECRET || '');
}

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');
const hmac = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest();

/**
 * Sign a token.
 * @param {object} claims  { typ: 'access'|'pending', sub: userId, dev?: trustedDeviceId }
 * @param {number} lifetimeMs
 */
function signToken(claims, lifetimeMs) {
  const secret = tokenSecret();
  if (!secret) throw Object.assign(new Error('The app is not set up on the server yet (no token secret).'), { status: 503 });
  const now = Date.now();
  const payload = b64url(JSON.stringify({ ...claims, iat: now, exp: now + lifetimeMs }));
  return `${payload}.${b64url(hmac(secret, payload))}`;
}

/**
 * Check a token: well formed, signed with our secret, of the expected kind, and
 * not expired. Returns its claims, or null — never a reason, so a caller cannot
 * learn which part of a forged token was wrong.
 */
function verifyToken(token, expectedType) {
  const secret = tokenSecret();
  if (!secret || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = hmac(secret, parts[0]);
  let given;
  try { given = Buffer.from(parts[1], 'base64url'); } catch (_error) { return null; }
  // timingSafeEqual needs equal lengths; a different length is simply wrong.
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch (_error) { return null; }
  if (!claims || claims.typ !== expectedType) return null;
  if (!Number.isFinite(Number(claims.sub)) || !(Number(claims.exp) > Date.now())) return null;
  return claims;
}

/** "Bearer abc" -> "abc". */
function bearerOf(req) {
  const header = String(req.get('authorization') || '');
  return /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : '';
}

/** "juan.delacruz@gmail.com" -> "ju*********@gmail.com", for "we sent a code to …". */
function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  if (!domain) return '';
  const keep = name.slice(0, Math.min(2, name.length));
  return `${keep}${'*'.repeat(Math.max(3, name.length - keep.length))}@${domain}`;
}

/** What the app keeps of the signed-in student — never the password hash. */
function publicUser(row) {
  return {
    id: Number(row.id),
    code: String(row.user_id || ''),
    role: String(row.role || ''),
    firstName: String(row.first_name || ''),
    middleName: String(row.middle_name || ''),
    lastName: String(row.last_name || ''),
    email: String(row.email || ''),
    imagePath: String(row.image_path || '').startsWith('/uploads/profiles/') ? String(row.image_path) : null
  };
}

/** The shape the website puts in req.session.user (routes/auth.js, finalizeLogin). */
function sessionUser(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    role: row.role,
    branch_id: row.branch_id,
    assistant_scope_branch_id: row.assistant_scope_branch_id,
    first_name: row.first_name,
    middle_name: row.middle_name,
    last_name: row.last_name,
    email: row.email,
    image_path: row.image_path
  };
}

/** A registration the office has not approved is refused, as on the website. */
function approvalProblem(row) {
  const status = String(row.status || '').toLowerCase();
  if (status === 'approved') return '';
  return status === 'rejected' ? 'Your account registration was rejected by admin.' : 'Waiting for admin approval.';
}

const USER_COLUMNS = `u.id, u.user_id, u.role, u.status, u.branch_id, u.assistant_scope_branch_id,
       u.first_name, u.middle_name, u.last_name, u.email, u.image_path`;

/** The account, read fresh (not archived), or null. */
async function loadUser(userId) {
  const rows = await query(
    `SELECT TOP 1 ${USER_COLUMNS} FROM users u WHERE u.id = ? AND u.is_archived = 0`,
    [Number(userId)]
  );
  return rows[0] || null;
}

/** The id of the trusted_devices row registerTrustedDevice just wrote. */
async function trustedDeviceId(userId, deviceToken) {
  const rows = await query(
    'SELECT TOP 1 id FROM trusted_devices WHERE user_id = ? AND device_token = ? AND is_active = 1 ORDER BY id DESC',
    [Number(userId), String(deviceToken)]
  );
  return rows[0] ? Number(rows[0].id) : null;
}

/** An access token for this student on this trusted phone. */
function accessTokenFor(user, deviceId) {
  return signToken({ typ: 'access', sub: Number(user.id), dev: Number(deviceId) }, tokenDays() * 24 * 60 * 60 * 1000);
}

/** Send a fresh login code: stored first (the hourly limit), then emailed. */
async function sendLoginCode(user) {
  const code = otp.generateOtp();
  await otp.storeOtp({ userId: user.id, purpose: 'login', code });
  try {
    await sendOtpEmail({ to: user.email, otp: code, purpose: 'login' });
    return { emailSent: true };
  } catch (error) {
    console.error('[mobile OTP EMAIL ERROR]', error.message);
    return { emailSent: false };
  }
}

// ---------------------------------------------------------------------------
// requireToken: who is asking, checked on every request
// ---------------------------------------------------------------------------

/**
 * Accept the request only with a valid ACCESS token of a student who is still
 * a student, not archived, approved, and whose phone is still trusted (not
 * logged out). Then req.session = { user } for this request alone.
 */
async function requireToken(req, res, next) {
  try {
    const claims = verifyToken(bearerOf(req), 'access');
    if (!claims) {
      return res.status(401).json({ ok: false, auth: false, error: 'Please log in again.' });
    }
    const rows = await query(
      `SELECT TOP 1 ${USER_COLUMNS},
              (SELECT TOP 1 td.is_active FROM trusted_devices td WHERE td.id = ? AND td.user_id = u.id) AS device_active
         FROM users u
        WHERE u.id = ? AND u.is_archived = 0`,
      [Number(claims.dev) || 0, Number(claims.sub)]
    );
    const user = rows[0];
    if (!user) {
      return res.status(401).json({ ok: false, auth: false, error: 'Your account is no longer active. Please contact the office.' });
    }
    if (user.role !== 'student') {
      return res.status(403).json({ ok: false, auth: false, error: STUDENTS_ONLY });
    }
    if (approvalProblem(user)) {
      return res.status(403).json({ ok: false, auth: false, error: approvalProblem(user) });
    }
    if (!(user.device_active === true || Number(user.device_active) === 1)) {
      // Logged out on this phone (or the office ended its trust): log in again.
      return res.status(401).json({ ok: false, auth: false, error: 'You were logged out. Please log in again.' });
    }
    req.mobileUser = user;
    req.mobileClaims = claims;
    // A plain object, not express-session: nothing is stored between requests.
    // The no-op methods are there in case shared code calls them.
    req.session = {
      user: sessionUser(user),
      save: (callback) => callback && callback(),
      reload: (callback) => callback && callback(),
      regenerate: (callback) => callback && callback(),
      destroy: (callback) => callback && callback(),
      touch: () => {}
    };
    return next();
  } catch (error) {
    return next(error);
  }
}

// ---------------------------------------------------------------------------
// The JSON bridge in front of routes/student.js
// ---------------------------------------------------------------------------

/**
 * Is this host the site itself, so a redirect to it is not mistaken for an
 * external one? Compared by host name only, with "www." ignored: behind
 * Render's proxy the request looks like plain http, and the site answers on
 * both mindquesttutorial.com and www.mindquesttutorial.com (APP_URL).
 */
function isOwnHost(req, host) {
  const bare = (value) => String(value || '').toLowerCase().replace(/^www\./, '');
  const mine = new Set([bare(req.get('host'))]);
  if (process.env.APP_URL) {
    try { mine.add(bare(new URL(process.env.APP_URL).host)); } catch (_error) { /* ignore a bad setting */ }
  }
  return mine.has(bare(host));
}

/** Take the flash a route left for the next page, once. */
function takeFlash(req, res) {
  const flash = (res.locals && res.locals.flash) || (req.session && req.session.flash) || null;
  if (req.session) delete req.session.flash;
  return flash ? { type: String(flash.type || 'info'), message: String(flash.message || '') } : null;
}

/**
 * Turn the student routes' HTML answers into JSON, without touching the
 * routes. Only res.render and res.redirect are replaced, and only on this
 * request's response object; the website's responses are never affected.
 */
function jsonBridge(req, res, next) {
  res.render = function renderAsJson(view, locals = {}) {
    const viewKey = viewKeyOf(view, locals);
    res.json({
      ok: true,
      view: viewKey,
      title: String(locals.pageTitle || ''),
      notificationCount: Number(locals.notificationCount || 0),
      flash: takeFlash(req, res),
      data: serialize(viewKey, locals)
    });
  };

  res.redirect = function redirectAsJson(statusOrUrl, maybeUrl) {
    let target = String(typeof statusOrUrl === 'number' ? maybeUrl : statusOrUrl || '/');
    if (target === 'back') target = req.get('referer') || '/student';
    const flash = takeFlash(req, res);

    // An absolute URL: the site itself (a path, then), or somewhere else —
    // PayMongo's checkout page, which the app opens in the browser.
    if (/^https?:\/\//i.test(target)) {
      let parsed = null;
      try { parsed = new URL(target); } catch (_error) { parsed = null; }
      if (parsed && isOwnHost(req, parsed.host)) {
        target = `${parsed.pathname}${parsed.search}`;
      } else {
        return res.json({ ok: true, external: target, flash });
      }
    }
    if (target === '/login' || target.startsWith('/login?') || target.startsWith('/login/')) {
      return res.status(401).json({ ok: false, auth: false, error: (flash && flash.message) || 'Please log in again.' });
    }
    if (target === '/student' || target.startsWith('/student/') || target.startsWith('/student?')) {
      return res.json({ ok: true, redirect: appPath(target) || '/', flash });
    }
    // Anywhere else on the website (it should not happen for a student): home.
    return res.json({ ok: true, redirect: '/', flash });
  };

  next();
}

/**
 * /download answers a missing file with a redirect to /download/module/:id or
 * back to the page. Through the app those become the app's own address, or a
 * JSON error with the website's message.
 */
function downloadRedirects(req, res, next) {
  const original = res.redirect.bind(res);
  res.redirect = function redirectDownload(statusOrUrl, maybeUrl) {
    const target = String(typeof statusOrUrl === 'number' ? maybeUrl : statusOrUrl || '');
    if (target.startsWith('/download/')) return original(`/api/mobile${target}`);
    const flash = takeFlash(req, res);
    return res.status(404).json({ ok: false, error: (flash && flash.message) || 'File not found.' });
  };
  next();
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {Function} deps.serveUploadFolder   server.js: reads an upload folder (disk or Supabase)
 * @param {Function} deps.guardHandoutAccess  server.js: the handout lock of /uploads/handouts
 */
function createMobileApi({ serveUploadFolder, guardHandoutAccess }) {
  const router = express.Router();

  // The app's answers are personal: no proxy or phone may keep a copy.
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    next();
  });

  /** Is the API up? Used by the app's settings check; no login, no database. */
  router.get('/health', (req, res) => {
    res.json({ ok: true, service: 'mindquest-mobile-api', time: new Date().toISOString() });
  });

  // ---- POST /auth/login ---------------------------------------------------
  router.post('/auth/login', async (req, res, next) => {
    try {
      const email = String((req.body && req.body.email) || '').trim().toLowerCase();
      const password = String((req.body && req.body.password) || '');
      const deviceToken = String((req.body && req.body.deviceToken) || '').trim();
      if (!email || !password) {
        return res.status(400).json({ ok: false, error: 'Enter your email and password.' });
      }
      if (!tokenSecret()) {
        return res.status(503).json({ ok: false, error: 'The app is not set up on the server yet. Please use the website.' });
      }

      const rows = await query(
        `SELECT TOP 1 id, user_id, role, branch_id, assistant_scope_branch_id, password_hash,
                first_name, middle_name, last_name, email, image_path, status
           FROM users
          WHERE LOWER(email) = ? AND is_archived = 0`,
        [email]
      );
      const user = rows[0];
      if (!user) {
        // As on the website: a registration still waiting says so.
        const pending = await query(
          'SELECT TOP 1 submission_type, status FROM submissions WHERE LOWER(email) = ? ORDER BY id DESC',
          [email]
        );
        const waiting = pending[0] && pending[0].status === 'pending';
        return res.status(401).json({ ok: false, error: waiting ? 'Waiting for admin approval.' : 'Invalid email or password.' });
      }
      // The password first: the "students only" answer must not tell a
      // stranger which emails belong to staff.
      if (!(await bcrypt.compare(password, String(user.password_hash || '')))) {
        return res.status(401).json({ ok: false, error: 'Invalid email or password.' });
      }
      if (user.role !== 'student') {
        return res.status(403).json({ ok: false, error: STUDENTS_ONLY });
      }
      const notApproved = approvalProblem(user);
      if (notApproved) return res.status(403).json({ ok: false, error: notApproved });

      // A phone this student verified before skips the code (lib/otp.js: the
      // device token AND the phone's fingerprint must match, not expired).
      if (deviceToken) {
        const device = await otp.getTrustedDevice(user.id, deviceToken, otp.getDeviceFingerprint(req));
        if (device) {
          await otp.touchTrustedDevice(device.id);
          return res.json({ ok: true, token: accessTokenFor(user, device.id), deviceToken, user: publicUser(user) });
        }
      }

      // Any other phone: a code by email. Stored FIRST, so the hourly limit
      // (five codes) is respected before any mail goes out.
      let sent;
      try {
        sent = await sendLoginCode(user);
      } catch (error) {
        if (error.code === 'OTP_RATE_LIMIT') return res.status(429).json({ ok: false, error: error.message });
        throw error;
      }
      return res.json({
        ok: true,
        otpRequired: true,
        pendingToken: signToken({ typ: 'pending', sub: Number(user.id) }, PENDING_MINUTES * 60 * 1000),
        maskedEmail: maskEmail(user.email),
        emailSent: sent.emailSent,
        message: sent.emailSent ? 'A 4-digit code was sent to your email. Enter it to continue.' : OTP_EMAIL_FAILED
      });
    } catch (error) {
      return next(error);
    }
  });

  /** The student behind a pending token, still allowed to log in, or an answer. */
  async function pendingStudent(req, res) {
    const claims = verifyToken(String((req.body && req.body.pendingToken) || ''), 'pending');
    if (!claims) {
      res.status(401).json({ ok: false, auth: false, error: 'Your verification expired. Please log in again.' });
      return null;
    }
    const user = await loadUser(claims.sub);
    if (!user) {
      res.status(401).json({ ok: false, auth: false, error: 'Your account is no longer active. Please contact the office.' });
      return null;
    }
    if (user.role !== 'student') {
      res.status(403).json({ ok: false, auth: false, error: STUDENTS_ONLY });
      return null;
    }
    if (approvalProblem(user)) {
      res.status(403).json({ ok: false, auth: false, error: approvalProblem(user) });
      return null;
    }
    return user;
  }

  // ---- POST /auth/verify-otp ----------------------------------------------
  router.post('/auth/verify-otp', async (req, res, next) => {
    try {
      const user = await pendingStudent(req, res);
      if (!user) return undefined;
      const code = String((req.body && req.body.otp) || '').trim();
      if (!/^\d{4}$/.test(code)) {
        return res.status(400).json({ ok: false, error: 'Enter the 4-digit code from your email.' });
      }
      const result = await otp.verifyOtp({ userId: user.id, purpose: 'login', code });
      if (!result.ok) return res.status(400).json({ ok: false, error: result.reason });

      // This phone is trusted from now on: next time, no code (TRUSTED_DEVICE_DAYS).
      const device = await otp.registerTrustedDevice(user.id, req);
      const deviceId = device.id || await trustedDeviceId(user.id, device.token);
      return res.json({ ok: true, token: accessTokenFor(user, deviceId), deviceToken: device.token, user: publicUser(user) });
    } catch (error) {
      return next(error);
    }
  });

  // ---- POST /auth/resend-otp ----------------------------------------------
  router.post('/auth/resend-otp', async (req, res, next) => {
    try {
      const user = await pendingStudent(req, res);
      if (!user) return undefined;
      let sent;
      try {
        sent = await sendLoginCode(user);
      } catch (error) {
        if (error.code === 'OTP_RATE_LIMIT') return res.status(429).json({ ok: false, error: error.message });
        throw error;
      }
      return res.json({
        ok: true,
        maskedEmail: maskEmail(user.email),
        emailSent: sent.emailSent,
        message: sent.emailSent ? 'A new 4-digit code was sent to your email.' : OTP_EMAIL_FAILED
      });
    } catch (error) {
      return next(error);
    }
  });

  // ---- POST /auth/logout --------------------------------------------------
  // Always answers ok: the app forgets its token either way. When the token is
  // valid, its phone stops being trusted, which also ends the token itself.
  router.post('/auth/logout', async (req, res, next) => {
    try {
      const claims = verifyToken(bearerOf(req), 'access');
      if (claims) {
        if (claims.dev) {
          await query(
            'UPDATE trusted_devices SET is_active = 0, updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ? AND user_id = ?',
            [Number(claims.dev), Number(claims.sub)]
          );
        }
        const deviceToken = String((req.body && req.body.deviceToken) || '').trim();
        if (deviceToken) await otp.deactivateTrustedDevice(Number(claims.sub), deviceToken);
      }
      return res.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });

  // ---- GET /me --------------------------------------------------------------
  router.get('/me', requireToken, (req, res) => {
    res.json({ ok: true, user: publicUser(req.mobileUser) });
  });

  // ---- Study material, behind the token and the website's own guards -------
  for (const folder of ['handouts', 'modules', 'resources', 'ai-modules']) {
    const guards = folder === 'handouts' ? [requireToken, guardHandoutAccess] : [requireToken];
    router.use(`/uploads/${folder}`, ...guards, serveUploadFolder(folder, { cacheControl: 'private, no-store' }));
  }
  router.use('/download', requireToken, downloadRedirects, require('./download'));

  // ---- Every student page, through the JSON bridge ------------------------
  router.use('/student', requireToken, jsonBridge, require('./student'));

  // ---- Nothing else lives here --------------------------------------------
  router.use((req, res) => {
    res.status(404).json({ ok: false, error: 'Not found.' });
  });

  // eslint-disable-next-line no-unused-vars
  router.use((error, req, res, _next) => {
    if (error && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ ok: false, error: 'That file is too large. Profile photos may be up to 5 MB.' });
    }
    if (error && error.status === 503) {
      return res.status(503).json({ ok: false, error: error.message });
    }
    console.error('[mobile api]', error);
    // The detail stays in the server log; the phone gets a plain sentence.
    return res.status(500).json({ ok: false, error: 'Something went wrong on the server. Please try again.' });
  });

  return router;
}

module.exports = createMobileApi;
module.exports.createMobileApi = createMobileApi;
// For scripts/test-mobile-api.js and the capstone defense: the pieces on their own.
module.exports.signToken = signToken;
module.exports.verifyToken = verifyToken;
module.exports.maskEmail = maskEmail;
module.exports.STUDENTS_ONLY = STUDENTS_ONLY;
