/**
 * ANNOTATED COPY FOR DEFENSE REVIEW
 * File: routes/auth.js
 * Purpose: Authentication routes for login, OTP verification, trusted devices, session creation, and logout.
 * Notes: Comments were added to help explain the system during code defense without changing the original logic.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../config/db');
const { sendOtpEmail } = require('../lib/email');
const { generateOtp, storeOtp, verifyOtp, parseCookieHeader, getDeviceFingerprint, getTrustedDevice, registerTrustedDevice, touchTrustedDevice, TRUSTED_DEVICE_DAYS } = require('../lib/otp');
const { ensureGuest, ensureAuthenticated, getRoleHome } = require('../middleware/auth');

const router = express.Router();

// Route handler: GET request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.get('/login', ensureGuest, (req, res) => {
  res.render('login', { pageTitle: 'Login' });
});

// Function: finalizeLogin

// Role: Provides helper logic for this file.

function finalizeLogin(req, res, user) {
  req.session.user = {
    id: user.id,
    user_id: user.user_id,
    role: user.role,
    branch_id: user.branch_id,
    assistant_scope_branch_id: user.assistant_scope_branch_id,
    first_name: user.first_name,
    middle_name: user.middle_name,
    last_name: user.last_name,
    email: user.email,
    image_path: user.image_path
  };
  return res.redirect(getRoleHome(user.role));
}

// Route handler: POST request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.post('/login', ensureGuest, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const rows = await query(
      `SELECT TOP 1 id, user_id, role, branch_id, assistant_scope_branch_id, password_hash,
              first_name, middle_name, last_name, email, image_path, status
       FROM users
       WHERE LOWER(email) = ? AND is_archived = 0`,
      [email]
    );

    const user = rows[0];
    if (!user) {
      const pendingRows = await query(
        `SELECT TOP 1 submission_type, status FROM submissions WHERE LOWER(email) = ? ORDER BY id DESC`,
        [email]
      );
      if (pendingRows[0] && pendingRows[0].status === 'pending') {
        req.session.flash = { type: 'error', message: 'Waiting for admin approval.' };
      } else {
        req.session.flash = { type: 'error', message: 'Invalid email or password.' };
      }
      return res.redirect('/login');
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      req.session.flash = { type: 'error', message: 'Invalid email or password.' };
      return res.redirect('/login');
    }

    const approvalStatus = String(user.status || '').toLowerCase();
    if (['student', 'tutor'].includes(user.role) && approvalStatus !== 'approved') {
      req.session.flash = {
        type: 'error',
        message: approvalStatus === 'rejected' ? 'Your account registration was rejected by admin.' : 'Waiting for admin approval.'
      };
      return res.redirect('/login');
    }

    if (!['student', 'tutor'].includes(user.role)) {
      return finalizeLogin(req, res, user);
    }


const cookies = parseCookieHeader(req.headers.cookie || '');
const trustedToken = String(cookies.mq_device || '').trim();
const fingerprint = getDeviceFingerprint(req);
const trustedDevice = trustedToken ? await getTrustedDevice(user.id, trustedToken, fingerprint) : null;

if (trustedDevice) {
  await touchTrustedDevice(trustedDevice.id);
  return finalizeLogin(req, res, user);
}

const otp = generateOtp();
await storeOtp({ userId: user.id, purpose: 'login', code: otp });
try {
  await sendOtpEmail({ to: user.email, otp, purpose: 'login' });
  req.session.flash = { type: 'success', message: 'A 4-digit OTP was sent to your email. Enter it to continue.' };
} catch (emailErr) {
  console.error('[OTP EMAIL ERROR]', emailErr.message);
  console.log(`[OTP FALLBACK] OTP for ${user.email}: ${otp}`);
  req.session.flash = { type: 'success', message: 'OTP could not be emailed. Check the server console for your code.' };
}
req.session.pendingLogin = { user: { ...user, password_hash: undefined } };
return res.redirect('/login/verify');
  } catch (error) {
    next(error);
  }
});

// Route handler: GET request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.get('/login/verify', ensureGuest, (req, res) => {
  if (!req.session.pendingLogin?.user?.email) {
    req.session.flash = { type: 'error', message: 'Log in first to continue OTP verification.' };
    return res.redirect('/login');
  }
  return res.render('verify-otp', {
    pageTitle: 'Verify Login',
    type: 'student',
    email: req.session.pendingLogin.user.email,
    mode: 'login'
  });
});

// Route handler: POST request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.post('/login/verify', ensureGuest, async (req, res, next) => {
  try {
    const pending = req.session.pendingLogin;
    if (!pending?.user?.id) {
      req.session.flash = { type: 'error', message: 'Your login verification session expired. Please log in again.' };
      return res.redirect('/login');
    }
    const otpCode = String(req.body.otp || '').trim();
    const result = await verifyOtp({ userId: pending.user.id, purpose: 'login', code: otpCode });
    if (!result.ok) {
      req.session.flash = { type: 'error', message: result.reason };
      return res.redirect('/login/verify');
    }
    const trustedDevice = await registerTrustedDevice(pending.user.id, req);
    res.cookie('mq_device', trustedDevice.token, { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * TRUSTED_DEVICE_DAYS });
    const user = pending.user;
    delete req.session.pendingLogin;
    return finalizeLogin(req, res, user);
  } catch (error) {
    next(error);
  }
});

// Route handler: POST request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.post('/login/resend-otp', ensureGuest, async (req, res, next) => {
  try {
    const pending = req.session.pendingLogin;
    if (!pending?.user?.id || !pending?.user?.email) {
      req.session.flash = { type: 'error', message: 'Your login verification session expired. Please log in again.' };
      return res.redirect('/login');
    }
    const otp = generateOtp();
    await storeOtp({ userId: pending.user.id, purpose: 'login', code: otp });
    try {
      await sendOtpEmail({ to: pending.user.email, otp, purpose: 'login' });
      req.session.flash = { type: 'success', message: 'A new 4-digit OTP was sent to your email.' };
    } catch (emailErr) {
      console.error('[OTP EMAIL ERROR]', emailErr.message);
      console.log(`[OTP FALLBACK] OTP for ${pending.user.email}: ${otp}`);
      req.session.flash = { type: 'success', message: 'OTP could not be emailed. Check the server console for your code.' };
    }
    return res.redirect('/login/verify');
  } catch (error) {
    next(error);
  }
});

// Route handler: POST request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.post('/logout', ensureAuthenticated, (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.redirect('/login');
  });
});

module.exports = router;
