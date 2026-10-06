/**
 * ANNOTATED COPY FOR DEFENSE REVIEW
 * File: lib/utils.js
 * Purpose: Reusable formatting and validation helpers used in routes, views, and the data layer.
 * Notes: Comments were added to help explain the system during code defense without changing the original logic.
 */

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const APP_TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Manila';

// Function: safeJsonArray

// Role: Provides helper logic for this file.

function safeJsonArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

// Function: safeJsonObject

// Role: Provides helper logic for this file.

function safeJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

// Function: toAppTime

// Role: Provides helper logic for this file.

function toAppTime(date) {
  if (!date) return null;

  if (typeof date === 'string') {
    const raw = date.trim();
    if (!raw) return null;

    const hasExplicitZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(raw);
    const normalized = raw.replace(' ', 'T');
    const parsed = hasExplicitZone
      ? dayjs(normalized).tz(APP_TIMEZONE)
      : dayjs.tz(normalized, APP_TIMEZONE);
    return parsed.isValid() ? parsed : null;
  }

  const source = dayjs(date);
  return source.isValid() ? source.tz(APP_TIMEZONE) : null;
}

// Function: formatDate

// Role: Provides helper logic for this file.

function formatDate(date, fallback = '-') {
  const d = toAppTime(date);
  return d ? d.format('MMM DD, YYYY') : fallback;
}

// Function: formatDateTime

// Role: Provides helper logic for this file.

function formatDateTime(date, fallback = '-') {
  const d = toAppTime(date);
  return d ? d.format('MMM DD, YYYY hh:mm A') : fallback;
}

// Function: toInputDate

// Role: Provides helper logic for this file.

function toInputDate(date) {
  const d = toAppTime(date);
  return d ? d.format('YYYY-MM-DD') : '';
}

// Function: plusOneMonth

// Role: Provides helper logic for this file.

function plusOneMonth(date) {
  return dayjs(date || new Date()).add(1, 'month').format('YYYY-MM-DD');
}

/**
 * Today as a plain YYYY-MM-DD, in the centre's own timezone.
 *
 * Enrolment cycles are counted in whole days from the day a subject was taken
 * out, so they must not be anchored to a timestamp: a subject enrolled at
 * 11pm and one enrolled at 1am the "same evening" would otherwise get cycles a
 * day apart. toAppTime is what the rest of the app formats dates through, so it
 * is what decides which day it is here too.
 */
function todayDate() {
  const d = toAppTime(new Date());
  return d ? d.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD');
}

// Function: computeAge

// Role: Provides helper logic for this file.

function computeAge(birthDate) {
  if (!birthDate) return null;
  const d = dayjs(birthDate);
  if (!d.isValid()) return null;
  return dayjs().diff(d, 'year');
}


// Function: titleCaseName


// Role: Provides helper logic for this file.


function titleCaseName(value) {
  const raw = String(value || '').trim().replace(/\s+/g, ' ');
  if (!raw) return '';
  return raw
    .split(' ')
    .map((part) => part
      .split('-')
      .map((piece) => piece ? piece.charAt(0).toUpperCase() + piece.slice(1).toLowerCase() : '')
      .join('-'))
    .join(' ');
}

// Function: fullName

// Role: Provides helper logic for this file.

function fullName(person) {
  if (!person) return '';
  return [person.first_name, person.middle_name, person.last_name].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

// Function: branchName

// Role: Provides helper logic for this file.

function branchName(branches, id) {
  const found = branches.find((item) => Number(item.id) === Number(id));
  return found ? found.name : '-';
}

// Function: slugify

// Role: Provides helper logic for this file.

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Function: normalizeArray

// Role: Provides helper logic for this file.

function normalizeArray(input) {
  if (Array.isArray(input)) return input.filter(Boolean).map((value) => String(value).trim()).filter(Boolean);
  if (typeof input === 'string') {
    // A stored JSON list ('["ENGLISH","FILIPINO"]') is read as the list it is.
    // Split on commas, it became '["ENGLISH"' and '"FILIPINO"]' — names that
    // match no subject, which is how saving a profile used to wipe a tutor's
    // subjects and unassign their students.
    const trimmed = input.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return normalizeArray(parsed);
      } catch (_error) {
        // Not JSON after all: fall through to the comma list.
      }
    }
    return input.split(',').map((value) => value.trim()).filter(Boolean);
  }
  return [];
}

