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
  computeAge,
  fullName,
  branchName,
  slugify,
  normalizeArray,
  money,
  generateUserCode,
  validateStrongPassword,
  allowedContactRoles,
  roleLabel,
  branchAddress,
  titleCaseName
};
