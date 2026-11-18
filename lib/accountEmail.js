/**
 * File: lib/accountEmail.js
 * Purpose: The login email of the main admin and of an Assistant Admin —
 *          changed only to a registered email, as a student's or a tutor's is.
 *
 * A student or a tutor registers with a Gmail address the system checks
 * (lib/utils.js, validateGmailAddress: "… is not a registered Gmail account"),
 * and their login codes and password resets reach them there. The admin and the
 * assistants were given addresses such as admin@mindquest.local, which no inbox
 * receives, so Forgot password cannot reach them. They keep those until they
 * change them; the change itself:
 *
 *   1. their current password, and a registered Gmail address — not the one
 *      they have, not anyone else's;
 *   2. a 4-digit code is sent to that address;
 *   3. the email changes only when the code is entered.
 *
 * So the address is proved to be a real inbox of theirs before it becomes the
 * one they log in with: a typo can never lock the account out, and Forgot
 * password works for them from then on.
 *
 * The main admin setting an assistant's address (or making an assistant
 * account) is held to the same registered-Gmail rule; the code step is for the
 * owner of the inbox, so it is the person's own change that sends one.
 */

const bcrypt = require('bcryptjs');
const { query } = require('../config/db');
const { validateGmailAddress } = require('./utils');

const PURPOSE = 'email_change';
const STAFF_ROLES = ['admin', 'admin_assistant'];

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Why an address cannot be a staff login email, or '' when it can: it must be
 * a registered Gmail address, the rule students and tutors register under.
 */
function registeredEmailProblem(email) {
  const gmail = validateGmailAddress(normalizeEmail(email));
  return gmail.ok ? '' : gmail.message;
}

/** Throws when the address is not a registered email. */
function requireRegisteredEmail(email) {
  const problem = registeredEmailProblem(email);
  if (problem) throw new Error(problem);
  return normalizeEmail(email);
}

async function loadStaff(userId) {
  const { getUserById } = require('./data');
  const user = await getUserById(Number(userId));
  if (!user || Number(user.is_archived) === 1 || !STAFF_ROLES.includes(user.role)) {
    throw new Error('Only the admin and an assistant admin change their email here.');
  }
  return user;
}

/**
 * Step 1: check the change and send a code to the NEW address. Nothing is
 * changed yet. Returns { email } — the address the code went to, which the
 * caller keeps (the session) until the code comes back.
 *
 * @param {object} input
 * @param {number} input.userId
 * @param {string} input.newEmail
 * @param {string} input.currentPassword
 * @param {Function} [input.send]  ({ to, otp, purpose }) — lib/email.js sendOtpEmail
 */
async function requestEmailChange(input = {}) {
  const user = await loadStaff(input.userId);
  const password = String(input.currentPassword || '');
  if (!password) throw new Error('Enter your current password.');
  if (!(await bcrypt.compare(password, user.password_hash || ''))) {
    throw new Error('Current password is incorrect.');
  }
  const email = requireRegisteredEmail(input.newEmail);
  if (email === normalizeEmail(user.email)) throw new Error('That is already your email.');
  const { isEmailTaken } = require('./data');
  if (await isEmailTaken(email, user.id)) throw new Error('That email is already used by another account.');

  const { generateOtp, storeOtp } = require('./otp');
  const send = input.send || require('./email').sendOtpEmail;
  const otp = generateOtp();
  await storeOtp({ userId: user.id, purpose: PURPOSE, code: otp });
  try {
    await send({ to: email, otp, purpose: PURPOSE });
  } catch (error) {
    console.error('[accountEmail] could not send the code:', error.message);
    throw new Error('The code could not be sent to that email just now. Check the address and try again in a minute.');
  }
  return { email };
}

/** Send a fresh code to the address a change is waiting on. */
async function resendEmailChange(input = {}) {
  const user = await loadStaff(input.userId);
  const email = requireRegisteredEmail(input.pendingEmail);
  const { generateOtp, storeOtp } = require('./otp');
  const send = input.send || require('./email').sendOtpEmail;
  const otp = generateOtp();
  await storeOtp({ userId: user.id, purpose: PURPOSE, code: otp });
  try {
    await send({ to: email, otp, purpose: PURPOSE });
  } catch (error) {
    console.error('[accountEmail] could not resend the code:', error.message);
    throw new Error('The code could not be sent just now. Please try again in a minute.');
  }
  return { email };
}

/**
 * Step 2: the code from the new inbox — and only then does the email change.
 * Returns { email }.
 */
async function confirmEmailChange(input = {}) {
  const user = await loadStaff(input.userId);
  const email = requireRegisteredEmail(input.pendingEmail);
  const code = String(input.code || '').trim();
  if (!/^\d{4}$/.test(code)) throw new Error('Enter the 4-digit code sent to your new email.');
  const { verifyOtp } = require('./otp');
  const result = await verifyOtp({ userId: user.id, purpose: PURPOSE, code });
  if (!result.ok) throw new Error(result.reason);
  const { isEmailTaken } = require('./data');
  if (await isEmailTaken(email, user.id)) throw new Error('That email was taken by another account in the meantime.');

  // extra.email mirrors the login email on an assistant account (as
  // createAssistantAccount and updateAssistantAccount keep it).
  const extra = { ...(user.extra || {}), email_verified_at: new Date().toISOString() };
  if (user.role === 'admin_assistant') extra.email = email;
  delete extra.visible_password;
  await query(
    'UPDATE users SET email = ?, extra_json = ?, updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?',
    [email, JSON.stringify(extra), user.id]
  );
  return { email };
}

module.exports = {
  PURPOSE,
  registeredEmailProblem,
  requireRegisteredEmail,
  requestEmailChange,
  resendEmailChange,
  confirmEmailChange
};
