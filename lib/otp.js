/**
 * ANNOTATED COPY FOR DEFENSE REVIEW
 * File: lib/otp.js
 * Purpose: OTP and trusted-device utilities. This file generates codes/tokens, hashes and verifies OTPs, and manages trusted devices for safer logins.
 * Notes: Comments were added to help explain the system during code defense without changing the original logic.
 */

const crypto = require('crypto');
const { query } = require('../config/db');

// Function: generateOtp

// Role: Provides helper logic for this file.

function generateOtp() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// Function: hashOtp

// Role: Provides helper logic for this file.

function hashOtp(otp) {
  return crypto.createHash('sha256').update(String(otp)).digest('hex');
}

const TRUSTED_DEVICE_DAYS = Number(process.env.TRUSTED_DEVICE_DAYS || 30);

// Function: generateDeviceToken

// Role: Provides helper logic for this file.

function generateDeviceToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Function: parseCookieHeader

// Role: Provides helper logic for this file.

function parseCookieHeader(cookieHeader = '') {
  return String(cookieHeader || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const idx = part.indexOf('=');
      if (idx === -1) return acc;
      const key = part.slice(0, idx).trim();
      const value = decodeURIComponent(part.slice(idx + 1).trim());
      acc[key] = value;
      return acc;
    }, {});
}

// Function: getDeviceFingerprint

// Role: Provides helper logic for this file.

function getDeviceFingerprint(req) {
  const ua = String(req.get('user-agent') || '').slice(0, 255);
  const lang = String(req.get('accept-language') || '').slice(0, 120);
  const platform = String(req.get('sec-ch-ua-platform') || '').slice(0, 120);
  return `${ua}|${lang}|${platform}`;
}

// Function: storeOtp

// Role: Handles a reusable server-side operation used by this module.

async function storeOtp({ userId, purpose, code, expiresInMinutes = 10 }) {
  if (!userId) throw new Error('User ID is required to store OTP.');
  const otpHash = hashOtp(code);
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000);
  await query('UPDATE otps SET is_used = 1, updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE user_id = ? AND purpose = ? AND is_used = 0', [Number(userId), purpose]);
  await query(
    `INSERT INTO otps (user_id, purpose, otp_code, expires_at, is_used)
     VALUES (?, ?, ?, ?, 0)`,
    [Number(userId), purpose, otpHash, expiresAt]
  );
}

// Function: verifyOtp

// Role: Handles a reusable server-side operation used by this module.

async function verifyOtp({ userId, purpose, code }) {
  if (!userId) return { ok: false, reason: 'Your verification session expired. Please log in again.' };
  const rows = await query(
    `SELECT TOP 1 * FROM otps
     WHERE user_id = ? AND purpose = ? AND is_used = 0
     ORDER BY created_at DESC`,
    [Number(userId), purpose]
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: 'No active OTP found. Please request a new code.' };
  const now = new Date();
  if (row.expires_at && new Date(row.expires_at) < now) {
    await query('UPDATE otps SET is_used = 1, updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?', [row.id]);
    return { ok: false, reason: 'OTP has expired. Please request a new code.' };
  }
  if (hashOtp(code) !== row.otp_code) {
    return { ok: false, reason: 'Invalid OTP. Please try again.' };
  }
  await query('UPDATE otps SET is_used = 1, used_at = DATEADD(hour, 8, GETUTCDATE()), updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?', [row.id]);
  return { ok: true, row };
}


// Function: getTrustedDevice


// Role: Handles a reusable server-side operation used by this module.


async function getTrustedDevice(userId, token, fingerprint) {
  if (!userId || !token) return null;
  const rows = await query(
    `SELECT TOP 1 * FROM trusted_devices
     WHERE user_id = ? AND device_token = ? AND is_active = 1
     ORDER BY id DESC`,
    [userId, token]
  );
  const device = rows[0] || null;
  if (!device) return null;
  if (String(device.device_fingerprint || '') !== String(fingerprint || '')) return null;

  const now = new Date();
  const expiresAt = device.expires_at ? new Date(device.expires_at) : null;
  if (expiresAt && expiresAt < now) {
    await query('UPDATE trusted_devices SET is_active = 0, updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?', [device.id]);
    return null;
  }
  return device;
}

// Function: deactivateTrustedDevice

// Role: Handles a reusable server-side operation used by this module.

async function deactivateTrustedDevice(userId, token) {
  if (!userId || !token) return;
  await query('UPDATE trusted_devices SET is_active = 0, updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE user_id = ? AND device_token = ?', [userId, token]);
}

// Function: registerTrustedDevice

// Role: Handles a reusable server-side operation used by this module.

async function registerTrustedDevice(userId, req) {
  const token = generateDeviceToken();
  const fingerprint = getDeviceFingerprint(req);
  const ua = String(req.get('user-agent') || '').slice(0, 255);
  const expiresAt = new Date(Date.now() + TRUSTED_DEVICE_DAYS * 24 * 60 * 60 * 1000);
  await query(
    `INSERT INTO trusted_devices (user_id, device_token, device_fingerprint, user_agent, last_used_at, expires_at, is_active)
     VALUES (?, ?, ?, ?, DATEADD(hour, 8, GETUTCDATE()), ?, 1)`,
    [userId, token, fingerprint, ua, expiresAt]
  );
  return { token, expiresAt };
}

// Function: touchTrustedDevice

// Role: Handles a reusable server-side operation used by this module.

async function touchTrustedDevice(id) {
  if (!id) return;
  const expiresAt = new Date(Date.now() + TRUSTED_DEVICE_DAYS * 24 * 60 * 60 * 1000);
  await query('UPDATE trusted_devices SET last_used_at = DATEADD(hour, 8, GETUTCDATE()), expires_at = ?, updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?', [expiresAt, id]);
}

module.exports = {
  generateOtp,
  storeOtp,
  verifyOtp,
  parseCookieHeader,
  getDeviceFingerprint,
  getTrustedDevice,
  deactivateTrustedDevice,
  registerTrustedDevice,
  touchTrustedDevice,
  TRUSTED_DEVICE_DAYS
};
