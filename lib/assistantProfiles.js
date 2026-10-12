/**
 * File: lib/assistantProfiles.js
 * Purpose: Registered Assistant Admins — the person, before (and after) they
 * are given a login.
 *
 * User Management → "Branch Assistant Admin Account" offers two steps:
 *
 *   Register Assistant Admin            records who the person is: name,
 *                                       address, birthdate (age worked out from
 *                                       it), contact number.
 *   Create Account for Assistant Admin  the existing account form — branch,
 *                                       email, password — except the name is
 *                                       picked from the people registered here.
 *
 * A registered person can be given ONE account: creating it fills in user_id,
 * and the account form only offers people whose user_id is still empty.
 */

const { query } = require('../config/db');
const { computeAge, titleCaseName, fullName } = require('./utils');

/** The youngest an Assistant Admin may be — they run a branch's accounts. */
const MIN_ASSISTANT_AGE = 18;

function clean(value, max = 200) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}

/**
 * Check and tidy what the Register form sent. Throws a message a person can act
 * on; returns the row to store.
 */
function validateAssistantProfile(input = {}) {
  const firstName = titleCaseName(clean(input.first_name, 100));
  const middleName = titleCaseName(clean(input.middle_name, 100));
  const lastName = titleCaseName(clean(input.last_name, 100));
  const address = clean(input.address, 500);
  const contactNumber = clean(input.contact_number, 50);
  const birthDate = clean(input.birth_date, 10);

  if (!firstName || !lastName) throw new Error('Enter the assistant admin\'s first and last name.');
  if (/[^A-Za-zÀ-ÿÑñ.' -]/.test(`${firstName}${middleName}${lastName}`)) {
    throw new Error('A name may only contain letters, spaces, periods, apostrophes and hyphens.');
  }
  if (!address) throw new Error('Enter the assistant admin\'s address.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) throw new Error('Enter the assistant admin\'s birthdate.');

  const age = computeAge(birthDate);
  if (age === null || age < 0) throw new Error('That birthdate is not valid.');
  if (new Date(birthDate) > new Date()) throw new Error('The birthdate cannot be in the future.');
  if (age < MIN_ASSISTANT_AGE) throw new Error(`An assistant admin must be at least ${MIN_ASSISTANT_AGE} years old.`);

  const digits = contactNumber.replace(/[\s()-]/g, '');
  if (!/^(\+?63|0)9\d{9}$/.test(digits)) {
    throw new Error('Enter a mobile number like 09XXXXXXXXX or +639XXXXXXXXX.');
  }

  return { firstName, middleName, lastName, address, birthDate, age, contactNumber: digits };
}

/** Add a row's display fields: full name, and whether they have an account yet. */
function shape(row) {
  if (!row) return row;
  return {
    ...row,
    full_name: fullName({ first_name: row.first_name, middle_name: row.middle_name, last_name: row.last_name }),
    has_account: !!row.user_id
  };
}

/**
 * Register an Assistant Admin (no login yet).
 * @returns {Promise<number>} the new profile's id
 */
async function registerAssistantProfile(input, actor) {
  const profile = validateAssistantProfile(input);

  // The same person twice is almost certainly a double click or a re-entry.
  const existing = await query(
    `SELECT TOP 1 id FROM assistant_admin_profiles
      WHERE is_archived = 0 AND LOWER(first_name) = LOWER(?) AND LOWER(middle_name) = LOWER(?)
        AND LOWER(last_name) = LOWER(?) AND birth_date = ?`,
    [profile.firstName, profile.middleName, profile.lastName, profile.birthDate]
  );
  if (existing.length) throw new Error(`${fullName({ first_name: profile.firstName, middle_name: profile.middleName, last_name: profile.lastName })} is already registered.`);

  const result = await query(
    `INSERT INTO assistant_admin_profiles
       (first_name, middle_name, last_name, address, birth_date, age, contact_number, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [profile.firstName, profile.middleName, profile.lastName, profile.address, profile.birthDate,
      profile.age, profile.contactNumber, actor?.id || null]
  );
  return result.insertId;
}

/**
 * Registered Assistant Admins, newest first.
 * @param {object} [options] { withoutAccount } only those still waiting for a login
 */
async function getAssistantProfiles(options = {}) {
  const rows = await query(
    `SELECT p.*, u.user_id AS account_code, u.email AS account_email, u.is_archived AS account_archived,
            b.name AS branch_name
       FROM assistant_admin_profiles p
       LEFT JOIN users u ON u.id = p.user_id
       LEFT JOIN branches b ON b.id = u.assistant_scope_branch_id
      WHERE p.is_archived = 0 ${options.withoutAccount ? 'AND p.user_id IS NULL' : ''}
      ORDER BY p.created_at DESC, p.id DESC`
  );
  return rows.map(shape);
}

async function getAssistantProfileById(id) {
  const rows = await query('SELECT TOP 1 * FROM assistant_admin_profiles WHERE id = ? AND is_archived = 0', [id]);
  return shape(rows[0] || null);
}

/** The registered details behind an assistant's account, for their profile page. */
async function getAssistantProfileForUser(userId) {
  const rows = await query('SELECT TOP 1 * FROM assistant_admin_profiles WHERE user_id = ?', [userId]);
  return shape(rows[0] || null);
}

module.exports = {
  MIN_ASSISTANT_AGE,
  validateAssistantProfile,
  registerAssistantProfile,
  getAssistantProfiles,
  getAssistantProfileById,
  getAssistantProfileForUser
};