// Function: money

// Role: Provides helper logic for this file.

function money(value) {
  const amount = Number(value || 0);
  return amount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Function: generateUserCode

// Role: Provides helper logic for this file.

function generateUserCode(role, id) {
  const prefixMap = {
    admin: 'ADM',
    admin_assistant: 'AST',
    student: 'STD',
    tutor: 'TTR'
  };
  const prefix = prefixMap[role] || 'USR';
  return `${prefix}-${String(id).padStart(4, '0')}`;
}


// Function: validateStrongPassword


// Role: Provides helper logic for this file.


function validateStrongPassword(password) {
  const value = String(password || '');
  const checks = {
    minLength: value.length >= 8,
    uppercase: /[A-Z]/.test(value),
    lowercase: /[a-z]/.test(value),
    number: /\d/.test(value),
    special: /[^A-Za-z0-9]/.test(value)
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    message: 'Password must be at least 8 characters and include uppercase, lowercase, number, and special character.'
  };
}

/**
 * Whether an address could be a real Gmail account.
 *
 * Google does not tell anyone whether a particular Gmail account exists —
 * there is no API for it, and probing its mail servers gets the sender
 * blocklisted — so this checks what Gmail itself requires of every account:
 * @gmail.com, and a username of 6 to 30 letters, numbers and periods that does
 * not start or end with a period or have two in a row. An address that fails
 * cannot belong to anyone, so registration stops there and says so. Anything
 * after a "+" is a Gmail alias and still reaches the account.
 *
 * The same rules run in the browser (public/js/registration.js) so the
 * warning shows while the address is being typed.
 */
function validateGmailAddress(email) {
  const value = String(email || '').trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at < 1 || value.slice(at + 1) !== 'gmail.com') {
    return { ok: false, message: 'Please use a Gmail address ending in @gmail.com.' };
  }
  const username = value.slice(0, at).split('+')[0];
  const letters = username.replace(/\./g, '');
  const valid = /^[a-z0-9.]+$/.test(username)
    && !username.startsWith('.')
    && !username.endsWith('.')
    && !username.includes('..')
    && username.length >= 6
    && letters.length <= 30;
  if (!valid) {
    return {
      ok: false,
      message: `${value} is not a registered Gmail account. A Gmail username has 6 to 30 letters, numbers or periods. `
        + 'Create your Gmail account first at accounts.google.com, then register with it.'
    };
  }
  return { ok: true, message: '' };
}

// Function: allowedContactRoles

// Role: Provides helper logic for this file.

function allowedContactRoles(role) {
  if (role === 'student') return ['student', 'tutor'];
  if (role === 'tutor') return ['student', 'tutor'];
  return [];
}

const BRANCH_ADDRESS_MAP = {
  'MAIN BRANCH': 'Purok 4, Block 7, Brgy. Conel, General Santos City',
  'MABUHAY BRANCH': 'Mabuhay Branch, General Santos City',
  'FATIMA BRANCH': 'Fatima Branch, General Santos City',
  'CALUMPANG BRANCH': 'Calumpang Branch, General Santos City',
  'BAWING BRANCH': 'Bawing Branch, General Santos City',
  'Conel Branch': 'Purok 4, Block 7, Brgy. Conel, General Santos City'
};

// Function: branchAddress

// Role: Provides helper logic for this file.

function branchAddress(name) {
  return BRANCH_ADDRESS_MAP[String(name || '').trim()] || String(name || '').trim();
}

// Function: roleLabel

// Role: Provides helper logic for this file.

function roleLabel(role) {
  if (role === 'admin_assistant') return 'Admin Assistant';
  return role.charAt(0).toUpperCase() + role.slice(1);
}

module.exports = {
  safeJsonArray,
  safeJsonObject,
  formatDate,
  formatDateTime,
  toInputDate,
  plusOneMonth,
  todayDate,
  computeAge,
  fullName,
  branchName,
  slugify,
  normalizeArray,
  money,
  generateUserCode,
  validateStrongPassword,
  validateGmailAddress,
  allowedContactRoles,
  roleLabel,
  branchAddress,
  titleCaseName
};
