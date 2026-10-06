/**
 * ANNOTATED COPY FOR DEFENSE REVIEW
 * File: lib/data.js
 * Purpose: Main data-access and business-logic layer. This file contains most of the CRUD operations and workflow rules used by every module in the system.
 
 */

const bcrypt = require('bcryptjs');
const dayjs = require('dayjs');
const { query, withTransaction } = require('../config/db');
const {
  safeJsonArray,
  safeJsonObject,
  fullName,
  plusOneMonth,
  todayDate,
  generateUserCode,
  allowedContactRoles,
  titleCaseName
} = require('./utils');
const { determineLevel } = require('../config/levelThresholds');
// Who was under which Assistant Admin. Synced after anything that changes who
// is in a branch, so an assistant's roster survives their being replaced.
const { syncAssistantRostersSafely } = require('./assistantRoster');

/**
 * ₱1,800 PER SUBJECT, per month (Phase 4.1) — defined in lib/billing.js, which
 * is where prices live.
 *
 * This used to be the whole bill: one flat ₱1,800 whatever a student was
 * enrolled in, so a second subject was free. It is now the unit price, and the
 * bill is subjectCount × this — see recalculateStudentBilling, which is the only
 * thing allowed to set full_bill from enrolment.
 *
 * MONTHLY_FULL_BILL is kept as an alias because it is exported and read
 * elsewhere; new code should use SUBJECT_MONTHLY_FEE, which says what it is.
 */
const { SUBJECT_MONTHLY_FEE } = require('./billing');
const MONTHLY_FULL_BILL = SUBJECT_MONTHLY_FEE;
// Declared up here rather than beside resolveModuleNumber: module.exports runs
// before that point in the file, and a `const` read before its declaration is a
// ReferenceError, not undefined.
const MAX_MODULE_NUMBER = 99;
const TUTOR_YEAR_LEVEL_OPTIONS = ['Preschool', 'Primary School', 'Junior High School', 'Senior High School'];
const FIXED_TIME_SLOTS = ['7:00-8:00 AM', '8:00-9:00 AM', '9:00-10:00 AM', '11:00-12:00 PM', '1:00-2:00 PM', '2:00-3:00 PM', '3:00-4:00 PM', '5:00-6:00 PM', '6:00-7:00 PM'];

/**
 * What a student is told when they try to change a tutor or schedule that is
 * already set (Phase 5). One sentence, in one place, so every route that
 * enforces the rule explains it the same way.
 */
const TUTOR_LOCKED_MESSAGE = 'Your subjects already have a tutor and a time schedule. '
  + 'Only an admin can change them — please message the office if you need a different schedule.';

// Function: normalizeTutorYearLevels

// Role: Provides helper logic for this file.

/**
 * The student form's wording for the same four levels. Tutors register with
 * TUTOR_YEAR_LEVEL_OPTIONS, but the admin profile editor used to offer these
 * instead — and the filter below dropped anything it did not recognise, so
 * saving a tutor's profile silently emptied their year levels. Both spellings
 * are now accepted and stored in the tutor form.
 */
const TUTOR_YEAR_LEVEL_ALIASES = {
  'pre school level': 'Preschool',
  'preschool level': 'Preschool',
  'pre-school level': 'Preschool',
  'pre school': 'Preschool',
  'primary level': 'Primary School',
  'elementary': 'Primary School',
  'junior high level': 'Junior High School',
  'senior high level': 'Senior High School'
};

function normalizeTutorYearLevels(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .flatMap((value) => Array.isArray(value) ? value : String(value || '').split(','))
    .map((value) => String(value || '').trim())
    .map((value) => (TUTOR_YEAR_LEVEL_OPTIONS.includes(value)
      ? value
      : TUTOR_YEAR_LEVEL_ALIASES[value.toLowerCase()] || ''))
    .filter(Boolean))];
}

// Function: syncTutorYearLevels

// Role: Handles a reusable server-side operation used by this module.

async function syncTutorYearLevels(tutorId, yearLevels = [], connection = null) {
  if (!Number(tutorId)) return;
  const executor = connection && typeof connection.query === 'function'
    ? (sqlText, params = []) => connection.query(sqlText, params)
    : (sqlText, params = []) => query(sqlText, params);
  const normalized = normalizeTutorYearLevels(yearLevels);
  await executor('DELETE FROM tutor_year_levels WHERE tutor_id = ?', [Number(tutorId)]);
  for (const level of normalized) {
    await executor('INSERT INTO tutor_year_levels (tutor_id, year_level) VALUES (?, ?)', [Number(tutorId), level]);
  }
}


// Function: parseRowArrays


// Role: Provides helper logic for this file.


/**
 * A list of names (subjects, supports) as it should have been stored.
 *
 * Profile saves used to split the stored JSON on commas, so a tutor's
 * ["ENGLISH","FILIPINO"] came back as '["ENGLISH"' and '"FILIPINO"]' — names
 * that match no subject. The tutor then vanished from My Subjects and the
 * cleanup that followed unassigned their students. This reads such a list back
 * as the names it was meant to hold, so an account already damaged recovers on
 * its next read instead of needing a hand-edit of the database.
 */
function repairNameList(values = []) {
  const out = [];
  for (const raw of (Array.isArray(values) ? values : [values])) {
    let text = String(raw ?? '').trim();
    if (!text) continue;
    if (text.startsWith('[') && text.endsWith(']')) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          out.push(...repairNameList(parsed));
          continue;
        }
      } catch (_error) {
        // A fragment rather than a whole list; cleaned below.
      }
    }
    if (/^[\["]|["\]]$/.test(text)) {
      text = text.replace(/^\[+/, '').replace(/\]+$/, '').replace(/^"+/, '').replace(/"+$/, '').replace(/\\"/g, '"').trim();
    }
    if (text) out.push(text);
  }
  return [...new Set(out)];
}

function parseRowArrays(row) {
  if (!row) return row;
  const extra = safeJsonObject(row.extra_json);
  return {
    ...row,
    first_name: titleCaseName(row.first_name),
    middle_name: titleCaseName(row.middle_name),
    last_name: titleCaseName(row.last_name),
    subjects: repairNameList(safeJsonArray(row.subjects_json)),
    supports: repairNameList(safeJsonArray(row.support_json)),
    extra: {
      ...extra,
      assistant_name: titleCaseName(extra.assistant_name)
    }
  };
}

// Function: parseAssessmentTemplateRow

// Role: Provides helper logic for this file.

function parseAssessmentTemplateRow(row) {
  if (!row) return row;
  return {
    ...row,
    target_subject_ids: safeJsonArray(row.target_subject_ids_json).map((value) => Number(value)).filter(Boolean),
    target_year_levels: safeJsonArray(row.target_year_levels_json).map((value) => String(value || '').trim()).filter(Boolean),
    target_grade_levels: safeJsonArray(row.target_grade_levels_json).map((value) => String(value || '').trim()).filter(Boolean)
  };
}

// Function: buildScopeClause

// Role: Provides helper logic for this file.

function buildScopeClause(scopeBranchId, columnName = 'u.branch_id') {
  if (!scopeBranchId) return { sql: '', params: [] };
  return { sql: ` AND ${columnName} = ? `, params: [scopeBranchId] };
}

// Function: normalizeSubjectName

// Role: Provides helper logic for this file.

function normalizeSubjectName(name) {
  const raw = String(name || '').trim().replace(/\s+/g, ' ');
  if (!raw) throw new Error('Subject name is required.');
  return raw.toUpperCase();
}

/**
 * Does this tutor teach this subject? Their subject list (repaired, so a list
 * damaged by the old profile save still counts), minus any subject archived
 * for them, compared without regard to case or spacing.
 *
 * The one place the question is answered: assigning a tutor, listing who may
 * be picked for a subject, and accepting a student's request all ask it, and
 * they must not disagree.
 */
function tutorTeachesSubject(tutor, subjectName) {
  if (!tutor || !subjectName) return false;
  const key = String(subjectName).trim().replace(/\s+/g, ' ').toUpperCase();
  const keyOf = (name) => String(name || '').trim().replace(/\s+/g, ' ').toUpperCase();
  const archived = new Set(repairNameList(safeJsonArray(tutor.extra?.archived_subjects || [])).map(keyOf));
  if (archived.has(key)) return false;
  const taught = Array.isArray(tutor.subjects) ? tutor.subjects : safeJsonArray(tutor.subjects_json || '[]');
  return repairNameList(taught).map(keyOf).includes(key);
}

// Function: canonicalizeSubjectNames

// Role: Handles a reusable server-side operation used by this module.

async function canonicalizeSubjectNames(subjectNames = []) {
  // Repaired first, so a damaged list is written back clean instead of being
  // stored again as names no subject has.
  const normalizedNames = uniqueNames(repairNameList(subjectNames)).map((name) => normalizeSubjectName(name));
  if (!normalizedNames.length) return [];
  const rows = await query('SELECT id, name FROM subjects WHERE is_archived = 0 ORDER BY name ASC');
  const subjectMap = new Map(rows.map((row) => [normalizeSubjectName(row.name), row.name]));
  return [...new Set(normalizedNames.map((name) => subjectMap.get(name) || name))];
}

// Function: normalizeBranchName

// Role: Provides helper logic for this file.

function normalizeBranchName(name) {
  const raw = String(name || '').trim().replace(/\s+/g, ' ');
  if (!raw) throw new Error('Branch name is required.');
  if (/[^A-Za-z0-9\s]/.test(raw)) throw new Error('Branch name must not contain special characters.');
  const normalized = raw.toUpperCase();
  if (!normalized.endsWith('BRANCH')) throw new Error("Branch name must end with 'BRANCH'.");
  return normalized;
}

// Function: uniqueNames

// Role: Provides helper logic for this file.

function uniqueNames(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values]).map((value) => String(value || '').trim()).filter(Boolean))];
}

// Function: normalizeBranchIds

// Role: Provides helper logic for this file.

function normalizeBranchIds(values = []) {
  const rawValues = Array.isArray(values) ? values : [values];
  return [...new Set(rawValues.flatMap((value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return [];
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) return parsed;
        } catch (_error) {}
      }
      if (trimmed.includes(',')) {
        return trimmed.split(',').map((item) => item.trim()).filter(Boolean);
      }
      return [trimmed];
    }
    return [value];
  }).map((value) => Number(value)).filter(Boolean))];
}

// Function: normalizeYearLevels

// Role: Provides helper logic for this file.

function normalizeYearLevels(values = []) {
  const rawValues = Array.isArray(values) ? values : [values];
  return [...new Set(rawValues.flatMap((value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return [];
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) return parsed;
        } catch (_error) {}
      }
      if (trimmed.includes(',')) {
        return trimmed.split(',').map((item) => item.trim()).filter(Boolean);
      }
      return [trimmed];
    }
    return [value];
  }).map((value) => String(value || '').trim()).filter(Boolean))];
}

// Function: normalizeGradeLevels

// Role: Provides helper logic for this file.

function normalizeGradeLevels(values = []) {
  const rawValues = Array.isArray(values) ? values : [values];
  return [...new Set(rawValues.flatMap((value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return [];
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) return parsed;
        } catch (_error) {}
      }
      if (trimmed.includes(',')) {
        return trimmed.split(',').map((item) => item.trim()).filter(Boolean);
      }
      return [trimmed];
    }
    return [value];
  }).map((value) => String(value || '').trim()).filter(Boolean))];
}

// Function: normalizeYearLevelKey

// Role: Provides helper logic for this file.

function normalizeYearLevelKey(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const compact = raw.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (compact.includes('pre school')) return 'pre school level';
  if (compact.includes('preschool')) return 'pre school level';
  if (compact.includes('nursery')) return 'pre school level';
  if (compact.includes('kinder')) {
    if (compact.includes('pre school')) return 'pre school level';
    return 'primary level';
  }
  if (compact.includes('elementary')) return 'primary level';
  if (compact.includes('primary')) return 'primary level';
  if (compact.includes('junior high')) return 'junior high level';
  if (compact.includes('high school') && compact.includes('junior')) return 'junior high level';
  if (compact.includes('grade 7') || compact.includes('grade 8') || compact.includes('grade 9') || compact.includes('grade 10')) return 'junior high level';
  if (compact.includes('senior high')) return 'senior high level';
  if (compact.includes('grade 11') || compact.includes('grade 12')) return 'senior high level';
  if (compact.includes('grade 1') || compact.includes('grade 2') || compact.includes('grade 3') || compact.includes('grade 4') || compact.includes('grade 5') || compact.includes('grade 6')) return 'primary level';
  return compact;
}

// Function: getStudentYearLevelKeys

// Role: Provides helper logic for this file.

function getStudentYearLevelKeys(student) {
  const sourceValues = [
    student?.year_level,
    student?.student_year_level,
    student?.grade_level,
    student?.student_grade_level,
    [student?.year_level, student?.grade_level].filter(Boolean).join(' / '),
    [student?.student_year_level, student?.student_grade_level].filter(Boolean).join(' / ')
  ];
  const keys = new Set();
  for (const value of sourceValues) {
    for (const item of normalizeYearLevels(value || '')) {
      const key = normalizeYearLevelKey(item);
      if (key) keys.add(key);
    }
    const directKey = normalizeYearLevelKey(value || '');
    if (directKey) keys.add(directKey);
  }
  return [...keys];
}

// Function: getUserBranchIds

// Role: Provides helper logic for this file.

function getUserBranchIds(user) {
  const extraBranchIds = normalizeBranchIds(user?.extra?.branch_ids || []);
  const primaryBranchId = Number(user?.branch_id || 0);
  return [...new Set([primaryBranchId, ...extraBranchIds].filter(Boolean))];
}

// Function: getUserYearLevels

// Role: Provides helper logic for this file.

function getUserYearLevels(user) {
  const extraYearLevels = normalizeYearLevels(user?.extra?.year_levels || []);
  const primaryYearLevels = normalizeYearLevels(user?.year_level || '');
  return [...new Set([...primaryYearLevels, ...extraYearLevels].filter(Boolean))];
}

// Function: matchesTutorStudentScope

// Role: Provides helper logic for this file.

function matchesTutorStudentScope(tutor, student) {
  const tutorBranchIds = getUserBranchIds(tutor);
  const tutorYearLevels = [...new Set(getUserYearLevels(tutor).map(normalizeYearLevelKey).filter(Boolean))];
  const studentBranchId = Number(student?.branch_id || student?.student_branch_id || 0);
  const studentYearVariants = getStudentYearLevelKeys(student);

  const tutorBranchNames = uniqueNames([
    tutor?.branch_name,
    ...(Array.isArray(tutor?.branches) ? tutor.branches.map((item) => item?.name || item) : [])
  ]).map((value) => String(value || '').trim().toLowerCase());
  const studentBranchNames = uniqueNames([
    student?.branch_name,
    student?.student_branch_name
  ]).map((value) => String(value || '').trim().toLowerCase());

  const branchMatchById = !tutorBranchIds.length || (studentBranchId > 0 && tutorBranchIds.includes(studentBranchId));
  const branchMatchByName = !!tutorBranchNames.length && !!studentBranchNames.length && studentBranchNames.some((value) => tutorBranchNames.includes(value));
  const branchMatch = branchMatchById || branchMatchByName;

  const tutorYearRawValues = uniqueNames([
    ...(Array.isArray(tutor?.extra?.year_levels) ? tutor.extra.year_levels : normalizeYearLevels(tutor?.extra?.year_levels || [])),
    ...(Array.isArray(tutor?.year_level) ? tutor.year_level : normalizeYearLevels(tutor?.year_level || '')),
    tutor?.grade_level
  ]).map((value) => String(value || '').trim().toLowerCase());
  const studentYearRawValues = uniqueNames([
    ...(Array.isArray(student?.year_level) ? student.year_level : normalizeYearLevels(student?.year_level || '')),
    ...(Array.isArray(student?.student_year_level) ? student.student_year_level : normalizeYearLevels(student?.student_year_level || '')),
    student?.grade_level,
    student?.student_grade_level,
    [student?.year_level, student?.grade_level].filter(Boolean).join(' / '),
    [student?.student_year_level, student?.student_grade_level].filter(Boolean).join(' / ')
  ]).map((value) => String(value || '').trim().toLowerCase());

  const yearLevelMatchByNormalized = !tutorYearLevels.length || studentYearVariants.some((value) => tutorYearLevels.includes(value));
  const yearLevelMatchByRaw = !!tutorYearRawValues.length && !!studentYearRawValues.length && studentYearRawValues.some((value) => tutorYearRawValues.includes(value));
  const yearLevelMatch = yearLevelMatchByNormalized || yearLevelMatchByRaw;

  return { branchMatch, yearLevelMatch, isMatch: branchMatch && yearLevelMatch, tutorYearLevels, studentYearVariants };
}

// Function: getAssignableStudentsForTutor

// Role: Provides helper logic for this file.

function getAssignableStudentsForTutor(tutor, students = []) {
  return (Array.isArray(students) ? students : []).filter((student) => {
    if (!student) return false;
    if (Number(student.is_archived || 0) !== 0) return false;
    if (!Number(student.student_id || student.id || 0)) return false;
    const scopeMatch = matchesTutorStudentScope(tutor, student);
    return scopeMatch.isMatch;
  });
}

/**
 * Re-price one student's account from the subjects they are actually enrolled in.
 *
 * THE RULE (Phase 4.1): full_bill = active subjects × SUBJECT_MONTHLY_FEE.
 * One subject ₱1,800, two ₱3,600. Adding a subject therefore adds ₱1,800 without
 * anything having to remember to add it — the total is derived, never edited.
 *
 * Called after EVERY change to a student's enrolments. That is the whole design:
 * there is one function that decides what a student owes, so a new way of adding
 * a subject cannot introduce a second, disagreeing answer.
 *
 * Three things it will not do:
 *
 *  - It never drops full_bill below what has already been paid. Unenrolling a
 *    subject must not silently erase a real payment; the account keeps the
 *    larger figure and the office settles the difference deliberately.
 *  - With no active subjects it leaves the bill alone. A student between terms
 *    owes what they owed; zeroing it would write off their arrears.
 *  - It never touches payment_entries. Money is the ledger's business — this
 *    only moves what is OWED, then re-derives the summary columns from the
 *    ledger so the two cannot drift.
 *
 * payment_due follows the SOONEST subject to expire, because with independent
 * per-subject cycles (Phase 4.2) that is the next date anything is actually due.
 *
 * An enrolled student with no billing row at all gets one opened here. Accepting
 * a registration opens the account, but a student enrolled any other way — a
 * subject added from their profile, an account created by staff — used to be
 * enrolled and never billed, and so never appeared on Student Bill.
 *
 * @param {object|null} connection  a withTransaction connection, or null to run standalone
 * @param {number} studentId
 * @param {number|null} [actorId]   who caused it, recorded as posted_by on a new account
 */
async function recalculateStudentBilling(connection, studentId, actorId = null) {
  const run = connection
    ? async (sql, params) => (await connection.query(sql, params))[0]
    : async (sql, params) => query(sql, params);

  const countRows = await run(
    `SELECT COUNT(*) AS subject_count, MIN(end_date) AS next_end_date
       FROM user_subject_assignments
      WHERE student_id = ? AND is_archived = 0`,
    [studentId]
  );
  const subjectCount = Number(countRows[0]?.subject_count || 0);

  let billRows = await run('SELECT TOP 1 id, full_bill, partial_payment FROM billing WHERE student_id = ?', [studentId]);
  if (!billRows[0]) {
    if (!subjectCount) return null; // Nothing enrolled, nothing owed yet.
    await run(
      `INSERT INTO billing (
        student_id, full_bill, partial_payment, for_settlement, payment_due, payment_status, posted_by, notes
      ) VALUES (?, ?, 0.00, ?, ?, 'unpaid', ?, '')`,
      [studentId, SUBJECT_MONTHLY_FEE, SUBJECT_MONTHLY_FEE, countRows[0]?.next_end_date || plusOneMonth(new Date()), actorId || null]
    );
    billRows = await run('SELECT TOP 1 id, full_bill, partial_payment FROM billing WHERE student_id = ?', [studentId]);
  }
  const bill = billRows[0];
  if (!bill || !subjectCount) return null;

  const paidRows = await run(
    'SELECT COALESCE(SUM(amount), 0) AS paid FROM payment_entries WHERE billing_id = ?',
    [bill.id]
  );
  // The larger of ledger and stored figure, for the migrated accounts whose
  // history rows were lost — the same rule lib/billing.js applies everywhere.
  const paid = Math.max(Number(paidRows[0]?.paid || 0), Number(bill.partial_payment || 0));

  const priced = subjectCount * SUBJECT_MONTHLY_FEE;
  const fullBill = Math.max(priced, paid);
  const settlement = Math.max(fullBill - paid, 0);
  const status = fullBill > 0 && settlement === 0 ? 'paid' : paid > 0 ? 'partial' : 'unpaid';

  await run(
    `UPDATE billing
        SET full_bill = ?, partial_payment = ?, for_settlement = ?, payment_status = ?,
            payment_due = COALESCE(?, payment_due),
            updated_at = DATEADD(hour, 8, GETUTCDATE())
      WHERE id = ?`,
    [fullBill, paid, settlement, status, countRows[0]?.next_end_date || null, bill.id]
  );

  return { subjectCount, fullBill, paid, settlement, status };
}

// Function: syncStudentSubjectAssignments

// Role: Handles a reusable server-side operation used by this module.

async function syncStudentSubjectAssignments(connection, studentId, subjectNames = [], branchId = null, adminId = null) {
  const normalizedNames = await canonicalizeSubjectNames(subjectNames);
  const [subjectRows] = await connection.query('SELECT id, name FROM subjects WHERE is_archived = 0');
  const subjectMap = new Map(subjectRows.map((row) => [row.name, row]));
  const allowedSubjectIds = new Set();

  for (const subjectName of normalizedNames) {
    const subject = subjectMap.get(subjectName);
    if (!subject) continue;
    allowedSubjectIds.add(Number(subject.id));
    const [existingRows] = await connection.query(
      'SELECT * FROM user_subject_assignments WHERE student_id = ? AND subject_id = ? ORDER BY id ASC',
      [studentId, subject.id]
    );
    const activeRow = existingRows.find((row) => Number(row.is_archived || 0) === 0);
    if (activeRow) {
      await connection.query(
        'UPDATE user_subject_assignments SET branch_id = ?, updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?',
        [branchId || null, activeRow.id]
      );
      for (const duplicate of existingRows.filter((row) => Number(row.id) !== Number(activeRow.id) && Number(row.is_archived || 0) === 0)) {
        await connection.query(
          'UPDATE user_subject_assignments SET is_archived = 1, updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?',
          [duplicate.id]
        );
      }
      continue;
    }

    if (existingRows.length) {
      // Re-enrolling a subject the student dropped starts a FRESH month from
      // today (Phase 4.2). Carrying the old dates forward would hand them a
      // cycle that had already expired.
      const latest = existingRows[existingRows.length - 1];
      await connection.query(
        `UPDATE user_subject_assignments
         SET is_archived = 0, tutor_id = NULL, branch_id = ?, accepted_by = ?,
             enrolled_at = COALESCE(enrolled_at, DATEADD(hour, 8, GETUTCDATE())),
             start_date = ?, end_date = ?,
             updated_at = DATEADD(hour, 8, GETUTCDATE())
         WHERE id = ?`,
        [branchId || null, adminId || null, todayDate(), plusOneMonth(new Date()), latest.id]
      );
      continue;
    }

    // Each subject carries its own month, counted from ITS OWN enrolment date —
    // not from the student's, and not from whatever the other subjects are doing.
    await connection.query(
      `INSERT INTO user_subject_assignments (
        student_id, tutor_id, subject_id, branch_id, enrolled_at, assigned_at, accepted_by, is_archived,
        start_date, end_date
      ) VALUES (?, NULL, ?, ?, DATEADD(hour, 8, GETUTCDATE()), NULL, ?, 0, ?, ?)`,
      [studentId, Number(subject.id), branchId || null, adminId || null, todayDate(), plusOneMonth(new Date())]
    );
  }

  const [assignmentRows] = await connection.query('SELECT id, subject_id FROM user_subject_assignments WHERE student_id = ?', [studentId]);
  for (const assignment of assignmentRows) {
    if (!allowedSubjectIds.has(Number(assignment.subject_id))) {
      await connection.query(
        'UPDATE user_subject_assignments SET tutor_id = NULL, is_archived = 1, updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?',
        [assignment.id]
      );
    }
  }

  // A student's own request for a subject they have now been enrolled in by
  // staff is answered, not left waiting in the Notifications inbox for someone
  // to "accept" an enrolment that already exists.
  await connection.query(
    `UPDATE subject_enrollment_requests
        SET status = 'accepted', decided_by = ?, decided_at = DATEADD(hour, 8, GETUTCDATE()),
            updated_at = DATEADD(hour, 8, GETUTCDATE())
      WHERE student_id = ? AND status = 'pending'
        AND subject_id IN (SELECT subject_id FROM user_subject_assignments WHERE student_id = ? AND is_archived = 0)`,
    [adminId || null, studentId, studentId]
  );

  // The enrolments just changed, so the price did too (Phase 4.1). Inside the
  // same transaction, so a reader can never see the new subject list against
  // the old total.
  await recalculateStudentBilling(connection, studentId, adminId);
}


// Function: cleanupStudentTutorAssignments


// Role: Handles a reusable server-side operation used by this module.


async function cleanupStudentTutorAssignments(connection, studentId, studentSnapshot = null) {
  const student = studentSnapshot || (await getUserById(studentId));
  if (!student) return;
  const [rows] = await connection.query(
    `SELECT usa.id, usa.subject_id, s.name AS subject_name, t.id AS tutor_id, t.branch_id AS tutor_branch_id,
            t.year_level AS tutor_year_level, t.extra_json AS tutor_extra_json
     FROM user_subject_assignments usa
     INNER JOIN subjects s ON s.id = usa.subject_id
     LEFT JOIN users t ON t.id = usa.tutor_id
     WHERE usa.student_id = ? AND usa.is_archived = 0`,
    [studentId]
  );

  const studentSubjects = new Set((student.subjects || safeJsonArray(student.subjects_json || '[]')).map((name) => normalizeSubjectName(name)));
  for (const row of rows) {
    const hasStudentSubject = studentSubjects.has(normalizeSubjectName(row.subject_name || ''));
    if (!hasStudentSubject) {
      await connection.query(
        'UPDATE user_subject_assignments SET tutor_id = NULL, is_archived = 1, updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?',
        [row.id]
      );
      continue;
    }

    if (!row.tutor_id) continue;
    const tutor = {
      id: row.tutor_id,
      branch_id: row.tutor_branch_id,
      year_level: row.tutor_year_level,
      extra: safeJsonObject(row.tutor_extra_json)
    };
    const scopeMatch = matchesTutorStudentScope(tutor, student);
    if (!scopeMatch.isMatch) {
      // The slot goes with the tutor: left behind, the student held a time in
      // a diary nobody was keeping.
      await connection.query(
        'UPDATE user_subject_assignments SET tutor_id = NULL, time_slot = NULL, updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?',
        [row.id]
      );
    }
  }
}

// Function: cleanupTutorAssignments

// Role: Handles a reusable server-side operation used by this module.

async function cleanupTutorAssignments(connection, tutorId, subjectNames = [], branchId = null, tutorSnapshot = null) {
  const normalizedNames = new Set(uniqueNames(subjectNames).map((name) => String(name || '').trim()));
  const fallbackTutor = tutorSnapshot || { branch_id: branchId || null, year_level: '', extra: {} };
  const [rows] = await connection.query(
    `SELECT usa.id, usa.subject_id, s.name AS subject_name, st.branch_id AS student_branch_id,
            st.year_level AS student_year_level, st.grade_level AS student_grade_level
     FROM user_subject_assignments usa
     INNER JOIN subjects s ON s.id = usa.subject_id
     INNER JOIN users st ON st.id = usa.student_id
     WHERE usa.tutor_id = ? AND usa.is_archived = 0`,
    [tutorId]
  );

  for (const row of rows) {
    const invalidSubject = normalizedNames.size ? !normalizedNames.has(String(row.subject_name || '').trim()) : true;
    // The grade counts as well as the year level, as it does everywhere else a
    // tutor is matched: a student recorded only as "Grade 4" is still Primary.
    const scopeMatch = matchesTutorStudentScope(fallbackTutor, {
      branch_id: row.student_branch_id,
      year_level: row.student_year_level,
      grade_level: row.student_grade_level
    });
    if (invalidSubject || !scopeMatch.isMatch) {
      await connection.query(
        'UPDATE user_subject_assignments SET tutor_id = NULL, time_slot = NULL, updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?',
        [row.id]
      );
    }
  }
}

// Function: getBranches

// Role: Handles a reusable server-side operation used by this module.

async function getBranches(includeArchived = false) {
  return query(`SELECT * FROM branches ${includeArchived ? '' : 'WHERE is_archived = 0'} ORDER BY name ASC`);
}

// Function: getBranchById

// Role: Handles a reusable server-side operation used by this module.

async function getBranchById(id) {
  const rows = await query('SELECT TOP 1 * FROM branches WHERE id = ?', [id]);
  return rows[0] || null;
}

// Function: addBranch

// Role: Handles a reusable server-side operation used by this module.

async function addBranch(name) {
  const normalized = normalizeBranchName(name);
  const existing = await query('SELECT TOP 1 * FROM branches WHERE UPPER(LTRIM(RTRIM(name))) = ?', [normalized]);
  if (existing.length) {
    if (Number(existing[0].is_archived) === 1) {
      await query('UPDATE branches SET name = ?, is_archived = 0 WHERE id = ?', [normalized, existing[0].id]);
      return existing[0].id;
    }
    throw new Error('Branch already exists.');
  }
  try {
    const result = await query('INSERT INTO branches (name, is_archived) VALUES (?, 0)', [normalized]);
    return result.insertId;
  } catch (error) {
    if (String(error.message || '').toLowerCase().includes('duplicate')) {
      throw new Error('Branch already exists.');
    }
    throw error;
  }
}

// Function: archiveBranch

// Role: Handles a reusable server-side operation used by this module.

async function archiveBranch(id) {
  const branch = await getBranchById(id);
  if (!branch) throw new Error('Branch not found.');
  if (String(branch.name || '').trim().toUpperCase() === 'MAIN BRANCH') throw new Error('MAIN BRANCH cannot be archived.');
  await query('UPDATE branches SET is_archived = 1 WHERE id = ?', [id]);
}

// Function: recoverBranch

// Role: Handles a reusable server-side operation used by this module.

async function recoverBranch(id) {
  await query('UPDATE branches SET is_archived = 0 WHERE id = ?', [id]);
}

// Function: deleteBranchPermanently

// Role: Handles a reusable server-side operation used by this module.

async function deleteBranchPermanently(id) {
  const branch = await getBranchById(id);
  if (!branch) throw new Error('Branch not found.');
  if (String(branch.name || '').trim().toUpperCase() === 'MAIN BRANCH') throw new Error('MAIN BRANCH cannot be deleted.');
  await withTransaction(async (connection) => {
    await connection.query('UPDATE submissions SET branch_id = NULL WHERE branch_id = ?', [id]);
    await connection.query('UPDATE users SET branch_id = NULL WHERE branch_id = ?', [id]);
    await connection.query('UPDATE users SET assistant_scope_branch_id = NULL WHERE assistant_scope_branch_id = ?', [id]);
    await connection.query('UPDATE user_subject_assignments SET branch_id = NULL WHERE branch_id = ?', [id]);
    await connection.query('UPDATE soa_posts SET branch_id = NULL WHERE branch_id = ?', [id]);
    await connection.query('UPDATE assessments SET branch_id = NULL WHERE branch_id = ?', [id]);
    await connection.query('DELETE FROM branches WHERE id = ?', [id]);
  });
  // Rosters for the deleted branch lose their branch (ON DELETE SET NULL);
  // this closes them rather than leaving them open with nowhere to point.
  await syncAssistantRostersSafely();
}

// Function: getBranchMembers

// Role: Handles a reusable server-side operation used by this module.

async function getBranchMembers(branchId) {
  const rows = await query(
    `SELECT u.*, b.name AS branch_name
     FROM users u
     LEFT JOIN branches b ON b.id = u.branch_id
     WHERE u.branch_id = ? AND u.is_archived = 0 AND u.role IN ('student','tutor')
     ORDER BY u.role ASC, u.first_name ASC, u.last_name ASC`,
    [branchId]
  );
  return rows.map(parseRowArrays);
}

// Function: isDuplicatePersonName

// Role: Handles a reusable server-side operation used by this module.

async function isDuplicatePersonName(firstName, middleName, lastName) {
  const first = String(firstName || '').trim();
  const middle = String(middleName || '').trim();
  const last = String(lastName || '').trim();
  if (!first || !last) return false;

  // Check active users only (not archived)
  const rows = await query(
    `SELECT TOP 1 id FROM users
     WHERE LOWER(first_name) = LOWER(?)
       AND LOWER(COALESCE(middle_name, '')) = LOWER(?)
       AND LOWER(last_name) = LOWER(?)
       AND role IN ('student', 'tutor')
       AND is_archived = 0`,
    [first, middle, last]
  );
  if (rows.length) return true;

  // Check only pending submissions that are NOT archived
  const rows2 = await query(
    `SELECT TOP 1 id FROM submissions
     WHERE LOWER(first_name) = LOWER(?)
       AND LOWER(COALESCE(middle_name, '')) = LOWER(?)
       AND LOWER(last_name) = LOWER(?)
       AND submission_type IN ('student', 'tutor')
       AND status = 'pending'
       AND archived = 0`,
    [first, middle, last]
  );
  return rows2.length > 0;
}

// Function: getSubjects

// Role: Handles a reusable server-side operation used by this module.

async function getSubjects(includeArchived = false) {
  const rows = await query(
    `SELECT * FROM subjects ${includeArchived ? '' : 'WHERE is_archived = 0'} ORDER BY name ASC`
  );
  return rows;
}

// Function: getSubjectById

// Role: Handles a reusable server-side operation used by this module.

async function getSubjectById(id) {
  const rows = await query('SELECT TOP 1 * FROM subjects WHERE id = ?', [id]);
  return rows[0] || null;
}

// Function: isEmailTaken

// Role: Handles a reusable server-side operation used by this module.

async function isEmailTaken(email, ignoreUserId = null) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return false;
  const userRows = await query(
    `SELECT TOP 1 id FROM users WHERE LOWER(email) = ? ${ignoreUserId ? 'AND id <> ?' : ''}`,
    ignoreUserId ? [normalized, ignoreUserId] : [normalized]
  );
  if (userRows.length) return true;
  const submissionRows = await query('SELECT TOP 1 id FROM submissions WHERE LOWER(email) = ? AND status = ?', [normalized, 'pending']);
  return submissionRows.length > 0;
}

// Function: createSubmission

// Role: Handles a reusable server-side operation used by this module.

async function createSubmission(payload) {
  const passwordHash = await bcrypt.hash(payload.password, 10);
  const incomingSubjects = Array.isArray(payload.subjects)
    ? payload.subjects
    : (payload.subjects ? [payload.subjects] : []);
  const canonicalSubjects = await canonicalizeSubjectNames(incomingSubjects);

  const incomingSupports = Array.isArray(payload.supports)
    ? payload.supports
    : (payload.supports ? [payload.supports] : []);
  const nextSupports = uniqueNames(incomingSupports);
  const nextExtra = { ...(payload.extra || {}) };
  const tutorYearLevels = payload.submission_type === 'tutor'
    ? normalizeTutorYearLevels(nextExtra.year_levels || payload.year_level || '')
    : [];
  if (payload.submission_type === 'tutor') {
    nextExtra.year_levels = tutorYearLevels;
  }

  const result = await query(
    `INSERT INTO submissions (
      submission_type, branch_id, password_hash, first_name, middle_name, last_name,
      birth_date, age, gender, contact_number, email, facebook_account, address, year_level,
      grade_level, parent_guardian_name, parent_contact_number, parent_email, parent_facebook,
      image_path, subjects_json, support_json, extra_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.submission_type,
      payload.branch_id || null,
      passwordHash,
      payload.first_name,
      payload.middle_name || '',
      payload.last_name,
      payload.birth_date || null,
      payload.age || null,
      payload.gender || '',
      payload.contact_number || '',
      payload.email || '',
      payload.facebook_account || '',
      payload.address || '',
      payload.submission_type === 'tutor' ? tutorYearLevels.join(', ') : (payload.year_level || ''),
      payload.grade_level || '',
      payload.parent_guardian_name || '',
      payload.parent_contact_number || '',
      payload.parent_email || '',
      payload.parent_facebook || '',
      payload.image_path || null,
      JSON.stringify(canonicalSubjects),
      JSON.stringify(nextSupports),
      JSON.stringify({ ...nextExtra, visible_password: payload.password || '', email: payload.email || '' })
    ]
  );

  const submissionId = result.insertId;
  const label = payload.submission_type === 'student' ? 'Learner Registration' : 'Tutor Application';
  const message = `${payload.first_name} ${payload.last_name} submitted a ${payload.submission_type} registration.`;
  await query(
    'INSERT INTO notifications (submission_id, title, message, is_read, is_archived, moved_to_history) VALUES (?, ?, ?, 0, 0, 0)',
    [submissionId, label, message]
  );
  return submissionId;
}

// Function: getSubmissionById

// Role: Handles a reusable server-side operation used by this module.

async function getSubmissionById(id) {
  const rows = await query(
    `SELECT TOP 1 s.*, b.name AS branch_name
     FROM submissions s
     LEFT JOIN branches b ON b.id = s.branch_id
     WHERE s.id = ?`,
    [id]
  );
  return parseRowArrays(rows[0] || null);
}

// Function: getNotificationById

// Role: Handles a reusable server-side operation used by this module.

async function getNotificationById(id, scopeBranchId = null) {
  const rows = await query(
    `SELECT
        n.id AS notification_id,
        n.submission_id,
        n.title AS notification_title,
        n.message AS notification_message,
        n.is_read,
        n.is_archived,
        n.moved_to_history,
        n.created_at AS notification_created_at,
        s.id AS submission_id_value,
        s.branch_id,
        s.submission_type,
        s.status AS submission_status
     FROM notifications n
     INNER JOIN submissions s ON s.id = n.submission_id
     WHERE n.id = ? ${scopeBranchId ? 'AND s.branch_id = ?' : ''}`,
    scopeBranchId ? [id, scopeBranchId] : [id]
  );
  if (!rows[0]) return null;
  return {
    ...rows[0],
    id: rows[0].notification_id,
    submission_id: rows[0].submission_id || rows[0].submission_id_value,
    status: rows[0].submission_status
  };
}

// Function: getNotifications

// Role: Handles a reusable server-side operation used by this module.

async function getNotifications(options = {}) {
  const archived = options.archived ? 1 : 0;
  const history = options.history ? 1 : 0;
  const scope = buildScopeClause(options.scopeBranchId, 's.branch_id');
  const rows = await query(
    `SELECT
        n.id AS notification_id,
        n.submission_id,
        n.title AS notification_title,
        n.message AS notification_message,
        n.is_read,
        n.is_archived,
        n.moved_to_history,
        n.created_at AS notification_created_at,
        s.id AS submission_id_value,
        s.submission_type,
        s.branch_id,
        s.password_hash,
        s.first_name,
        s.middle_name,
        s.last_name,
        s.birth_date,
        s.age,
        s.gender,
        s.contact_number,
        s.email,
        s.facebook_account,
        s.address,
        s.year_level,
        s.grade_level,
        s.parent_guardian_name,
        s.parent_contact_number,
        s.parent_email,
        s.parent_facebook,
        s.image_path,
        s.subjects_json,
        s.support_json,
        s.extra_json,
        s.status AS submission_status,
        s.accepted_at,
        s.read_at,
        s.archived,
        s.archived_at,
        s.created_at AS submission_created_at,
        b.name AS branch_name
     FROM notifications n
     INNER JOIN submissions s ON s.id = n.submission_id
     LEFT JOIN branches b ON b.id = s.branch_id
     WHERE n.is_archived = ? AND n.moved_to_history = ? ${scope.sql}
     ORDER BY n.created_at DESC`,
    [archived, history, ...scope.params]
  );
  return rows.map((row) => parseRowArrays({
    ...row,
    id: row.notification_id,
    submission_id: row.submission_id || row.submission_id_value,
    status: row.submission_status,
    created_at: row.submission_created_at || row.notification_created_at
  }));
}

// Function: getUnreadNotificationCount

// Role: Handles a reusable server-side operation used by this module.

async function getUnreadNotificationCount(scopeBranchId = null) {
  const scope = buildScopeClause(scopeBranchId, 's.branch_id');
  const rows = await query(
    `SELECT COUNT(*) AS count
     FROM notifications n
     INNER JOIN submissions s ON s.id = n.submission_id
     WHERE n.is_archived = 0 AND n.moved_to_history = 0 ${scope.sql}`,
    scope.params
  );
  return Number(rows[0]?.count || 0);
}

// Function: markNotificationRead

// Role: Handles a reusable server-side operation used by this module.

async function markNotificationRead(id, scopeBranchId = null) {
  const notification = await getNotificationById(id, scopeBranchId);
  if (!notification) return false;
  await query('UPDATE notifications SET is_read = 1 WHERE id = ?', [id]);
  await query('UPDATE submissions SET read_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?', [notification.submission_id]);
  return true;
}

/**
 * Turn a registration down. The inbox lists submissions that are neither
 * archived nor in history, so "Cancel" used to mark the row read and leave it
 * sitting in the inbox indefinitely. Declining closes the submission and files
 * the notification under history, where the decision can still be seen.
 */
async function declineNotification(id, scopeBranchId = null) {
  const notification = await getNotificationById(id, scopeBranchId);
  if (!notification) return false;
  if (notification.status === 'accepted') throw new Error('This registration was already accepted.');
  await query(
    `UPDATE submissions SET status = 'cancelled', read_at = DATEADD(hour, 8, GETUTCDATE()),
            updated_at = DATEADD(hour, 8, GETUTCDATE())
      WHERE id = ?`,
    [notification.submission_id]
  );
  await query('UPDATE notifications SET is_read = 1, moved_to_history = 1, is_archived = 0 WHERE id = ?', [id]);
  return true;
}

// Function: archiveNotification

// Role: Handles a reusable server-side operation used by this module.

async function archiveNotification(id, scopeBranchId = null) {
  const notification = await getNotificationById(id, scopeBranchId);
  if (!notification) return false;
  await query('UPDATE notifications SET is_archived = 1, is_read = 1 WHERE id = ?', [id]);
  await query('UPDATE submissions SET archived = 1, archived_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?', [notification.submission_id]);
  return true;
}

// Function: recoverNotification

// Role: Handles a reusable server-side operation used by this module.

async function recoverNotification(id, scopeBranchId = null) {
  const notification = await getNotificationById(id, scopeBranchId);
  if (!notification) return false;
  await query('UPDATE notifications SET is_archived = 0 WHERE id = ?', [id]);
  await query('UPDATE submissions SET archived = 0, archived_at = NULL WHERE id = ?', [notification.submission_id]);
  return true;
}

// Function: acceptNotification

// Role: Handles a reusable server-side operation used by this module.

async function acceptNotification(id, actor) {
  const acceptedUserId = await withTransaction(async (connection) => {
    const [notificationRows] = await connection.query(
      `SELECT TOP 1
          n.id AS notification_id,
          n.submission_id,
          s.id AS submission_id_value,
          s.branch_id,
          s.submission_type,
            s.password_hash,
          s.first_name,
          s.middle_name,
          s.last_name,
          s.birth_date,
          s.age,
          s.gender,
          s.contact_number,
          s.email,
          s.facebook_account,
          s.address,
          s.year_level,
          s.grade_level,
          s.parent_guardian_name,
          s.parent_contact_number,
          s.parent_email,
          s.parent_facebook,
          s.image_path,
          s.subjects_json,
          s.support_json,
          s.extra_json,
          s.status AS submission_status
       FROM notifications n
       INNER JOIN submissions s ON s.id = n.submission_id
       WHERE n.id = ?`,
      [id]
    );
    const row = notificationRows[0] ? {
      ...notificationRows[0],
      id: notificationRows[0].submission_id || notificationRows[0].submission_id_value,
      submission_id: notificationRows[0].submission_id || notificationRows[0].submission_id_value,
      status: notificationRows[0].submission_status
    } : null;
    if (!row) throw new Error('Notification not found.');
    if (actor.role === 'admin_assistant' && Number(actor.assistant_scope_branch_id) !== Number(row.branch_id)) {
      throw new Error('You cannot accept submissions outside your branch.');
    }
    if (row.status === 'accepted') return null;
    if (row.status === 'cancelled') throw new Error('This registration was declined. Ask the applicant to register again.');

    const duplicateUserRows = await query('SELECT TOP 1 id FROM users WHERE LOWER(email) = ?', [String(row.email || '').trim().toLowerCase()]);
    if (duplicateUserRows.length) {
      throw new Error('Email already exists. Edit the registration email first before accepting it.');
    }

    const tempUserCode = `TEMP-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

    const [insertResult] = await connection.query(
      `INSERT INTO users (
        user_id, role, branch_id, assistant_scope_branch_id, password_hash,
        first_name, middle_name, last_name, birth_date, age, gender, contact_number,
        email, facebook_account, address, year_level, grade_level, parent_guardian_name,
        parent_contact_number, parent_email, parent_facebook, image_path, subjects_json,
        support_json, extra_json, accepted_submission_id, accepted_at, status, is_archived
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATEADD(hour, 8, GETUTCDATE()), 'approved', 0)`,
      [
        tempUserCode,
        row.submission_type,
        row.branch_id ? Number(row.branch_id) : null,
        row.password_hash,
        row.first_name,
        row.middle_name || '',
        row.last_name,
        row.birth_date || null,
        row.age ? Number(row.age) : null,
        row.gender || '',
        row.contact_number || '',
        row.email || '',
        row.facebook_account || '',
        row.address || '',
        row.submission_type === 'tutor' ? normalizeTutorYearLevels(safeJsonObject(row.extra_json).year_levels || row.year_level || '').join(', ') : (row.year_level || ''),
        row.grade_level || '',
        row.parent_guardian_name || '',
        row.parent_contact_number || '',
        row.parent_email || '',
        row.parent_facebook || '',
        row.image_path || null,
        JSON.stringify(await canonicalizeSubjectNames(safeJsonArray(row.subjects_json))),
        row.support_json || '[]',
        row.extra_json || '{}',
        Number(row.id)
      ]
    );

    const newUserId = insertResult.insertId;
    const userCode = generateUserCode(row.submission_type, newUserId);
    await connection.query('UPDATE users SET user_id = ? WHERE id = ?', [userCode, Number(newUserId)]);

    if (row.submission_type === 'tutor') {
      const yearLevels = normalizeTutorYearLevels(safeJsonObject(row.extra_json).year_levels || row.year_level || '');
      await syncTutorYearLevels(Number(newUserId), yearLevels, connection);
    }

    if (row.submission_type === 'student') {
      // Enrols the student AND opens their billing account: the sync ends in
      // recalculateStudentBilling, which creates the account when there is none
      // and prices it from the subjects just enrolled (₱1,800 each).
      //
      // This used to be followed by a second INSERT INTO billing for the same
      // student. billing.student_id is unique, so accepting ANY learner
      // registration failed with "Violation of UNIQUE KEY constraint
      // 'UQ__billing__…' … The duplicate key value is (<new student id>)" and
      // the whole acceptance rolled back.
      await syncStudentSubjectAssignments(
        connection,
        Number(newUserId),
        safeJsonArray(row.subjects_json),
        row.branch_id ? Number(row.branch_id) : null,
        Number(actor.id)
      );
      await recalculateStudentBilling(connection, Number(newUserId), Number(actor.id));
    }

    await connection.query('UPDATE submissions SET status = ?, accepted_at = DATEADD(hour, 8, GETUTCDATE()), read_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?', ['accepted', row.id]);
    await connection.query('UPDATE notifications SET is_read = 1, moved_to_history = 1, is_archived = 0 WHERE id = ?', [id]);

    return newUserId;
  });

  // The new tutor or student is now under their branch's assistant.
  if (acceptedUserId) await syncAssistantRostersSafely();
  return acceptedUserId;
}

// Function: getDashboardCounts

// Role: Handles a reusable server-side operation used by this module.

async function getDashboardCounts(scopeBranchId = null) {
  const scope = buildScopeClause(scopeBranchId, 'branch_id');
  const studentRows = await query(
    `SELECT COUNT(*) AS count FROM users WHERE role = 'student' AND is_archived = 0 ${scope.sql}`,
    scope.params
  );
  const tutorRows = await query(
    `SELECT COUNT(*) AS count FROM users WHERE role = 'tutor' AND is_archived = 0 ${scope.sql}`,
    scope.params
  );
  return {
    students: Number(studentRows[0]?.count || 0),
    tutors: Number(tutorRows[0]?.count || 0)
  };
}

// Function: getRecentSubmissions

// Role: Handles a reusable server-side operation used by this module.

async function getRecentSubmissions(scopeBranchId = null, limit = 8) {
  const scope = buildScopeClause(scopeBranchId, 's.branch_id');
  const rows = await query(
    `SELECT TOP ${Number(limit)} s.*, b.name AS branch_name, n.id AS notification_id, n.is_read, n.is_archived, n.moved_to_history
     FROM submissions s
     LEFT JOIN branches b ON b.id = s.branch_id
     LEFT JOIN notifications n ON n.submission_id = s.id
     WHERE s.created_at >= DATEADD(DAY, -3, DATEADD(hour, 8, GETUTCDATE())) ${scope.sql}
     ORDER BY s.created_at DESC`,
    [...scope.params]
  );
  return rows.map(parseRowArrays);
}

// Function: getUsers

// Role: Handles a reusable server-side operation used by this module.

async function getUsers(options = {}) {
  const archived = options.archived ? 1 : 0;
  const roleSql = options.role && options.role !== 'all' ? 'AND u.role = ?' : "AND u.role IN ('student','tutor')";
  const scope = buildScopeClause(options.scopeBranchId, 'u.branch_id');
  const search = String(options.search || '').trim().toLowerCase();
  const searchSql = search ? "AND (LOWER(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.middle_name, ''), ' ', COALESCE(u.last_name, ''))) LIKE ? OR LOWER(u.user_id) LIKE ?)" : '';
  const params = [archived, ...scope.params];
  if (options.role && options.role !== 'all') params.push(options.role);
  if (search) params.push(`%${search}%`, `%${search}%`);
  const rows = await query(
    `SELECT u.*, b.name AS branch_name
     FROM users u
     LEFT JOIN branches b ON b.id = u.branch_id
     WHERE u.role <> 'admin' AND u.is_archived = ? ${scope.sql} ${roleSql} ${searchSql}
     ORDER BY u.created_at DESC`,
    params
  );
  return rows.map(parseRowArrays);
}

/**
 * The same list as getUsers, one page at a time.
 *
 * Rendering every user on one page was fine with twenty of them and is not with
 * two thousand: the browser has to lay out every row before it can paint, and the
 * query has to ship them all first. OFFSET/FETCH keeps both bounded.
 *
 * @param {object} options { scopeBranchId, role, archived, search, yearLevel,
 *                           status, page, pageSize }
 * @returns {Promise<{rows:Array, total:number, page:number, pageSize:number, pageCount:number}>}
 */
async function getUsersPaged(options = {}) {
  const archived = options.archived ? 1 : 0;
  const scope = buildScopeClause(options.scopeBranchId, 'u.branch_id');
  const search = String(options.search || '').trim().toLowerCase();

  const filters = [];
  const params = [archived, ...scope.params];

  if (options.role && options.role !== 'all') {
    filters.push('u.role = ?');
    params.push(options.role);
  } else {
    filters.push("u.role IN ('student','tutor')");
  }
  if (options.status && options.status !== 'all') {
    filters.push('u.status = ?');
    params.push(options.status);
  }
  if (options.yearLevel && options.yearLevel !== 'all') {
    filters.push('u.year_level = ?');
    params.push(options.yearLevel);
  }
  if (options.needsTutor) {
    filters.push(NEEDS_TUTOR_SQL);
  }
  if (search) {
    filters.push(`(LOWER(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.middle_name, ''), ' ', COALESCE(u.last_name, ''))) LIKE ?
                   OR LOWER(u.user_id) LIKE ? OR LOWER(COALESCE(u.email, '')) LIKE ?
                   OR LOWER(COALESCE(u.contact_number, '')) LIKE ?)`);
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }

  // Built once and used by both queries: a count that filtered differently from
  // the page it describes is the classic way a pager ends up pointing at pages
  // that do not exist.
  const whereSql = `WHERE u.role <> 'admin' AND u.is_archived = ? ${scope.sql} AND ${filters.join(' AND ')}`;

  const countRows = await query(`SELECT COUNT(*) AS total FROM users u ${whereSql}`, params);
  const total = Number(countRows[0]?.total || 0);

  // `all` returns every match on one page: User Management shows its list as a
  // ten-row scrolling table searched in the browser, so it needs every row.
  const pageSize = options.all
    ? Math.max(1, total)
    : Math.min(200, Math.max(5, Number(options.pageSize) || 25));
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = options.all ? 1 : Math.min(pageCount, Math.max(1, Number(options.page) || 1));

  const rows = await query(
    `SELECT u.*, b.name AS branch_name
     FROM users u
     LEFT JOIN branches b ON b.id = u.branch_id
     ${whereSql}
     ORDER BY u.created_at DESC, u.id DESC
     -- CAST because config/db.js binds every JS number as DECIMAL(18,4), and
     -- OFFSET/FETCH will only take an integer expression.
     OFFSET CAST(? AS INT) ROWS FETCH NEXT CAST(? AS INT) ROWS ONLY`,
    [...params, (page - 1) * pageSize, pageSize]
  );

  const parsed = rows.map(parseRowArrays);
  if (options.needsTutor && parsed.length) {
    // The subjects each of them is still waiting in, so the office sees it
    // without opening every profile. Only the ones with no tutor: a student
    // whose tutor teaches Math but not English is listed for English.
    const ids = parsed.map((row) => Number(row.id));
    const subjectRows = await query(
      `SELECT usa.student_id, s.name AS subject_name
         FROM user_subject_assignments usa
         INNER JOIN subjects s ON s.id = usa.subject_id
        WHERE usa.is_archived = 0 AND usa.tutor_id IS NULL
          AND usa.student_id IN (${ids.map(() => '?').join(', ')})
        ORDER BY s.name`,
      ids
    );
    for (const row of parsed) {
      row.enrolled_subjects = subjectRows
        .filter((item) => Number(item.student_id) === Number(row.id))
        .map((item) => item.subject_name);
    }
  }

  return { rows: parsed, total, page, pageSize, pageCount };
}

/**
 * The students waiting for the office to give them a tutor: at least one
 * subject they are enrolled in has no tutor.
 *
 * A tutor teaches only the subjects they teach (see setStudentTutorAndSchedule),
 * so a student can have a tutor for Math and still be waiting for one in
 * English. This used to require NO tutor on ANY subject, which hid exactly that
 * student.
 */
const NEEDS_TUTOR_SQL = `u.role = 'student'
  AND EXISTS (SELECT 1 FROM user_subject_assignments ua
               WHERE ua.student_id = u.id AND ua.is_archived = 0 AND ua.tutor_id IS NULL)`;

/** How many students are in the "Needs a tutor" folder, for its badge. */
async function countStudentsNeedingTutor(scopeBranchId = null) {
  const scope = buildScopeClause(scopeBranchId, 'u.branch_id');
  const rows = await query(
    `SELECT COUNT(*) AS total FROM users u
      WHERE u.is_archived = 0 ${scope.sql} AND ${NEEDS_TUTOR_SQL}`,
    [...scope.params]
  );
  return Number(rows[0]?.total || 0);
}

// Function: getAssistantAccounts

// Role: Handles a reusable server-side operation used by this module.

async function getAssistantAccounts(scopeBranchId = null, includeArchived = false) {
  const scope = buildScopeClause(scopeBranchId, 'u.assistant_scope_branch_id');
  const rows = await query(
    `SELECT u.*, b.name AS branch_name
     FROM users u
     LEFT JOIN branches b ON b.id = u.assistant_scope_branch_id
     WHERE u.role = 'admin_assistant' AND u.is_archived = ? ${scope.sql}
     ORDER BY u.created_at DESC`,
    [includeArchived ? 1 : 0, ...scope.params]
  );
  return rows.map(parseRowArrays);
}


// Function: getUserById


// Role: Handles a reusable server-side operation used by this module.


async function getUserById(id) {
  const rows = await query(
    `SELECT TOP 1 u.*, b.name AS branch_name
     FROM users u
     LEFT JOIN branches b ON b.id = u.branch_id
     WHERE u.id = ?`,
    [id]
  );
  return parseRowArrays(rows[0] || null);
}

// Function: changeUserPassword

// Role: Handles a reusable server-side operation used by this module.

async function changeUserPassword(id, currentPassword, newPassword) {
  const user = await getUserById(id);
  if (!user) throw new Error('User not found.');

  const currentRaw = String(currentPassword || '');
  const nextRaw = String(newPassword || '');

  if (!currentRaw || !nextRaw) throw new Error('Current password and new password are required.');
  if (nextRaw.length < 8) throw new Error('New password must be at least 8 characters long.');

  const matches = await bcrypt.compare(currentRaw, user.password_hash);
  if (!matches) throw new Error('Current password is incorrect.');

  const passwordHash = await bcrypt.hash(nextRaw, 10);
  const nextExtra = { ...(user.extra || {}), visible_password: nextRaw };

  await query(
    'UPDATE users SET password_hash = ?, extra_json = ?, updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?',
    [passwordHash, JSON.stringify(nextExtra), id]
  );

  return true;
}

// Function: updateUser

// Role: Handles a reusable server-side operation used by this module.

async function updateUser(id, payload) {
  const user = await getUserById(id);
  if (!user) throw new Error('User not found.');
  const incomingSubjects = Array.isArray(payload.subjects) ? payload.subjects : (payload.subjects ? [payload.subjects] : []);
  const sourceSubjects = incomingSubjects.length ? incomingSubjects : (user.subjects || safeJsonArray(user.subjects_json || '[]'));
  const canonicalSubjects = await canonicalizeSubjectNames(sourceSubjects);
  const incomingSupports = Array.isArray(payload.supports) ? payload.supports : (payload.supports ? [payload.supports] : []);
  const nextSupports = incomingSupports.length ? uniqueNames(incomingSupports) : (user.supports || safeJsonArray(user.support_json || '[]'));
  const nextExtra = { ...(user.extra || {}), ...(payload.extra || {}) };
  let nextBranchId = payload.branch_id || user.branch_id || null;
  let nextYearLevel = payload.year_level || user.year_level || '';

  if (user.role === 'tutor') {
    const incomingBranchIds = [...new Set((Array.isArray(payload.branch_ids) ? payload.branch_ids : [payload.branch_ids]).map((id) => Number(id)).filter(Boolean))];
    const fallbackBranchIds = getUserBranchIds(user);
    const nextBranchIds = incomingBranchIds.length ? incomingBranchIds : (fallbackBranchIds.length ? fallbackBranchIds : normalizeBranchIds(nextBranchId));
    if (nextBranchIds.length) {
      nextBranchId = nextBranchIds[0];
      nextExtra.branch_ids = nextBranchIds;
    }

    // Stored in the tutor form ("Preschool", "Primary School", ...) whichever
    // spelling arrives, so year_level, extra.year_levels and tutor_year_levels
    // all say the same thing as the registration form did.
    const incomingYearLevels = normalizeTutorYearLevels(payload.year_levels || []);
    const fallbackYearLevels = normalizeTutorYearLevels(getUserYearLevels(user));
    const nextYearLevels = incomingYearLevels.length ? incomingYearLevels : (fallbackYearLevels.length ? fallbackYearLevels : normalizeTutorYearLevels(nextYearLevel));
    if (nextYearLevels.length) {
      nextYearLevel = nextYearLevels.join(', ');
      nextExtra.year_levels = nextYearLevels;
    }
  }

  /*
   * A field the submitting form does not carry keeps its current value.
   *
   * Every field used to be written as `payload.x || ''`, so any form that did
   * not post a column blanked it. The admin's student form has no `email` input
   * (only "Parent/student email", which is parent_email), and the tutor form has
   * none either — so pressing Save on a profile ERASED the person's login email:
   * they could no longer sign in, and online payments reached PayMongo with no
   * email, which leaves its Pay button disabled. A field that IS posted, even
   * empty, is still written as given — except the login email, which is never
   * blanked.
   */
  const given = (field, fallback = '') => (payload[field] !== undefined ? (payload[field] || fallback) : (user[field] ?? fallback));
  const postedEmail = String(payload.email ?? '').trim().toLowerCase();
  const nextEmail = postedEmail || user.email || '';
  if (postedEmail && postedEmail !== String(user.email || '').toLowerCase() && await isEmailTaken(postedEmail, id)) {
    throw new Error('That email is already used by another account.');
  }
  const nextBirthDate = payload.birth_date !== undefined ? (payload.birth_date || null) : (user.birth_date || null);

  await withTransaction(async (connection) => {
    await connection.query(
      `UPDATE users SET
        branch_id = ?, first_name = ?, middle_name = ?, last_name = ?, birth_date = ?, age = ?, gender = ?,
        contact_number = ?, email = ?, facebook_account = ?, address = ?, year_level = ?, grade_level = ?,
        parent_guardian_name = ?, parent_contact_number = ?, parent_email = ?, parent_facebook = ?,
        image_path = COALESCE(?, image_path), subjects_json = ?, support_json = ?, extra_json = ?
       WHERE id = ?`,
      [
        nextBranchId,
        titleCaseName(given('first_name')),
        titleCaseName(given('middle_name')),
        titleCaseName(given('last_name')),
        nextBirthDate,
        calculateAgeFromBirthDate(nextBirthDate) || null,
        given('gender'),
        given('contact_number'),
        nextEmail,
        given('facebook_account'),
        given('address'),
        nextYearLevel || '',
        given('grade_level'),
        given('parent_guardian_name'),
        given('parent_contact_number'),
        given('parent_email'),
        given('parent_facebook'),
        payload.image_path || null,
        JSON.stringify(canonicalSubjects),
        JSON.stringify(nextSupports),
        JSON.stringify(nextExtra),
        id
      ]
    );

    if (user.role === 'student') {
      const studentSnapshot = {
        ...user,
        branch_id: nextBranchId,
        year_level: nextYearLevel,
        grade_level: payload.grade_level || user.grade_level || '',
        subjects: canonicalSubjects
      };
      await syncStudentSubjectAssignments(connection, Number(id), canonicalSubjects, nextBranchId, payload.updated_by || null);
      await cleanupStudentTutorAssignments(connection, Number(id), studentSnapshot);
      await connection.query('UPDATE billing SET updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE student_id = ?', [id]);
    }

    if (user.role === 'tutor') {
      const tutorSnapshot = {
        ...user,
        branch_id: nextBranchId,
        year_level: nextYearLevel,
        extra: nextExtra
      };
      await syncTutorYearLevels(Number(id), normalizeTutorYearLevels(nextExtra.year_levels || nextYearLevel || ''), connection);
      await cleanupTutorAssignments(connection, Number(id), canonicalSubjects, nextBranchId, tutorSnapshot);
    }

    await connection.query('UPDATE user_subject_assignments SET branch_id = ? WHERE student_id = ?', [nextBranchId, id]);
  });

  // A branch change moves the person from one assistant's roster to another's.
  await syncAssistantRostersSafely();
}

// Function: archiveUser

// Role: Handles a reusable server-side operation used by this module.

async function archiveUser(id, scopeBranchId = null) {
  const user = await getUserById(id);
  if (!user || user.role === 'admin') return false;
  if (scopeBranchId && Number(user.branch_id) !== Number(scopeBranchId)) return false;
  await query('UPDATE users SET is_archived = 1 WHERE id = ?', [id]);
  // Archiving an assistant closes their roster, dated today.
  await syncAssistantRostersSafely();
  return true;
}

// Function: recoverUser

// Role: Handles a reusable server-side operation used by this module.

async function recoverUser(id, scopeBranchId = null) {
  const user = await getUserById(id);
  if (!user || user.role === 'admin') return false;
  if (scopeBranchId && Number(user.branch_id) !== Number(scopeBranchId)) return false;
  await query('UPDATE users SET is_archived = 0 WHERE id = ?', [id]);
  await syncAssistantRostersSafely();
  return true;
}

// Function: createAssistantAccount

// Role: Handles a reusable server-side operation used by this module.

async function createAssistantAccount(branchId, email, password, createdBy, assistantName = '') {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const taken = await isEmailTaken(normalizedEmail);
  if (taken) throw new Error('Email already exists.');
  const passwordHash = await bcrypt.hash(password, 10);
  const branch = await getBranchById(branchId);
  const branchName = String(branch?.name || '').trim();
  const newAssistantId = await withTransaction(async (connection) => {
    const [insertResult] = await connection.query(
      `INSERT INTO users (
        user_id, role, branch_id, assistant_scope_branch_id, password_hash,
        first_name, middle_name, last_name, email, contact_number, status, is_archived
      ) VALUES ('TEMP', 'admin_assistant', ?, ?, ?, ?, '', ?, ?, '', 'approved', 0)`,
      [branchId, branchId, passwordHash, titleCaseName((assistantName || branchName || 'Branch').trim()), 'Assistant', normalizedEmail || `assistant-${branchId}@mindquest.local`]
    );
    const userId = insertResult.insertId;
    await connection.query('UPDATE users SET user_id = ? WHERE id = ?', [generateUserCode('admin_assistant', userId), userId]);
    await connection.query('UPDATE users SET extra_json = ? WHERE id = ?', [JSON.stringify({ created_by: createdBy?.id || null, visible_password: password, assistant_name: titleCaseName(String(assistantName || '').trim() || (branchName ? `${branchName} Assistant` : normalizedEmail)), email: normalizedEmail }), userId]);
    return userId;
  });

  // The branch's tutors and students are this assistant's from today.
  await syncAssistantRostersSafely();
  return newAssistantId;
}

// Function: updateAssistantAccount

// Role: Handles a reusable server-side operation used by this module.

async function updateAssistantAccount(id, payload) {
  const user = await getUserById(id);
  if (!user || user.role !== 'admin_assistant') throw new Error('Assistant account not found.');
  const nextEmail = String(payload.email || user.email || '').trim().toLowerCase();
  if (await isEmailTaken(nextEmail, id)) throw new Error('Email already exists.');
  let passwordHash = user.password_hash;
  let visiblePassword = parseRowArrays(user).extra?.visible_password || '';
  if (String(payload.password || '').trim()) {
    visiblePassword = String(payload.password).trim();
    passwordHash = await bcrypt.hash(visiblePassword, 10);
  }
  const branch = await getBranchById(payload.branch_id || user.assistant_scope_branch_id || user.branch_id);
  const branchName = String(branch?.name || '').trim();
  // The person's name, as createAssistantAccount stores it. This used to write
  // the BRANCH name into first_name, so editing an assistant's email renamed
  // them "Main Branch" everywhere their first name is shown.
  const assistantName = titleCaseName(
    String(payload.assistant_name || '').trim()
    || user.extra?.assistant_name
    || user.first_name
    || (branchName ? `${branchName} Assistant` : nextEmail)
  );
  await query(`UPDATE users SET assistant_scope_branch_id = ?, branch_id = ?, email = ?, password_hash = ?, first_name = ?, last_name = ?, extra_json = ? WHERE id = ?`, [
    payload.branch_id || user.assistant_scope_branch_id,
    payload.branch_id || user.branch_id,
    nextEmail,
    passwordHash,
    assistantName,
    'Assistant',
    JSON.stringify({ ...(parseRowArrays(user).extra || {}), visible_password: visiblePassword, assistant_name: assistantName, email: nextEmail }),
    id
  ]);

  // Moving an assistant to another branch closes one roster and opens another.
  await syncAssistantRostersSafely();
}

// Function: getAvailableAssistantBranches

// Role: Handles a reusable server-side operation used by this module.

async function getAvailableAssistantBranches() {
  return query(`SELECT b.* FROM branches b WHERE b.is_archived = 0 AND b.id NOT IN (SELECT COALESCE(assistant_scope_branch_id,0) FROM users WHERE role='admin_assistant' AND is_archived=0) ORDER BY b.name ASC`);
}

// Function: deleteUserPermanently

// Role: Handles a reusable server-side operation used by this module.

async function deleteUserPermanently(id, scopeBranchId = null) {
  const user = await getUserById(id);
  if (!user || user.role === 'admin') return false;
  if (scopeBranchId) {
    const matchBranch = Number(user.branch_id || user.assistant_scope_branch_id || 0) === Number(scopeBranchId);
    if (!matchBranch) return false;
  }
  await withTransaction(async (connection) => {
    await connection.query('UPDATE user_subject_assignments SET tutor_id = NULL WHERE tutor_id = ?', [id]);
    await connection.query('UPDATE user_subject_assignments SET accepted_by = NULL WHERE accepted_by = ?', [id]);
    await connection.query('DELETE FROM user_subject_assignments WHERE student_id = ?', [id]);

    await connection.query('DELETE FROM attendance WHERE student_id = ? OR tutor_id = ?', [id, id]);

    await connection.query('UPDATE billing SET posted_by = NULL WHERE posted_by = ?', [id]);
    await connection.query('UPDATE payment_history SET recorded_by = NULL WHERE recorded_by = ?', [id]);
    await connection.query('UPDATE soa_posts SET created_by = NULL WHERE created_by = ?', [id]);
    await connection.query('UPDATE assessments SET created_by = NULL WHERE created_by = ?', [id]);

    await connection.query('DELETE FROM subject_resources WHERE tutor_id = ?', [id]);
    await connection.query('DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?', [id, id]);

    await connection.query('DELETE FROM assessment_results WHERE student_id = ?', [id]);
    await connection.query('DELETE FROM assessments WHERE assigned_student_id = ?', [id]);
    await connection.query('DELETE FROM billing WHERE student_id = ?', [id]);

    // The member side cascades; the assistant side cannot (one cascade path per
    // table), so an assistant's roster is cleared here. Guarded for a database
    // the roster migration has not reached yet.
    await connection.query(
      `IF OBJECT_ID('dbo.assistant_rosters', 'U') IS NOT NULL
         DELETE FROM assistant_rosters WHERE assistant_id = ? OR member_id = ?`,
      [id, id]
    );

    await connection.query('DELETE FROM users WHERE id = ?', [id]);
  });

  return true;
}

// Function: getStudentAssignments

// Role: Handles a reusable server-side operation used by this module.

async function getStudentAssignments(studentId) {
  const rows = await query(
    `SELECT usa.*, s.name AS subject_name, t.first_name AS tutor_first_name, t.middle_name AS tutor_middle_name,
            t.last_name AS tutor_last_name, t.id AS tutor_internal_id, t.image_path AS tutor_image_path
     FROM user_subject_assignments usa
     INNER JOIN subjects s ON s.id = usa.subject_id
     LEFT JOIN users t ON t.id = usa.tutor_id
     WHERE usa.student_id = ? AND usa.is_archived = 0
     ORDER BY usa.created_at DESC`,
    [studentId]
  );
  return rows.map((row) => ({
    ...row,
    tutor_name: row.tutor_internal_id ? fullName({
      first_name: row.tutor_first_name,
      middle_name: row.tutor_middle_name,
      last_name: row.tutor_last_name
    }) : 'Not yet assigned'
  }));
}

// Function: getStudentSubjectsOverview

// Role: Handles a reusable server-side operation used by this module.

async function getStudentSubjectsOverview(studentId) {
  const [allSubjects, assignments, pendingRows] = await Promise.all([
    getSubjects(false),
    getStudentAssignments(studentId),
    query(
      `SELECT subject_id
       FROM subject_enrollment_requests
       WHERE student_id = ? AND status = 'pending'`,
      [studentId]
    )
  ]);

  const enrolledIds = new Set(assignments.map((item) => Number(item.subject_id)));
  const pendingIds = new Set(pendingRows.map((item) => Number(item.subject_id)));

  return {
    allSubjects: allSubjects.map((subject) => ({
      ...subject,
      is_enrolled: enrolledIds.has(Number(subject.id)),
      has_pending_request: pendingIds.has(Number(subject.id))
    })),
    enrolledSubjects: assignments
  };
}

// Function: createSubjectEnrollmentRequest

// Role: Handles a reusable server-side operation used by this module.

async function createSubjectEnrollmentRequest(studentId, subjectId) {
  return withTransaction(async (connection) => {
    const student = await getUserById(studentId);
    if (!student || student.role !== 'student') throw new Error('Student account not found.');

    const subject = await getSubjectById(subjectId);
    if (!subject || Number(subject.is_archived) === 1) throw new Error('Subject not found.');

    const existingAssignmentRows = await connection.query(
      `SELECT TOP 1 id
       FROM user_subject_assignments
       WHERE student_id = ? AND subject_id = ? AND is_archived = 0`,
      [studentId, subjectId]
    );
    if (existingAssignmentRows[0].length) throw new Error('You are already enrolled in this subject.');

    const existingPendingRows = await connection.query(
      `SELECT TOP 1 id
       FROM subject_enrollment_requests
       WHERE student_id = ? AND subject_id = ? AND status = 'pending'`,
      [studentId, subjectId]
    );
    if (existingPendingRows[0].length) throw new Error('Enrollment request already sent.');

    await connection.query(
      `INSERT INTO subject_enrollment_requests (
        student_id, subject_id, branch_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', DATEADD(hour, 8, GETUTCDATE()), DATEADD(hour, 8, GETUTCDATE()))`,
      [studentId, subjectId, student.branch_id || null]
    );
    return true;
  });
}

// Function: getSubjectEnrollmentRequests

// Role: Handles a reusable server-side operation used by this module.

async function getSubjectEnrollmentRequests(scopeBranchId = null) {
  const scope = buildScopeClause(scopeBranchId, 'ser.branch_id');
  const rows = await query(
    `SELECT
        ser.id,
        ser.student_id,
        ser.subject_id,
        ser.branch_id,
        ser.status,
        ser.created_at,
        s.name AS subject_name,
        br.name AS branch_name,
        u.user_id,
        u.first_name,
        u.middle_name,
        u.last_name,
        u.year_level,
        u.grade_level,
        u.email,
        u.contact_number
     FROM subject_enrollment_requests ser
     INNER JOIN users u ON u.id = ser.student_id
     INNER JOIN subjects s ON s.id = ser.subject_id
     LEFT JOIN branches br ON br.id = ser.branch_id
     WHERE ser.status = 'pending' ${scope.sql}
     ORDER BY ser.created_at DESC`,
    scope.params
  );
  return rows.map((row) => ({
    ...row,
    notification_type: 'subject_enrollment_request',
    created_at: row.created_at
  }));
}

// Function: getAdminInboxNotifications

// Role: Handles a reusable server-side operation used by this module.

async function getAdminInboxNotifications(scopeBranchId = null) {
  const [registrationNotifications, subjectRequests] = await Promise.all([
    getNotifications({ scopeBranchId, archived: false, history: false }),
    getSubjectEnrollmentRequests(scopeBranchId)
  ]);

  return [...registrationNotifications, ...subjectRequests].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

// Function: cancelSubjectEnrollmentRequest

// Role: Handles a reusable server-side operation used by this module.

async function cancelSubjectEnrollmentRequest(id, actor) {
  return withTransaction(async (connection) => {
    const [requestRows] = await connection.query(
      `SELECT TOP 1 ser.*, u.branch_id AS student_branch_id
       FROM subject_enrollment_requests ser
       INNER JOIN users u ON u.id = ser.student_id
       WHERE ser.id = ?`,
      [id]
    );
    const row = requestRows[0];
    if (!row) throw new Error('Enrollment request not found.');
    if (row.status !== 'pending') throw new Error('This enrollment request is already processed.');
    if (actor.role === 'admin_assistant' && Number(actor.assistant_scope_branch_id) !== Number(row.branch_id || row.student_branch_id || 0)) {
      throw new Error('You cannot cancel enrollment requests outside your branch.');
    }

    await connection.query(
      `UPDATE subject_enrollment_requests
       SET status = 'cancelled', updated_at = DATEADD(hour, 8, GETUTCDATE())
       WHERE id = ?`,
      [id]
    );
    return true;
  });
}

// Function: acceptSubjectEnrollmentRequest

// Role: Handles a reusable server-side operation used by this module.

async function acceptSubjectEnrollmentRequest(id, actor) {
  return withTransaction(async (connection) => {
    const [requestRows] = await connection.query(
      `SELECT TOP 1 ser.*, u.role AS student_role, u.branch_id AS student_branch_id, s.name AS subject_name
       FROM subject_enrollment_requests ser
       INNER JOIN users u ON u.id = ser.student_id
       INNER JOIN subjects s ON s.id = ser.subject_id
       WHERE ser.id = ?`,
      [id]
    );
    const row = requestRows[0];
    if (!row) throw new Error('Enrollment request not found.');
    if (row.status !== 'pending') throw new Error('This enrollment request is already processed.');
    if (actor.role === 'admin_assistant' && Number(actor.assistant_scope_branch_id) !== Number(row.branch_id || row.student_branch_id || 0)) {
      throw new Error('You cannot accept enrollment requests outside your branch.');
    }

    const [existingAssignmentRows] = await connection.query(
      `SELECT TOP 1 id
       FROM user_subject_assignments
       WHERE student_id = ? AND subject_id = ? AND is_archived = 0`,
      [row.student_id, row.subject_id]
    );

    if (!existingAssignmentRows.length) {
      // The new subject is taken by one of the student's current tutors — but
      // only one who TEACHES it. It used to inherit whichever tutor the student
      // had, so a Math tutor ended up "teaching" English. With no such tutor
      // the subject waits for one (the student picks, or the office assigns),
      // and the student shows in User Management's "Needs a tutor".
      const [existingTutorRows] = await connection.query(
        `SELECT tutor_id, time_slot, MAX(assigned_at) AS assigned_at
         FROM user_subject_assignments
         WHERE student_id = ? AND is_archived = 0 AND tutor_id IS NOT NULL
         GROUP BY tutor_id, time_slot
         ORDER BY MAX(assigned_at) DESC`,
        [row.student_id]
      );
      let inheritedTutor = null;
      for (const candidate of existingTutorRows) {
        const tutorRecord = await getUserById(candidate.tutor_id);
        if (tutorRecord && tutorTeachesSubject(tutorRecord, row.subject_name)) {
          inheritedTutor = candidate;
          break;
        }
      }
      // A subject added mid-cycle starts its OWN month today (Phase 4.2), so
      // Filipino taken out on 6 June runs to 6 July regardless of English having
      // started on the 3rd. The dates are deliberately NOT copied from the
      // sibling assignment the tutor is inherited from.
      await connection.query(
        `INSERT INTO user_subject_assignments (
          student_id, tutor_id, subject_id, branch_id, enrolled_at, assigned_at, accepted_by, is_archived, time_slot,
          start_date, end_date
        ) VALUES (?, ?, ?, ?, DATEADD(hour, 8, GETUTCDATE()), ${inheritedTutor ? 'DATEADD(hour, 8, GETUTCDATE())' : 'NULL'}, ?, 0, ?, ?, ?)`,
        [
          row.student_id, inheritedTutor?.tutor_id || null, row.subject_id,
          row.branch_id || row.student_branch_id || null, actor.id,
          inheritedTutor?.time_slot || null,
          todayDate(), plusOneMonth(new Date())
        ]
      );
    }

    const student = await getUserById(row.student_id);
    const currentSubjects = new Set((student.subjects || safeJsonArray(student.subjects_json || '[]')).map((item) => String(item || '').trim()).filter(Boolean));
    currentSubjects.add(row.subject_name);
    await connection.query(
      'UPDATE users SET subjects_json = ?, updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?',
      [JSON.stringify([...currentSubjects]), row.student_id]
    );

    // One more subject means ₱1,800 more owed (Phase 4.1), added by re-deriving
    // the total rather than by an increment that could be applied twice.
    await recalculateStudentBilling(connection, row.student_id, actor.id);

    await connection.query(
      `UPDATE subject_enrollment_requests
       SET status = 'accepted', decided_by = ?, decided_at = DATEADD(hour, 8, GETUTCDATE()), updated_at = DATEADD(hour, 8, GETUTCDATE())
       WHERE id = ?`,
      [actor.id, id]
    );
    return true;
  });
}

// Function: getTutorAssignments

// Role: Handles a reusable server-side operation used by this module.

async function getTutorAssignments(tutorId) {
  const rows = await query(
    `SELECT usa.*, s.name AS subject_name, st.first_name AS student_first_name, st.middle_name AS student_middle_name,
            st.last_name AS student_last_name, st.year_level, st.grade_level,
            st.image_path AS student_image_path, st.user_id AS student_code
     FROM user_subject_assignments usa
     INNER JOIN subjects s ON s.id = usa.subject_id
     INNER JOIN users st ON st.id = usa.student_id
     WHERE usa.tutor_id = ? AND usa.is_archived = 0
     ORDER BY usa.created_at DESC`,
    [tutorId]
  );
  return rows.map((row) => ({
    ...row,
    student_name: fullName({ first_name: row.student_first_name, middle_name: row.student_middle_name, last_name: row.student_last_name })
  }));
}

// Function: getAttendanceSummary

// Role: Handles a reusable server-side operation used by this module.

async function getAttendanceSummary(studentId) {
  const rows = await query(
    `SELECT status, COUNT(*) AS count FROM attendance WHERE student_id = ? GROUP BY status`,
    [studentId]
  );
  const summary = { present: 0, absent: 0 };
  for (const row of rows) {
    summary[row.status] = Number(row.count || 0);
  }
  return summary;
}

// Function: getAttendanceBySubject

// Role: Handles a reusable server-side operation used by this module.

async function getAttendanceBySubject(studentId, subjectId) {
  return query(
    `SELECT a.*, t.first_name AS tutor_first_name, t.middle_name AS tutor_middle_name, t.last_name AS tutor_last_name
     FROM attendance a
     LEFT JOIN users t ON t.id = a.tutor_id
     WHERE a.student_id = ? AND a.subject_id = ?
     ORDER BY a.attendance_date DESC, a.id DESC`,
    [studentId, subjectId]
  );
}

// Function: calculateAgeFromBirthDate

// Role: Provides helper logic for this file.

function calculateAgeFromBirthDate(birthDate) {
  if (!birthDate) return null;
  const birth = dayjs(birthDate);
  if (!birth.isValid()) return null;
  const now = dayjs();
  let age = now.year() - birth.year();
  if (now.month() < birth.month() || (now.month() === birth.month() && now.date() < birth.date())) {
    age -= 1;
  }
  return age >= 0 ? age : null;
}

// Function: getStudentDashboardData

// Role: Handles a reusable server-side operation used by this module.

async function getStudentDashboardData(studentId) {
  const user = await getUserById(studentId);
  const assignments = await getStudentAssignments(studentId);
  const attendance = await getAttendanceSummary(studentId);
  const latestSoaRows = await query('SELECT TOP 1 * FROM soa_posts WHERE student_id = ? ORDER BY created_at DESC', [studentId]);
  const tutors = assignments.filter((item) => item.tutor_internal_id).slice(0, 3);
  return { user, assignments, attendance, latestSoa: latestSoaRows[0] || null, tutors };
}



// Function: getTutorAssignedSubjects



// Role: Handles a reusable server-side operation used by this module.



async function getTutorAssignedSubjects(tutorId) {
  const tutor = await getUserById(tutorId);
  if (!tutor || tutor.role !== 'tutor') return [];

  const subjectRows = await query('SELECT id, name FROM subjects WHERE is_archived = 0 ORDER BY name ASC');
  const activeByKey = new Map(subjectRows.map((row) => [normalizeSubjectName(row.name), row]));
  const activeById = new Map(subjectRows.map((row) => [Number(row.id), row]));
  const archivedTutorSubjects = new Set(
    safeJsonArray(tutor.extra?.archived_subjects || []).map((name) => normalizeSubjectName(name))
  );
  const tutorSubjectKeys = [...new Set((tutor.subjects || safeJsonArray(tutor.subjects_json || '[]'))
    .map((name) => {
      try { return normalizeSubjectName(name); } catch (_error) { return ''; }
    })
    .filter(Boolean))];

  const assignmentCounts = await query(
    `SELECT usa.subject_id, COUNT(*) AS total_students
     FROM user_subject_assignments usa
     WHERE usa.tutor_id = ? AND usa.is_archived = 0
     GROUP BY usa.subject_id`,
    [tutorId]
  );
  const countMap = new Map(assignmentCounts.map((row) => [Number(row.subject_id), Number(row.total_students || 0)]));

  const subjectMap = new Map();
  for (const key of tutorSubjectKeys) {
    if (!archivedTutorSubjects.has(key) && activeByKey.has(key)) {
      const subject = activeByKey.get(key);
      subjectMap.set(Number(subject.id), {
        subject_id: Number(subject.id),
        subject_name: subject.name,
        total_students: countMap.get(Number(subject.id)) || 0
      });
    }
  }

  for (const [subjectId, total] of countMap.entries()) {
    const subject = activeById.get(Number(subjectId));
    if (!subject) continue;
    subjectMap.set(Number(subject.id), {
      subject_id: Number(subject.id),
      subject_name: subject.name,
      total_students: Number(total || 0)
    });
  }

  return Array.from(subjectMap.values()).sort((a, b) => a.subject_name.localeCompare(b.subject_name));
}

// Function: getTutorDashboardData

// Role: Handles a reusable server-side operation used by this module.

async function getTutorDashboardData(tutorId) {
  const user = await getUserById(tutorId);
  const [assignments, subjects] = await Promise.all([
    getTutorAssignments(tutorId),
    getTutorAssignedSubjects(tutorId)
  ]);
  const uniqueStudentIds = new Set(assignments.map(a => Number(a.student_id)));
  return { user, assignments, subjects, totalStudents: uniqueStudentIds.size };
}

// Function: getBillingRows

// Role: Handles a reusable server-side operation used by this module.

/**
 * Billing rows for the admin list.
 *
 * @param {number|null} scopeBranchId
 * @param {boolean|'all'} onlyPaid  true = settled only, false = outstanding only,
 *                                  'all' = both (what the row-based page uses,
 *                                  since it has a status filter of its own)
 * @param {object} [options]        { search, status }
 */
async function getBillingRows(scopeBranchId = null, onlyPaid = false, options = {}) {
  const scope = buildScopeClause(scopeBranchId, 'u.branch_id');
  const params = [...scope.params];

  let statusSql = '';
  if (onlyPaid === true) statusSql = "AND b.payment_status = 'paid'";
  else if (onlyPaid === false) statusSql = "AND b.payment_status <> 'paid'";

  if (options.status && options.status !== 'all') {
    statusSql += ' AND b.payment_status = ?';
    params.push(String(options.status));
  }

  let searchSql = '';
  const search = String(options.search || '').trim().toLowerCase();
  if (search) {
    searchSql = `AND (LOWER(CONCAT(COALESCE(u.first_name,''), ' ', COALESCE(u.middle_name,''), ' ', COALESCE(u.last_name,''))) LIKE ?
                 OR LOWER(u.user_id) LIKE ? OR LOWER(COALESCE(br.name,'')) LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  // One student's row — what Student Bill's dialogs are built from.
  if (options.studentId) {
    searchSql += ' AND b.student_id = ?';
    params.push(Number(options.studentId));
  }

  return query(
    // NOTE: do not add `u.id AS student_id` back. `b.*` already carries
    // billing.student_id, and the join pins it to u.id, so the alias only made
    // the name appear TWICE in the result set. node-mssql collapses a repeated
    // column name into an ARRAY (see mssql/lib/tedious/request.js), so every row
    // came back with student_id = [9, 9]. That rendered as "9,9" in the Student
    // Bill link, and /profile/9,9 then failed converting it to int.
    `SELECT b.*, u.user_id, u.first_name, u.middle_name, u.last_name,
            u.address, u.contact_number, u.branch_id, br.name AS branch_name
     FROM billing b
     INNER JOIN users u ON u.id = b.student_id
     LEFT JOIN branches br ON br.id = u.branch_id
     WHERE u.role = 'student' AND u.is_archived = 0 ${scope.sql} ${statusSql} ${searchSql}
     ORDER BY u.first_name ASC, u.last_name ASC`,
    params
  );
}

// Function: getBillingByStudentId

// Role: Handles a reusable server-side operation used by this module.

async function getBillingByStudentId(studentId) {
  const rows = await query(
    `SELECT TOP 1 b.*, u.user_id, u.first_name, u.middle_name, u.last_name, u.address, u.contact_number, u.branch_id
     FROM billing b
     INNER JOIN users u ON u.id = b.student_id
     WHERE b.student_id = ?`,
    [studentId]
  );
  return rows[0] || null;
}

// Function: updateBilling

// Role: Handles a reusable server-side operation used by this module.

/**
 * Update the billing HEADER — what is owed, when it is due, the SOA type.
 *
 * It used to also take `partial_payment` straight off the form and write it over
 * whatever was there, which is why pressing Edit a second time replaced the first
 * payment instead of adding to it. Payments now live in payment_entries and are
 * only ever appended (lib/billing.js), so this function no longer touches money
 * received: `partial_payment` in the request body is deliberately ignored.
 */
async function updateBilling(studentId, payload, adminId) {
  const { updateBillingHeader } = require('./billing');
  const actor = adminId ? await getUserById(adminId) : null;
  const result = await updateBillingHeader(studentId, payload, actor || { id: adminId });

  if (payload.post_now) {
    await query(
      'UPDATE billing SET soa_posted_at = DATEADD(hour, 8, GETUTCDATE()), posted_by = ? WHERE student_id = ?',
      [adminId, studentId]
    );
  }
  return result;
}

// Function: markBillPaid

// Role: Handles a reusable server-side operation used by this module.

/**
 * Stamp an account as settled.
 *
 * No payment row is written here any more. The ledger is the only place money is
 * recorded, and an account only reaches for_settlement = 0 by having entries that
 * add up to the full bill — so writing another one would double-count the lot.
 */
async function markBillPaid(billingId, adminId) {
  const rows = await query('SELECT TOP 1 * FROM billing WHERE id = ?', [billingId]);
  const bill = rows[0];
  if (!bill) return false;
  if (Number(bill.for_settlement || 0) > 0 || Number(bill.full_bill || 0) <= 0) {
    throw new Error('Student must complete the full payment before marking as paid. Add the remaining payment first.');
  }
  await query(
    `UPDATE billing SET payment_status = 'paid', last_paid_at = COALESCE(last_paid_at, DATEADD(hour, 8, GETUTCDATE())),
        posted_by = ?, updated_at = DATEADD(hour, 8, GETUTCDATE())
      WHERE id = ?`,
    [adminId, billingId]
  );
  return true;
}

// Function: reenrollStudents

// Role: Handles a reusable server-side operation used by this module.

/**
 * Start a new cycle for these students: every active subject gets a fresh month
 * from today, and the bill is re-priced from how many subjects that is.
 *
 * This used to write a flat ₱1,800 over every account regardless of how many
 * subjects they held, which is the same bug Phase 4.1 fixes everywhere else —
 * re-enrolling a two-subject student HALVED what they owed.
 */
async function reenrollStudents(studentIds) {
  const ids = (Array.isArray(studentIds) ? studentIds : [studentIds]).map((id) => Number(id)).filter(Boolean);
  if (!ids.length) return false;

  for (const studentId of ids) {
    // Every subject restarts together here because this IS the re-enrolment
    // action — unlike a mid-cycle addition, which keeps its own dates.
    await query(
      `UPDATE user_subject_assignments
          SET start_date = ?, end_date = ?, updated_at = DATEADD(hour, 8, GETUTCDATE())
        WHERE student_id = ? AND is_archived = 0`,
      [todayDate(), plusOneMonth(new Date()), studentId]
    );
    await query('UPDATE billing SET last_paid_at = NULL WHERE student_id = ?', [studentId]);
    await recalculateStudentBilling(null, studentId);
  }
  return true;
}

// Function: getPaymentHistory

// Role: Handles a reusable server-side operation used by this module.

/**
 * Payment history, read from the append-only ledger.
 *
 * The column names are kept identical to the old payment_history shape so every
 * page that already renders this list keeps working — the source moved, the
 * contract did not. payment_history itself is left untouched as an audit trail of
 * the pre-upgrade system; it is no longer written to or read from.
 */
async function getPaymentHistory(scopeBranchId = null) {
  const scope = buildScopeClause(scopeBranchId, 'u.branch_id');
  return query(
    `SELECT pe.id, pe.billing_id, pe.student_id, pe.amount, pe.paid_at, pe.recorded_by,
            pe.payment_method, pe.reference_no AS provider_reference, pe.purpose AS transaction_type,
            pe.balance_after, pe.notes AS remarks, pe.sequence_no, pe.is_locked, pe.recorded_by_name,
            b.payment_status, b.full_bill,
            u.first_name, u.middle_name, u.last_name, u.user_id, u.branch_id, br.name AS branch_name
     FROM payment_entries pe
     INNER JOIN users u ON u.id = pe.student_id
     LEFT JOIN branches br ON br.id = u.branch_id
     LEFT JOIN billing b ON b.id = pe.billing_id
     WHERE 1=1 ${scope.sql}
     ORDER BY pe.paid_at DESC, pe.id DESC`,
    scope.params
  );
}

// Function: postSoa

// Role: Handles a reusable server-side operation used by this module.

async function postSoa(studentId, adminId) {
  const bill = await getBillingByStudentId(studentId);
  const user = await getUserById(studentId);
  if (!bill || !user) return false;
  await query(
    `INSERT INTO soa_posts (
      billing_id, student_id, branch_id, student_user_id, student_full_name, address,
      contact_number, statement_date, full_bill, partial_payment, for_settlement, payment_due, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, DATEADD(hour, 8, GETUTCDATE()), ?, ?, ?, ?, ?)`,
    [
      bill.id,
      studentId,
      user.branch_id || null,
      user.user_id,
      fullName(user),
      user.address || '',
      user.contact_number || '',
      bill.full_bill || 0,
      bill.partial_payment || 0,
      bill.for_settlement || 0,
      bill.payment_due || null,
      adminId
    ]
  );
  await query('UPDATE billing SET soa_posted_at = DATEADD(hour, 8, GETUTCDATE()), posted_by = ? WHERE id = ?', [adminId, bill.id]);
  return true;
}

// Function: getStudentBillingView

// Role: Handles a reusable server-side operation used by this module.

/**
 * The student's billing view.
 *
 * Kept for the routes that still call it; the merged "Billing Data" page uses
 * getStudentBillingData in lib/billing.js, which adds the ledger totals and the
 * student's own payment requests. Payment history here reads payment_entries so
 * the two pages can never show a different history.
 */
async function getStudentBillingView(studentId) {
  const bill = await getBillingByStudentId(studentId);
  const statements = await query('SELECT * FROM soa_posts WHERE student_id = ? ORDER BY created_at DESC', [studentId]);
  const paymentHistory = await query(
    `SELECT pe.id, pe.amount, pe.paid_at, pe.payment_method, pe.purpose AS transaction_type,
            pe.reference_no, pe.balance_after, pe.notes AS remarks, pe.sequence_no,
            pe.is_locked, pe.recorded_by_name,
            b.full_bill, b.payment_status
     FROM payment_entries pe
     LEFT JOIN billing b ON b.id = pe.billing_id
     WHERE pe.student_id = ?
     ORDER BY pe.paid_at DESC, pe.id DESC`,
    [studentId]
  );
  const currentBill = bill && bill.payment_status !== 'paid' ? bill : null;
  return { bill: currentBill, originalBill: bill, statements, paymentHistory };
}

// Function: addSubject

// Role: Handles a reusable server-side operation used by this module.

async function addSubject(name) {
  const normalized = normalizeSubjectName(name);
  const existing = await query('SELECT TOP 1 * FROM subjects WHERE UPPER(LTRIM(RTRIM(name))) = UPPER(LTRIM(RTRIM(?)))', [normalized]);
  if (existing.length) {
    if (Number(existing[0].is_archived) === 1) {
      await query('UPDATE subjects SET name = ?, is_archived = 0, updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?', [normalized, existing[0].id]);
      return existing[0].id;
    }
    throw new Error('Subject already exists.');
  }
  try {
    const result = await query('INSERT INTO subjects (name, is_archived) VALUES (?, 0)', [normalized]);
    return result.insertId;
  } catch (error) {
    if (String(error.message || '').toLowerCase().includes('duplicate key')) {
      throw new Error('Subject already exists.');
    }
    throw error;
  }
}


// Function: archiveSubject


// Role: Handles a reusable server-side operation used by this module.


async function archiveSubject(id) {
  await query('UPDATE subjects SET is_archived = 1 WHERE id = ?', [id]);
}

// Function: recoverSubject

// Role: Handles a reusable server-side operation used by this module.

async function recoverSubject(id) {
  await query('UPDATE subjects SET is_archived = 0 WHERE id = ?', [id]);
}

// Function: deleteSubjectPermanently

// Role: Handles a reusable server-side operation used by this module.

async function deleteSubjectPermanently(id) {
  await query('DELETE FROM subjects WHERE id = ?', [id]);
}

// Function: getSubjectMembers

// Role: Handles a reusable server-side operation used by this module.

async function getSubjectMembers(subjectId, scopeBranchId = null) {
  const subject = await getSubjectById(subjectId);
  const users = await getUsers({ scopeBranchId, role: 'all', archived: false });
  const students = [];
  const tutors = [];

  for (const user of users) {
    if (user.role === 'tutor' && subject && tutorTeachesSubject(user, subject.name)) {
      tutors.push(user);
    }
  }

  const assignmentScope = scopeBranchId ? 'AND u.branch_id = ?' : '';
  const rows = await query(
    // u.branch_id is aliased because usa.* already brings a branch_id along.
    // Two columns of the same name arrive as an array, not a number.
    `SELECT usa.*, u.user_id, u.first_name, u.middle_name, u.last_name,
            u.branch_id AS student_branch_id, u.year_level, u.grade_level,
            b.name AS branch_name,
            t.id AS tutor_profile_id, t.first_name AS tutor_first_name, t.middle_name AS tutor_middle_name, t.last_name AS tutor_last_name
     FROM user_subject_assignments usa
     INNER JOIN users u ON u.id = usa.student_id
     LEFT JOIN branches b ON b.id = u.branch_id
     LEFT JOIN users t ON t.id = usa.tutor_id
     WHERE usa.subject_id = ? AND usa.is_archived = 0 ${assignmentScope}
     ORDER BY u.first_name ASC`,
    scopeBranchId ? [subjectId, scopeBranchId] : [subjectId]
  );

  for (const row of rows) {
    students.push({
      ...row,
      full_name: fullName(row),
      tutor_name: row.tutor_profile_id ? fullName({first_name: row.tutor_first_name, middle_name: row.tutor_middle_name, last_name: row.tutor_last_name}) : ''
    });
  }

  return { subject, students, tutors };
}

// Function: assignStudentsToTutor

// Role: Handles a reusable server-side operation used by this module.

async function assignStudentsToTutor(subjectId, tutorId, studentIds, adminId) {
  const subject = await getSubjectById(subjectId);
  const tutor = await getUserById(tutorId);
  if (!subject) throw new Error('Subject not found.');
  if (!tutor || tutor.role !== 'tutor') throw new Error('Tutor not found.');
  if (!tutorTeachesSubject(tutor, subject.name)) {
    throw new Error('Tutor is not enrolled in this subject.');
  }

  const ids = [...new Set((Array.isArray(studentIds) ? studentIds : [studentIds]).map((id) => Number(id)).filter(Boolean))];
  if (!ids.length) throw new Error('Please select at least one student.');

  const assignments = await query(
    `SELECT usa.id, usa.student_id, usa.tutor_id, u.branch_id, u.is_archived
     FROM user_subject_assignments usa
     INNER JOIN users u ON u.id = usa.student_id
     WHERE usa.subject_id = ? AND usa.student_id IN (${ids.map(() => '?').join(',')})`,
    [subjectId, ...ids]
  );

  const validRows = assignments.filter((row) => Number(row.is_archived || 0) === 0 && Number(row.student_id || 0) > 0);
  if (!validRows.length) throw new Error('Selected students are not enrolled in this subject.');

  const studentRows = await query(
    `SELECT id, branch_id, year_level, grade_level FROM users WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids
  );
  const studentMap = new Map(studentRows.map((row) => [Number(row.id), row]));

  const invalidScopeRow = validRows.find((row) => {
    const student = studentMap.get(Number(row.student_id)) || row;
    return !matchesTutorStudentScope(tutor, student).isMatch;
  });
  if (invalidScopeRow) {
    const student = studentMap.get(Number(invalidScopeRow.student_id)) || invalidScopeRow;
    const scopeMatch = matchesTutorStudentScope(tutor, student);
    if (!scopeMatch.branchMatch) {
      throw new Error('You can only assign students from the same branch as the tutor.');
    }
    if (!scopeMatch.yearLevelMatch) {
      throw new Error('You can only assign students with the same year level handled by the tutor.');
    }
    throw new Error('Selected student does not match the tutor assignment rules.');
  }

  for (const row of validRows) {
    await query(
      `UPDATE user_subject_assignments
       SET tutor_id = ?, assigned_at = DATEADD(hour, 8, GETUTCDATE()), accepted_by = ?, branch_id = ?, updated_at = DATEADD(hour, 8, GETUTCDATE())
       WHERE id = ?`,
      [tutorId, adminId, row.branch_id || tutor.branch_id || null, row.id]
    );
  }
}

// Function: archiveAssignment

// Role: Handles a reusable server-side operation used by this module.

async function archiveAssignment(id) {
  const rows = await query(`SELECT TOP 1 usa.*, s.name AS subject_name, u.subjects_json, u.extra_json FROM user_subject_assignments usa INNER JOIN subjects s ON s.id = usa.subject_id INNER JOIN users u ON u.id = usa.student_id WHERE usa.id = ?`, [id]);
  const row = rows[0];
  if (!row) return;
  const subjects = repairNameList(safeJsonArray(row.subjects_json)).filter((name) => name !== row.subject_name);
  const extra = safeJsonObject(row.extra_json);
  const archived = safeJsonArray(extra.archived_subjects);
  if (!archived.includes(row.subject_name)) archived.push(row.subject_name);
  await query('UPDATE users SET subjects_json = ?, extra_json = ? WHERE id = ?', [JSON.stringify(subjects), JSON.stringify({ ...extra, archived_subjects: archived }), row.student_id]);
  await query('UPDATE user_subject_assignments SET is_archived = 1 WHERE id = ?', [id]);
}

// Function: recoverAssignment

// Role: Handles a reusable server-side operation used by this module.

async function recoverAssignment(id) {
  const rows = await query(`SELECT TOP 1 usa.*, s.name AS subject_name, u.subjects_json, u.extra_json FROM user_subject_assignments usa INNER JOIN subjects s ON s.id = usa.subject_id INNER JOIN users u ON u.id = usa.student_id WHERE usa.id = ?`, [id]);
  const row = rows[0];
  if (!row) return;
  const subjects = repairNameList(safeJsonArray(row.subjects_json));
  if (!subjects.includes(row.subject_name)) subjects.push(row.subject_name);
  const extra = safeJsonObject(row.extra_json);
  const archived = safeJsonArray(extra.archived_subjects).filter((name) => name !== row.subject_name);
  await query('UPDATE users SET subjects_json = ?, extra_json = ? WHERE id = ?', [JSON.stringify(subjects), JSON.stringify({ ...extra, archived_subjects: archived }), row.student_id]);
  await query('UPDATE user_subject_assignments SET is_archived = 0 WHERE id = ?', [id]);
}

// Function: archiveTutorSubject

// Role: Handles a reusable server-side operation used by this module.

async function archiveTutorSubject(subjectId, tutorId) {
  const [subject, user] = await Promise.all([getSubjectById(subjectId), getUserById(tutorId)]);
  if (!subject || !user) return;
  const subjects = (user.subjects || []).filter((name) => name !== subject.name);
  const archived = safeJsonArray(user.extra?.archived_subjects || []);
  if (!archived.includes(subject.name)) archived.push(subject.name);
  await query('UPDATE users SET subjects_json = ?, extra_json = ? WHERE id = ?', [JSON.stringify(subjects), JSON.stringify({ ...user.extra, archived_subjects: archived }), tutorId]);
}

// Function: recoverTutorSubject

// Role: Handles a reusable server-side operation used by this module.

async function recoverTutorSubject(subjectId, tutorId) {
  const [subject, user] = await Promise.all([getSubjectById(subjectId), getUserById(tutorId)]);
  if (!subject || !user) return;
  const subjects = [...(user.subjects || [])];
  if (!subjects.includes(subject.name)) subjects.push(subject.name);
  const archived = safeJsonArray(user.extra?.archived_subjects || []).filter((name) => name !== subject.name);
  await query('UPDATE users SET subjects_json = ?, extra_json = ? WHERE id = ?', [JSON.stringify(subjects), JSON.stringify({ ...user.extra, archived_subjects: archived }), tutorId]);
}

// Function: getSubjectArchivedTutors

// Role: Handles a reusable server-side operation used by this module.

async function getSubjectArchivedTutors(subjectId, scopeBranchId = null) {
  const subject = await getSubjectById(subjectId);
  if (!subject) return [];
  const users = await getUsers({ scopeBranchId, role: 'all', archived: false });
  return users.filter((user) => user.role === 'tutor' && safeJsonArray(user.extra?.archived_subjects || []).includes(subject.name));
}

// Function: getSubjectArchivedAssignments

// Role: Handles a reusable server-side operation used by this module.

async function getSubjectArchivedAssignments(subjectId) {
  return query(
    `SELECT usa.*, u.first_name, u.middle_name, u.last_name, u.role, u.year_level, u.grade_level, b.name AS branch_name
     FROM user_subject_assignments usa
     INNER JOIN users u ON u.id = usa.student_id
     LEFT JOIN branches b ON b.id = u.branch_id
     WHERE usa.subject_id = ? AND usa.is_archived = 1
     ORDER BY usa.updated_at DESC`,
    [subjectId]
  );
}

// Function: addSubjectResource

// Role: Handles a reusable server-side operation used by this module.

async function addSubjectResource(userId, subjectId, title, description, fileData, options = {}) {
  const createdByRole = options.created_by_role || 'tutor';
  const assignedStudentId = options.assigned_student_id || null;
  const sourceResourceId = options.source_resource_id || null;
  const typeOfModule = options.type_of_module || null;
  const moduleOrigin = options.module_origin || 'admin_upload';
  const difficultyLevel = options.difficulty_level || null;
  const contentText = options.content_text || null;
  const generatedFromAssessmentId = options.generated_from_assessment_id || null;
  const generatedFromResultId = options.generated_from_result_id || null;
  const generationRound = options.generation_round || null;
  const result = await query(
    `INSERT INTO subject_resources (subject_id, tutor_id, title, description, file_path, file_type, created_by_role, assigned_student_id, source_resource_id, type_of_module, module_origin, difficulty_level, content_text, generated_from_assessment_id, generated_from_result_id, generation_round)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [subjectId, userId, title, description || '', fileData?.path || null, fileData?.mimetype || '', createdByRole, assignedStudentId, sourceResourceId, typeOfModule, moduleOrigin, difficultyLevel, contentText, generatedFromAssessmentId, generatedFromResultId, generationRound]
  );
  return result.insertId;
}

// Function: getAdminSubjectResources

// Role: Handles a reusable server-side operation used by this module.

async function getAdminSubjectResources(subjectId) {
  const rows = await query(
    `SELECT sr.*, u.first_name, u.middle_name, u.last_name
     FROM subject_resources sr
     INNER JOIN users u ON u.id = sr.tutor_id
     WHERE sr.subject_id = ?
       AND sr.module_origin != 'ai_generated'
       AND sr.created_by_role NOT IN ('ai_generated')
       AND ISNULL(sr.is_archived, 0) = 0
     ORDER BY sr.created_at DESC`,
    [subjectId]
  );
  return rows.map((row) => ({ ...row, tutor_name: fullName(row) }));
}

// Function: shareAdminResourceToStudents

// Role: Handles a reusable server-side operation used by this module.

async function shareAdminResourceToStudents(resourceId, tutorId, studentIds = []) {
  const rows = await query('SELECT TOP 1 * FROM subject_resources WHERE id = ? AND created_by_role = ?', [resourceId, 'admin_template']);
  const source = rows[0] || null;
  if (!source) throw new Error('Admin module not found.');
  const ids = [...new Set((Array.isArray(studentIds) ? studentIds : [studentIds]).map((id) => Number(id)).filter(Boolean))];
  if (!ids.length) throw new Error('Please select at least one student.');
  for (const studentId of ids) {
    const existing = await query('SELECT TOP 1 id FROM subject_resources WHERE source_resource_id = ? AND assigned_student_id = ? AND tutor_id = ?', [resourceId, studentId, tutorId]);
    if (!existing.length) {
      await addSubjectResource(tutorId, source.subject_id, source.title, source.description, source.file_path ? { path: source.file_path, mimetype: source.file_type } : null, {
        created_by_role: 'tutor_share',
        assigned_student_id: studentId,
        source_resource_id: resourceId
      });
    }
  }
}

// Function: deleteSubjectResource

// Role: Handles a reusable server-side operation used by this module.

async function deleteSubjectResource(resourceId, tutorId) {
  await query("DELETE FROM subject_resources WHERE id = ? AND tutor_id = ? AND created_by_role = 'tutor_share'", [resourceId, tutorId]);
}

// Function: getTutorSharedResources

// Role: Handles a reusable server-side operation used by this module.

async function getTutorSharedResources(subjectId, tutorId) {
  const rows = await query(
    `SELECT sr.*, u.first_name, u.middle_name, u.last_name, st.first_name AS student_first_name, st.last_name AS student_last_name
     FROM subject_resources sr
     INNER JOIN users u ON u.id = sr.tutor_id
     LEFT JOIN users st ON st.id = sr.assigned_student_id
     WHERE sr.subject_id = ? AND sr.tutor_id = ? AND sr.created_by_role = 'tutor_share'
     ORDER BY sr.created_at DESC`,
    [subjectId, tutorId]
  );
  return rows.map((row) => ({ ...row, tutor_name: fullName(row), student_name: [row.student_first_name, row.student_last_name].filter(Boolean).join(' ') }));
}

// Function: getSubjectResources

// Role: Handles a reusable server-side operation used by this module.

async function getSubjectResources(subjectId, viewerId = null, options = {}) {
  if (options.mode === 'student') {
    const rows = await query(
      `SELECT sr.*, u.first_name, u.middle_name, u.last_name
       FROM subject_resources sr
       INNER JOIN users u ON u.id = sr.tutor_id
       WHERE sr.subject_id = ? AND sr.created_by_role = 'tutor_share' AND sr.assigned_student_id = ?
       ORDER BY sr.created_at DESC`,
      [subjectId, viewerId]
    );
    return rows.map((row) => ({ ...row, tutor_name: fullName(row) }));
  }
  if (options.mode === 'admin_all') {
    const rows = await query(
      `SELECT sr.*, u.first_name, u.middle_name, u.last_name
       FROM subject_resources sr
       INNER JOIN users u ON u.id = sr.tutor_id
       WHERE sr.subject_id = ?
       ORDER BY sr.created_at DESC`,
      [subjectId]
    );
    return rows.map((row) => ({ ...row, tutor_name: fullName(row) }));
  }
  const rows = await query(
    `SELECT sr.*, u.first_name, u.middle_name, u.last_name
     FROM subject_resources sr
     INNER JOIN users u ON u.id = sr.tutor_id
     WHERE sr.subject_id = ? ${viewerId ? 'AND sr.tutor_id = ?' : ''}
     ORDER BY sr.created_at DESC`,
    viewerId ? [subjectId, viewerId] : [subjectId]
  );
  return rows.map((row) => ({ ...row, tutor_name: fullName(row) }));
}


// Function: getTutorSubjectsWithStudents


// Role: Handles a reusable server-side operation used by this module.


async function getTutorSubjectsWithStudents(tutorId) {
  // Primary: students assigned to tutor in user_subject_assignments
  const rows = await query(
    `SELECT s.id, s.name, u.id AS student_id, u.first_name, u.middle_name, u.last_name, u.year_level, u.grade_level, u.branch_id,
            b.name AS branch_name
     FROM user_subject_assignments usa
     INNER JOIN subjects s ON s.id = usa.subject_id
     INNER JOIN users u ON u.id = usa.student_id
     LEFT JOIN branches b ON b.id = u.branch_id
     WHERE usa.tutor_id = ? AND usa.is_archived = 0
     ORDER BY s.name ASC, u.first_name ASC, u.last_name ASC`,
    [tutorId]
  );
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.id)) map.set(row.id, { id: row.id, name: row.name, students: [] });
    map.get(row.id).students.push({
      student_id: row.student_id,
      full_name: fullName(row),
      year_level: row.year_level || '',
      grade_level: row.grade_level || '',
      branch_id: row.branch_id || null,
      branch_name: row.branch_name || '-'
    });
  }

  // Fallback: accepted tutor_schedule_applications — covers cases where user_subject_assignments.tutor_id not yet synced
  const appRows = await query(
    `SELECT DISTINCT tsa.subject_id, s.name AS subject_name,
            u.id AS student_id, u.first_name, u.middle_name, u.last_name, u.year_level, u.grade_level, u.branch_id,
            b.name AS branch_name
     FROM tutor_schedule_applications tsa
     INNER JOIN subjects s ON s.id = tsa.subject_id
     INNER JOIN users u ON u.id = tsa.student_id
     LEFT JOIN branches b ON b.id = u.branch_id
     WHERE tsa.tutor_id = ? AND tsa.status = 'accepted'
     ORDER BY s.name ASC, u.first_name ASC, u.last_name ASC`,
    [tutorId]
  );
  for (const row of appRows) {
    if (!map.has(row.subject_id)) {
      map.set(row.subject_id, { id: row.subject_id, name: row.subject_name, students: [] });
    }
    const subjectEntry = map.get(row.subject_id);
    const alreadyAdded = subjectEntry.students.some((s) => Number(s.student_id) === Number(row.student_id));
    if (!alreadyAdded) {
      subjectEntry.students.push({
        student_id: row.student_id,
        full_name: fullName(row),
        year_level: row.year_level || '',
        grade_level: row.grade_level || '',
        branch_id: row.branch_id || null,
        branch_name: row.branch_name || '-'
      });
    }
  }

  // Also show subjects from tutor profile even with no students yet assigned
  const tutor = await getUserById(tutorId);
  if (tutor && tutor.role === 'tutor') {
    const tutorSubjectNames = (tutor.subjects || [])
      .map((name) => normalizeSubjectName(name))
      .filter(Boolean);
    if (tutorSubjectNames.length) {
      const subjectRows = await query('SELECT id, name FROM subjects WHERE is_archived = 0 ORDER BY name ASC');
      for (const subject of subjectRows) {
        if (tutorSubjectNames.includes(normalizeSubjectName(subject.name)) && !map.has(subject.id)) {
          map.set(subject.id, { id: subject.id, name: subject.name, students: [] });
        }
      }
    }
  }

  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// Function: getTutorStudentsBySubject

// Role: Handles a reusable server-side operation used by this module.

async function getTutorStudentsBySubject(tutorId, subjectId = null) {
  const rows = await query(
    // usa.* already carries student_id and branch_id. Repeating either name (the
    // old `u.id AS student_id` and bare `u.branch_id`) made node-mssql hand back
    // an array instead of a number, so Number(row.student_id) was NaN and every
    // "your assigned students" check below rejected every student.
    `SELECT usa.*, s.name AS subject_name, u.user_id, u.first_name, u.middle_name, u.last_name, u.year_level, u.grade_level, u.branch_id AS student_branch_id, b.name AS branch_name, u.image_path AS student_image_path
     FROM user_subject_assignments usa
     INNER JOIN users u ON u.id = usa.student_id
     INNER JOIN subjects s ON s.id = usa.subject_id
     LEFT JOIN branches b ON b.id = u.branch_id
     WHERE usa.tutor_id = ? AND usa.is_archived = 0 ${subjectId ? 'AND usa.subject_id = ?' : ''}
     ORDER BY s.name, u.first_name`,
    subjectId ? [tutorId, subjectId] : [tutorId]
  );
  const mapped = rows.map((row) => ({
    ...row,
    full_name: fullName(row)
  }));
  // Deduplicate by student_id (aggregate subject names)
  if (!subjectId) {
    const seen = new Map();
    for (const row of mapped) {
      const key = Number(row.student_id);
      if (seen.has(key)) {
        const existing = seen.get(key);
        if (!existing.subject_name.includes(row.subject_name)) {
          existing.subject_name += ', ' + row.subject_name;
        }
      } else {
        seen.set(key, { ...row });
      }
    }
    return [...seen.values()];
  }
  return mapped;
}

// Function: saveAttendance

// Role: Handles a reusable server-side operation used by this module.

async function saveAttendance(tutorId, subjectId, attendanceDate, records) {
  const dateValue = dayjs(attendanceDate).format('YYYY-MM-DD');
  for (const entry of records) {
    if (!entry.student_id || !entry.status) continue;
    const existingRows = await query(
      'SELECT TOP 1 id FROM attendance WHERE student_id = ? AND tutor_id = ? AND subject_id = ? AND attendance_date = ?',
      [entry.student_id, tutorId, subjectId, dateValue]
    );
    if (existingRows.length) {
      await query(
        `UPDATE attendance
         SET status = ?, updated_at = DATEADD(hour, 8, GETUTCDATE())
         WHERE student_id = ? AND tutor_id = ? AND subject_id = ? AND attendance_date = ?`,
        [entry.status, entry.student_id, tutorId, subjectId, dateValue]
      );
    } else {
      await query(
        `INSERT INTO attendance (student_id, tutor_id, subject_id, attendance_date, status)
         VALUES (?, ?, ?, ?, ?)`,
        [entry.student_id, tutorId, subjectId, dateValue, entry.status]
      );
    }
  }
}

// Function: getAttendanceByTutor

// Role: Handles a reusable server-side operation used by this module.

async function getAttendanceByTutor(tutorId) {
  return query(
    `SELECT a.*, u.first_name, u.middle_name, u.last_name, s.name AS subject_name
     FROM attendance a
     INNER JOIN users u ON u.id = a.student_id
     INNER JOIN subjects s ON s.id = a.subject_id
     WHERE a.tutor_id = ?
     ORDER BY a.attendance_date DESC`,
    [tutorId]
  );
}

// Function: getAllowedContacts

// Role: Handles a reusable server-side operation used by this module.

async function getAllowedContacts(user, search = '') {
  const roles = allowedContactRoles(user.role);
  if (!roles.length) return [];
  const placeholders = roles.map(() => '?').join(',');
  const params = [...roles, user.id];
  let sql = `SELECT u.id, u.user_id, u.role, u.first_name, u.middle_name, u.last_name, u.email, u.image_path,
                    MAX(m.created_at) AS last_message_at
             FROM users u
             LEFT JOIN messages m
               ON ((m.sender_id = u.id AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = u.id))
             WHERE u.is_archived = 0 AND u.role IN (${placeholders}) AND u.id <> ?`;
  params.unshift(user.id, user.id);
  if (search) {
    sql += ` AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ? OR u.user_id LIKE ?)`;
    const value = `%${search}%`;
    params.push(value, value, value, value);
  } else {
    sql += ' AND m.id IS NOT NULL';
  }
  sql += ` GROUP BY u.id, u.user_id, u.role, u.first_name, u.middle_name, u.last_name, u.email, u.image_path
           ORDER BY MAX(m.created_at) DESC, u.first_name ASC, u.last_name ASC`;
  const rows = await query(sql, params);
  return rows;
}

// Function: getConversation

// Role: Handles a reusable server-side operation used by this module.

async function getConversation(userId, otherId) {
  return query(
    `SELECT m.*, s.first_name AS sender_first_name, s.middle_name AS sender_middle_name, s.last_name AS sender_last_name,
            r.first_name AS receiver_first_name, r.middle_name AS receiver_middle_name, r.last_name AS receiver_last_name
     FROM messages m
     INNER JOIN users s ON s.id = m.sender_id
     INNER JOIN users r ON r.id = m.receiver_id
     WHERE (m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?)
     ORDER BY m.created_at ASC`,
    [userId, otherId, otherId, userId]
  );
}

// Function: saveMessage

// Role: Handles a reusable server-side operation used by this module.

async function saveMessage(payload) {
  const result = await query(
    `INSERT INTO messages (sender_id, receiver_id, body, file_path, file_original_name, file_type)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      payload.sender_id,
      payload.receiver_id,
      payload.body || '',
      payload.file_path || null,
      payload.file_original_name || null,
      payload.file_type || ''
    ]
  );
  return result.insertId;
}

// Function: getMessageById

// Role: Handles a reusable server-side operation used by this module.

async function getMessageById(id) {
  const rows = await query('SELECT TOP 1 * FROM messages WHERE id = ?', [id]);
  return rows[0] || null;
}

// Function: updateMessageBody

// Role: Handles a reusable server-side operation used by this module.

async function updateMessageBody(id, body) {
  await query(
    'UPDATE messages SET body = ?, edited_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?',
    [String(body || '').trim(), id]
  );
}

// Function: unsendMessage

// Role: Handles a reusable server-side operation used by this module.

async function unsendMessage(id) {
  await query(
    `UPDATE messages
     SET body = '', file_path = NULL, file_original_name = NULL, file_type = '', is_unsent = 1, edited_at = DATEADD(hour, 8, GETUTCDATE())
     WHERE id = ?`,
    [id]
  );
}


// Function: createAssessmentTemplate


// Role: Handles a reusable server-side operation used by this module.


async function createAssessmentTemplate(payload) {
  return withTransaction(async (connection) => {
    const targetSubjectIds = [...new Set((Array.isArray(payload.target_subject_ids) ? payload.target_subject_ids : [payload.target_subject_ids]).map((value) => Number(value)).filter(Boolean))];
    const targetYearLevels = uniqueNames(payload.target_year_levels || []);
    const targetGradeLevels = uniqueNames(payload.target_grade_levels || []);
    const [insertResult] = await connection.query(
      `INSERT INTO assessment_templates (
        subject_id, title, assessment_type, target_subject_ids_json, target_year_levels_json, target_grade_levels_json, type_of_assessment_json, created_by, is_archived
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        payload.subject_id,
        payload.title,
        payload.assessment_type,
        JSON.stringify(targetSubjectIds),
        JSON.stringify(targetYearLevels),
        JSON.stringify(targetGradeLevels),
        JSON.stringify(Array.isArray(payload.type_of_assessment) ? payload.type_of_assessment : [payload.type_of_assessment].filter(Boolean)),
        payload.created_by || null
      ]
    );
    const templateId = insertResult.insertId;
    for (const question of (Array.isArray(payload.questions) ? payload.questions : [])) {
      await connection.query(
        `INSERT INTO assessment_template_questions (template_id, question_text, choice_a, choice_b, choice_c, choice_d, correct_answer, question_type, points)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [templateId, question.question_text, question.choice_a || '', question.choice_b || '', question.choice_c || '', question.choice_d || '', question.correct_answer, question.question_type || 'Multiple Choice', Number(question.points || 1)]
      );
    }
    return templateId;
  });
}

// Function: getAssessmentTemplates

// Role: Handles a reusable server-side operation used by this module.

async function getAssessmentTemplates(subjectId = null) {
  const rows = await query(
    `SELECT at.*, s.name AS subject_name, u.first_name, u.middle_name, u.last_name,
            (SELECT COUNT(*) FROM assessment_template_questions q WHERE q.template_id = at.id) AS total_questions
     FROM assessment_templates at
     INNER JOIN subjects s ON s.id = at.subject_id
     LEFT JOIN users u ON u.id = at.created_by
     WHERE at.is_archived = 0 ${subjectId ? 'AND at.subject_id = ?' : ''}
     ORDER BY at.created_at DESC`,
    subjectId ? [subjectId] : []
  );
  return rows.map((row) => ({ ...parseAssessmentTemplateRow(row), created_by_name: fullName(row) }));
}

// Function: getAssessmentTemplateById

// Role: Handles a reusable server-side operation used by this module.

async function getAssessmentTemplateById(id) {
  const rows = await query(
    `SELECT at.*, s.name AS subject_name, u.first_name, u.middle_name, u.last_name
     FROM assessment_templates at
     INNER JOIN subjects s ON s.id = at.subject_id
     LEFT JOIN users u ON u.id = at.created_by
     WHERE at.id = ?`,
    [id]
  );
  const template = parseAssessmentTemplateRow(rows[0] || null);
  if (!template) return null;
  const questions = await query('SELECT * FROM assessment_template_questions WHERE template_id = ? ORDER BY id ASC', [id]);
  return { ...template, questions, created_by_name: fullName(template) };
}

// Function: getStudentsMatchingAssessmentTemplate

// Role: Handles a reusable server-side operation used by this module.

async function getStudentsMatchingAssessmentTemplate(template, scopeBranchId = null) {
  const resolvedTemplate = template?.id ? (template.questions ? template : await getAssessmentTemplateById(template.id)) : await getAssessmentTemplateById(template);
  if (!resolvedTemplate) return [];

  const subjectIds = [...new Set([
    ...((Array.isArray(resolvedTemplate.target_subject_ids) ? resolvedTemplate.target_subject_ids : []).map((value) => Number(value)).filter(Boolean)),
    Number(resolvedTemplate.subject_id || 0)
  ].filter(Boolean))];
  const yearLevels = uniqueNames(resolvedTemplate.target_year_levels || []);
  const gradeLevels = uniqueNames(resolvedTemplate.target_grade_levels || []);

  const params = [];
  const conditions = ["u.role = 'student'", 'u.is_archived = 0', 'usa.is_archived = 0'];

  if (scopeBranchId) {
    conditions.push('u.branch_id = ?');
    params.push(Number(scopeBranchId));
  }

  if (subjectIds.length) {
    conditions.push(`usa.subject_id IN (${subjectIds.map(() => '?').join(',')})`);
    params.push(...subjectIds);
  }

  if (yearLevels.length) {
    conditions.push(`u.year_level IN (${yearLevels.map(() => '?').join(',')})`);
    params.push(...yearLevels);
  }

  if (gradeLevels.length) {
    conditions.push(`u.grade_level IN (${gradeLevels.map(() => '?').join(',')})`);
    params.push(...gradeLevels);
  }

  const rows = await query(
    `SELECT DISTINCT
        u.id AS student_id,
        u.user_id,
        u.first_name,
        u.middle_name,
        u.last_name,
        u.year_level,
        u.grade_level,
        u.branch_id,
        b.name AS branch_name,
        s.name AS subject_name
     FROM users u
     INNER JOIN user_subject_assignments usa ON usa.student_id = u.id
     INNER JOIN subjects s ON s.id = usa.subject_id
     LEFT JOIN branches b ON b.id = u.branch_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY u.first_name ASC, u.last_name ASC`,
    params
  );

  return rows.map((row) => ({
    ...row,
    full_name: fullName(row)
  }));
}

// Function: assignAssessmentTemplateToStudents

// Role: Handles a reusable server-side operation used by this module.

async function assignAssessmentTemplateToStudents(templateId, tutorId, studentIds = [], branchId = null) {
  const template = await getAssessmentTemplateById(templateId);
  if (!template) throw new Error('Assessment template not found.');
  const ids = [...new Set((Array.isArray(studentIds) ? studentIds : [studentIds]).map((id) => Number(id)).filter(Boolean))];
  if (!ids.length) throw new Error('Please select at least one student.');
  return createAssessment({
    title: template.title,
    assessment_type: template.assessment_type,
    branch_id: branchId || null,
    assigned_student_ids: ids,
    created_by: template.created_by,
    assigned_by_tutor_id: tutorId,
    subject_id: template.subject_id,
    source_template_id: template.id,
    questions: template.questions
  });
}

// Function: createAssessment

// Role: Handles a reusable server-side operation used by this module.

async function createAssessment(payload) {
  return withTransaction(async (connection) => {
    const studentIds = Array.isArray(payload.assigned_student_ids) && payload.assigned_student_ids.length
      ? payload.assigned_student_ids
      : [payload.assigned_student_id];
    let lastAssessmentId = null;
    for (const studentId of studentIds.filter(Boolean)) {
      const [insertResult] = await connection.query(
        `INSERT INTO assessments (title, assessment_type, branch_id, assigned_student_id, created_by, is_published, subject_id, source_template_id, assigned_by_tutor_id)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        [payload.title, payload.assessment_type, payload.branch_id || null, studentId, payload.created_by, payload.subject_id || null, payload.source_template_id || null, payload.assigned_by_tutor_id || null]
      );
      const assessmentId = insertResult.insertId;
      lastAssessmentId = assessmentId;
      const questions = Array.isArray(payload.questions) ? payload.questions : [];
      for (const question of questions) {
        await connection.query(
          `INSERT INTO assessment_questions (
            assessment_id, question_text, choice_a, choice_b, choice_c, choice_d, correct_answer, question_type, points
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [assessmentId, question.question_text, question.choice_a || '', question.choice_b || '', question.choice_c || '', question.choice_d || '', question.correct_answer, question.question_type || 'Multiple Choice', Number(question.points || 1)]
        );
      }
    }
    return lastAssessmentId;
  });
}


// Function: getAssessments


// Role: Handles a reusable server-side operation used by this module.


async function getAssessments(scopeBranchId = null) {
  const scope = buildScopeClause(scopeBranchId, 'a.branch_id');
  return query(
    `SELECT a.*, s.name AS subject_name, at.title AS template_title, u.user_id, u.first_name, u.middle_name, u.last_name, ar.score, ar.total_questions, ar.percentage, ar.level, ar.taken_at
     FROM assessments a
     INNER JOIN users u ON u.id = a.assigned_student_id
     LEFT JOIN subjects s ON s.id = a.subject_id
     LEFT JOIN assessment_templates at ON at.id = a.source_template_id
     LEFT JOIN assessment_results ar ON ar.assessment_id = a.id AND ar.student_id = a.assigned_student_id
     WHERE a.is_published = 1 ${scope.sql}
     ORDER BY a.created_at DESC`,
    scope.params
  );
}

// Function: getAssessmentHistory

// Role: Handles a reusable server-side operation used by this module.

async function getAssessmentHistory(scopeBranchId = null) {
  const scope = buildScopeClause(scopeBranchId, 'a.branch_id');
  return query(
    `SELECT a.*, s.name AS subject_name, at.title AS template_title, u.user_id, u.first_name, u.middle_name, u.last_name, ar.score, ar.total_questions, ar.percentage, ar.level, ar.taken_at
     FROM assessments a
     INNER JOIN users u ON u.id = a.assigned_student_id
     LEFT JOIN subjects s ON s.id = a.subject_id
     LEFT JOIN assessment_templates at ON at.id = a.source_template_id
     LEFT JOIN assessment_results ar ON ar.assessment_id = a.id AND ar.student_id = a.assigned_student_id
     WHERE a.is_published = 0 ${scope.sql}
     ORDER BY COALESCE(ar.taken_at, a.updated_at, a.created_at) DESC`,
    scope.params
  );
}

// Function: markAssessmentDone

// Role: Handles a reusable server-side operation used by this module.

async function markAssessmentDone(id) {
  await query('UPDATE assessments SET is_published = 0 WHERE id = ?', [id]);
}

// Function: recoverAssessment

// Role: Handles a reusable server-side operation used by this module.

async function recoverAssessment(id) {
  await query('UPDATE assessments SET is_published = 1 WHERE id = ?', [id]);
}

// Function: deleteAssessmentPermanently

// Role: Handles a reusable server-side operation used by this module.

async function deleteAssessmentPermanently(id) {
  await query('DELETE FROM assessments WHERE id = ?', [id]);
}

// Function: getAssessmentById

// Role: Handles a reusable server-side operation used by this module.

async function getAssessmentById(id, studentId = null) {
  const rows = await query(
    // a.* already carries assessments.branch_id; the student's branch is aliased
    // so the two do not collide into an array (which made the assistant-admin
    // branch check below compare NaN and refuse every assessment).
    `SELECT TOP 1 a.*, s.name AS subject_name, at.title AS template_title, u.user_id, u.first_name, u.middle_name, u.last_name, u.branch_id AS student_branch_id
     FROM assessments a
     INNER JOIN users u ON u.id = a.assigned_student_id
     LEFT JOIN subjects s ON s.id = a.subject_id
     LEFT JOIN assessment_templates at ON at.id = a.source_template_id
     WHERE a.id = ?`,
    [id]
  );
  const assessment = rows[0] || null;
  if (!assessment) return null;

  const effectiveStudentId = studentId == null ? assessment.assigned_student_id : studentId;
  const questions = await query('SELECT * FROM assessment_questions WHERE assessment_id = ? ORDER BY id ASC', [id]);
  const results = await query(
    'SELECT TOP 1 * FROM assessment_results WHERE assessment_id = ? AND student_id = ? ORDER BY taken_at DESC, id DESC',
    [id, effectiveStudentId]
  );

  let submittedAnswers = {};
  if (results[0] && results[0].answers_json) {
    try {
      submittedAnswers = JSON.parse(results[0].answers_json) || {};
    } catch (error) {
      submittedAnswers = {};
    }
  }

  return { ...assessment, questions, result: results[0] || null, submittedAnswers };
}

// Function: resetAssessmentResult

// Role: Handles a reusable server-side operation used by this module.

async function resetAssessmentResult(assessmentId, studentId) {
  await query('DELETE FROM assessment_results WHERE assessment_id = ? AND student_id = ?', [assessmentId, studentId]);
}

// Function: getStudentAssessments

// Role: Handles a reusable server-side operation used by this module.

async function getStudentAssessments(studentId) {
  return query(
    `SELECT a.*, s.name AS subject_name, at.title AS template_title, ar.score, ar.total_questions, ar.percentage, ar.level, ar.taken_at
     FROM assessments a
     LEFT JOIN subjects s ON s.id = a.subject_id
     LEFT JOIN assessment_templates at ON at.id = a.source_template_id
     LEFT JOIN assessment_results ar ON ar.assessment_id = a.id AND ar.student_id = a.assigned_student_id
     WHERE a.assigned_student_id = ? AND a.is_published = 1
     ORDER BY a.created_at DESC`,
    [studentId]
  );
}

// Function: scoreToLevel

// Role: Provides helper logic for this file.

/**
 * Kept as the historical name used across this module. It now delegates to the
 * single source of truth in config/levelThresholds.js — it used to carry its own
 * 0-40 / 41-70 / 71-100 bands, which disagreed both with determineLevel() and
 * with the spec's 0-50 / 51-80 / 81-100.
 */
function scoreToLevel(percentage) {
  return determineLevel(percentage);
}

// Function: extractSubmittedAssessmentAnswers

// Role: Provides helper logic for this file.

function extractSubmittedAssessmentAnswers(payload = {}, questionRows = []) {
  const raw = payload && typeof payload === 'object' ? payload : {};
  const extracted = {};

  if (raw.answers && typeof raw.answers === 'object') {
    for (const [key, value] of Object.entries(raw.answers)) extracted[String(key)] = value;
  }

  for (const [key, value] of Object.entries(raw)) {
    const nestedMatch = String(key).match(/^answers\[(.+)\]$/);
    if (nestedMatch) {
      extracted[String(nestedMatch[1])] = value;
      continue;
    }
    const flatMatch = String(key).match(/^answer_(\d+)$/);
    if (flatMatch) extracted[String(flatMatch[1])] = value;
  }

  for (const question of questionRows) {
    const qid = String(question.id);
    if (!(qid in extracted) && Array.isArray(raw.question_ids) && raw.question_ids.map(String).includes(qid)) extracted[qid] = '';
  }

  return extracted;
}

// Function: submitAssessment

// Role: Handles a reusable server-side operation used by this module.

/**
 * Read + grade a submitted assessment. Deliberately runs with NO transaction
 * open: essay grading calls the AI provider over the network, and holding a SQL
 * transaction across that call risks transaction timeouts and lock contention
 * on the remote database. submitAssessment() persists the result afterwards.
 *
 * Returns everything the caller needs to write the result row.
 */
async function gradeSubmittedAssessment(assessmentId, studentId, payload) {
  {
    const assessmentRows = await query(
      'SELECT TOP 1 * FROM assessments WHERE id = ? AND assigned_student_id = ? AND is_published = 1',
      [assessmentId, studentId]
    );
    const assessment = assessmentRows[0] || null;
    if (!assessment) throw new Error('Assessment not found or not available.');

    const questionRows = await query('SELECT * FROM assessment_questions WHERE assessment_id = ? ORDER BY id ASC', [assessmentId]);
    if (!questionRows.length) throw new Error('Assessment has no questions yet.');

    const submittedMap = extractSubmittedAssessmentAnswers(payload, questionRows);

    const normalizeLetter = (value) => String(value || '').trim().toUpperCase().replace(/[^A-D]/g, '');
    const normalizeText = (value) => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
    const letterFromValue = (value, question) => {
      const raw = String(value || '').trim();
      if (!raw) return '';
      if (/^[A-D]$/i.test(raw)) return raw.toUpperCase();

      const lowered = raw.toLowerCase();
      if (/^choice[_\s-]*[a-d]$/.test(lowered)) return lowered.slice(-1).toUpperCase();
      if (/^[1-4]$/.test(raw)) return ['A', 'B', 'C', 'D'][Number(raw) - 1] || '';

      const answerText = normalizeText(raw);
      for (const letter of ['A', 'B', 'C', 'D']) {
        const choiceText = normalizeText(question[`choice_${letter.toLowerCase()}`]);
        if (choiceText && answerText === choiceText) return letter;
      }

      const directLetter = normalizeLetter(raw);
      return /^[A-D]$/.test(directLetter) ? directLetter : '';
    };

    let score = 0;
    const normalizedAnswers = {};
    const essayQuestions = []; // collect for AI grading
    const perModuleScores = {};

    for (const question of questionRows) {
      const qid = String(question.id);
      const submittedRaw = submittedMap[qid] ?? submittedMap[question.id] ?? '';
      const questionType = String(question.question_type || 'Multiple Choice').trim().toLowerCase();
      const modTitle = question.source_module_title || 'General';

      if (!perModuleScores[modTitle]) {
        perModuleScores[modTitle] = { score: 0, total_points: 0 };
      }
      perModuleScores[modTitle].total_points += Number(question.points || 1);

      let normalizedAnswer = '';
      let isCorrect = false;
      if (questionType === 'multiple choice') {
        const selectedLetter = letterFromValue(submittedRaw, question);
        const correctLetter = letterFromValue(question.correct_answer, question) || normalizeLetter(question.correct_answer);
        normalizedAnswer = selectedLetter;
        isCorrect = !!(selectedLetter && correctLetter && selectedLetter === correctLetter);
      } else if (questionType === 'true or false') {
        normalizedAnswer = String(submittedRaw || '').trim().toLowerCase();
        isCorrect = normalizedAnswer && normalizedAnswer === String(question.correct_answer || '').trim().toLowerCase();
      } else if (questionType === 'fill in the blank') {
        // Case-insensitive exact match
        normalizedAnswer = String(submittedRaw || '').trim();
        const correctText = String(question.correct_answer || '').trim();
        isCorrect = !!(normalizedAnswer && correctText && normalizedAnswer.toLowerCase() === correctText.toLowerCase());
      } else if (questionType === 'essay') {
        // Essay: save answer, defer to AI grading after loop
        normalizedAnswer = String(submittedRaw || '').trim();
        essayQuestions.push({ qid, question, answer: normalizedAnswer, modTitle });
        // Don't score yet — will be scored below
      } else {
        normalizedAnswer = normalizeText(submittedRaw);
        isCorrect = normalizedAnswer && normalizedAnswer === normalizeText(question.correct_answer || '');
      }
      normalizedAnswers[qid] = normalizedAnswer;
      if (isCorrect) {
        score += Number(question.points || 1);
        perModuleScores[modTitle].score += Number(question.points || 1);
      }
    }

    // AI grading for essay questions
    if (essayQuestions.length) {
      try {
        const { gradeEssayAnswers } = require('../services/aiService');
        const essayResults = await gradeEssayAnswers(essayQuestions.map(eq => ({
          questionText: eq.question.question_text,
          studentAnswer: eq.answer,
          expectedAnswer: eq.question.essay_rubric_keywords || eq.question.correct_answer || ''
        })));
        for (let i = 0; i < essayQuestions.length; i++) {
          if (essayResults[i] && essayResults[i].isCorrect) {
            score += Number(essayQuestions[i].question.points || 1);
            perModuleScores[essayQuestions[i].modTitle].score += Number(essayQuestions[i].question.points || 1);
          }
        }
      } catch (essayErr) {
        console.error('[Essay Grading] AI grading failed, falling back to text match:', essayErr.message);
        // Fallback: case-insensitive partial match
        for (const eq of essayQuestions) {
          const studentLower = (eq.answer || '').toLowerCase().trim();
          const expectedLower = (eq.question.correct_answer || '').toLowerCase().trim();
          if (studentLower && expectedLower && studentLower.includes(expectedLower)) {
            score += Number(eq.question.points || 1);
            perModuleScores[eq.modTitle].score += Number(eq.question.points || 1);
          }
        }
      }
    }

    const answeredCount = Object.values(normalizedAnswers).filter(Boolean).length;
    const isAutoSave = payload.auto_submitted === '1' || payload.auto_submitted === 1 || payload.isAutoSave === true;
    // Allow partial/empty answers for auto-save; for manual submit require at least 1 answer
    if (!answeredCount && !isAutoSave) throw new Error('No answers were received by the server. Please answer the questions and submit again.');

    const totalPoints = questionRows.reduce((sum, question) => sum + Number(question.points || 1), 0);
    const percentage = totalPoints ? (score / totalPoints) * 100 : 0;
    const level = scoreToLevel(percentage);

    return {
      score,
      totalQuestions: questionRows.length,
      percentage,
      level,
      answeredCount,
      answersPayload: JSON.stringify(normalizedAnswers),
      perModulePayload: JSON.stringify(perModuleScores)
    };
  }
}

// Function: submitAssessment

// Role: Handles a reusable server-side operation used by this module.

async function submitAssessment(assessmentId, studentId, payload) {
  // Grade first — the AI essay call happens here, with no transaction open.
  const graded = await gradeSubmittedAssessment(assessmentId, studentId, payload);

  // Then persist in a short-lived transaction that holds no network work.
  return withTransaction(async (connection) => {
    const [existingRows] = await connection.query(
      'SELECT TOP 1 id FROM assessment_results WHERE assessment_id = ? AND student_id = ?',
      [assessmentId, studentId]
    );
    const existing = existingRows[0] || null;
    const roundedPercentage = Number(graded.percentage.toFixed(2));

    if (existing) {
      await connection.query(
        `UPDATE assessment_results
         SET score = ?, total_questions = ?, percentage = ?, level = ?, answers_json = ?, taken_at = DATEADD(hour, 8, GETUTCDATE()), per_module_scores_json = ?
         WHERE assessment_id = ? AND student_id = ?`,
        [graded.score, graded.totalQuestions, roundedPercentage, graded.level, graded.answersPayload, graded.perModulePayload, assessmentId, studentId]
      );
    } else {
      await connection.query(
        `INSERT INTO assessment_results (assessment_id, student_id, score, total_questions, percentage, level, answers_json, taken_at, per_module_scores_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, DATEADD(hour, 8, GETUTCDATE()), ?)`,
        [assessmentId, studentId, graded.score, graded.totalQuestions, roundedPercentage, graded.level, graded.answersPayload, graded.perModulePayload]
      );
    }

    return {
      score: graded.score,
      total_questions: graded.totalQuestions,
      percentage: graded.percentage,
      level: graded.level,
      answered_count: graded.answeredCount
    };
  });
}


// Function: getTutorAvailabilityForSubject


// Role: Handles a reusable server-side operation used by this module.


async function getTutorAvailabilityForSubject(studentId, subjectId) {
  const student = await getUserById(studentId);
  const subject = await getSubjectById(subjectId);
  if (!student || !subject) return [];

  const tutors = await getSubjectMembers(subjectId, student.branch_id).then((data) => data.tutors || []);
  const activeRows = await query(
    `SELECT tsa.*, u.first_name, u.middle_name, u.last_name
     FROM tutor_schedule_applications tsa
     INNER JOIN users u ON u.id = tsa.tutor_id
     WHERE tsa.subject_id = ? AND tsa.branch_id = ? AND tsa.status IN ('pending','accepted')`,
    [subjectId, student.branch_id || null]
  );

  return tutors.map((tutor) => {
    const tutorRows = activeRows.filter((row) => Number(row.tutor_id) === Number(tutor.id));
    const taken = new Set(tutorRows.filter((row) => String(row.status).toLowerCase() === 'accepted').map((row) => row.time_slot));
    const pendingBySlot = new Set(tutorRows.filter((row) => String(row.status).toLowerCase() === 'pending').map((row) => row.time_slot));
    const unavailableSlots = FIXED_TIME_SLOTS.filter((slot) => taken.has(slot) || pendingBySlot.has(slot));
    return {
      ...tutor,
      available_slots: FIXED_TIME_SLOTS.filter((slot) => !taken.has(slot) && !pendingBySlot.has(slot)),
      unavailable_slots: unavailableSlots
    };
  });
}

// Function: getTutorAvailabilityForStudent

// Role: Handles a reusable server-side operation used by this module.

/**
 * The time slots a tutor cannot offer a given student: the ones the tutor
 * already teaches someone else in (the enrolments, where admin assignments
 * live), the ones held by an open request, and the ones the STUDENT already
 * spends with a different tutor — a learner cannot attend two sessions at once.
 */
async function getBlockedSlotsForTutor(tutorId, studentId, connection = null) {
  const run = connection
    ? async (sql, params) => (await connection.query(sql, params))[0]
    : async (sql, params) => query(sql, params);
  const [tutorSlots, requests, ownSlots] = await Promise.all([
    run(
      `SELECT DISTINCT time_slot FROM user_subject_assignments
        WHERE tutor_id = ? AND is_archived = 0 AND time_slot IS NOT NULL AND student_id <> ?`,
      [tutorId, studentId]
    ),
    run(
      `SELECT DISTINCT time_slot FROM tutor_schedule_applications
        WHERE tutor_id = ? AND status IN ('pending','accepted') AND student_id <> ?`,
      [tutorId, studentId]
    ),
    run(
      `SELECT DISTINCT time_slot FROM user_subject_assignments
        WHERE student_id = ? AND is_archived = 0 AND time_slot IS NOT NULL
          AND tutor_id IS NOT NULL AND tutor_id <> ?`,
      [studentId, tutorId]
    )
  ]);
  return new Set([...tutorSlots, ...requests, ...ownSlots].map((row) => row.time_slot).filter(Boolean));
}

/**
 * The tutors a student may pick, for the subjects that still have no tutor.
 *
 * A tutor teaches only the subjects they teach. So each tutor is offered with
 * the student's open subjects THEY teach (`teachable_subjects`); a tutor who
 * teaches none of them is not offered at all. Once a tutor is accepted, any
 * subject they do not teach stays open, and the student picks another tutor
 * for that subject only.
 *
 * Same branch as the student, and a year level that matches theirs — the same
 * scope rule that would otherwise unassign the tutor on the next profile save.
 */
async function getTutorAvailabilityForStudent(studentId) {
  const student = await getUserById(studentId);
  if (!student) return [];

  const assignments = await getStudentAssignments(studentId);
  const openSubjects = assignments.filter((a) => !a.tutor_internal_id);
  if (!openSubjects.length) return [];

  const tutors = await getUsers({ role: 'tutor', scopeBranchId: student.branch_id || null });
  const offers = [];
  for (const tutor of tutors) {
    const teachable = openSubjects.filter((a) => tutorTeachesSubject(tutor, a.subject_name));
    if (!teachable.length) continue;
    if (!matchesTutorStudentScope(tutor, student).isMatch) continue;
    const blocked = await getBlockedSlotsForTutor(tutor.id, studentId);
    offers.push({
      ...tutor,
      teachable_subjects: teachable.map((a) => a.subject_name),
      teachable_subject_ids: teachable.map((a) => Number(a.subject_id)),
      available_slots: FIXED_TIME_SLOTS.filter((slot) => !blocked.has(slot)),
      unavailable_slots: FIXED_TIME_SLOTS.filter((slot) => blocked.has(slot))
    });
  }
  return offers;
}

/** "MATH, SCIENCE and ENGLISH" — subject names in a sentence. */
function listSubjectNames(names = []) {
  const list = [...new Set(names.filter(Boolean))];
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

// Function: createTutorScheduleApplication

// Role: Handles a reusable server-side operation used by this module.

async function createTutorScheduleApplication(studentId, subjectId, tutorId, timeSlot) {
  // One subject: the same request as the all-subjects one, narrowed to it.
  return createTutorScheduleApplicationForAllSubjects(studentId, tutorId, timeSlot, { subjectIds: [Number(subjectId)] });
}

// Function: getTutorScheduleNotifications

// Role: Handles a reusable server-side operation used by this module.

async function getTutorScheduleNotifications(tutorId) {
  const rows = await query(
    `SELECT tsa.*, st.first_name AS student_first_name, st.middle_name AS student_middle_name, st.last_name AS student_last_name,
            s.name AS subject_name
     FROM tutor_schedule_applications tsa
     INNER JOIN users st ON st.id = tsa.student_id
     INNER JOIN subjects s ON s.id = tsa.subject_id
     WHERE tsa.tutor_id = ? AND tsa.status = 'pending'
     ORDER BY tsa.created_at DESC`,
    [tutorId]
  );
  return rows.map((row) => ({
    ...row,
    notification_type: 'schedule_request',
    full_name: fullName({ first_name: row.student_first_name, middle_name: row.student_middle_name, last_name: row.student_last_name })
  }));
}

// Function: getStudentScheduleNotifications

// Role: Handles a reusable server-side operation used by this module.

async function getStudentScheduleNotifications(studentId) {
  const rows = await query(
    `SELECT tsa.*, tu.first_name AS tutor_first_name, tu.middle_name AS tutor_middle_name, tu.last_name AS tutor_last_name,
            s.name AS subject_name
     FROM tutor_schedule_applications tsa
     INNER JOIN users tu ON tu.id = tsa.tutor_id
     INNER JOIN subjects s ON s.id = tsa.subject_id
     WHERE tsa.student_id = ? AND tsa.status IN ('accepted','cancelled') AND ISNULL(tsa.student_notified, 0) = 0
     ORDER BY tsa.updated_at DESC`,
    [studentId]
  );
  return rows.map((row) => ({
    ...row,
    notification_type: 'student_schedule_status',
    tutor_name: fullName({ first_name: row.tutor_first_name, middle_name: row.tutor_middle_name, last_name: row.tutor_last_name })
  }));
}

// Function: acceptTutorScheduleApplication

// Role: Handles a reusable server-side operation used by this module.

async function acceptTutorScheduleApplication(applicationId, tutorId) {
  return withTransaction(async (connection) => {
    const [rows] = await connection.query(
      `SELECT TOP 1 * FROM tutor_schedule_applications WHERE id = ?`,
      [applicationId]
    );
    const app = rows[0];
    if (!app) throw new Error('Application not found.');
    if (Number(app.tutor_id) !== Number(tutorId)) throw new Error('You can only manage your own schedule requests.');
    if (String(app.status).toLowerCase() !== 'pending') throw new Error('This application was already processed.');

    // The slot must still be free in the tutor's real diary — the enrolments,
    // where an admin's assignment lives — not only among other requests.
    const [takenRows] = await connection.query(
      `SELECT TOP 1 id FROM tutor_schedule_applications WHERE tutor_id = ? AND time_slot = ? AND status = 'accepted' AND id <> ?`,
      [app.tutor_id, app.time_slot, app.id]
    );
    const [teachingRows] = await connection.query(
      `SELECT TOP 1 id FROM user_subject_assignments
        WHERE tutor_id = ? AND time_slot = ? AND is_archived = 0 AND student_id <> ?`,
      [app.tutor_id, app.time_slot, app.student_id]
    );
    if (takenRows.length || teachingRows.length) throw new Error('This schedule was already taken.');

    // Only the student's subjects that have no tutor yet AND that this tutor
    // teaches. Writing the tutor to every subject made a Math tutor the
    // "English tutor" too; the rest stay open for the student to fill.
    const tutor = await getUserById(app.tutor_id);
    const [openRows] = await connection.query(
      `SELECT usa.id, s.name AS subject_name
         FROM user_subject_assignments usa
         INNER JOIN subjects s ON s.id = usa.subject_id
        WHERE usa.student_id = ? AND usa.is_archived = 0 AND usa.tutor_id IS NULL`,
      [app.student_id]
    );
    const teachable = openRows.filter((row) => tutorTeachesSubject(tutor, row.subject_name));
    if (!teachable.length) {
      throw new Error('This student has no subject left that you teach without a tutor, so there is nothing to accept.');
    }

    await connection.query(
      `UPDATE tutor_schedule_applications
       SET status = 'cancelled', updated_at = DATEADD(hour, 8, GETUTCDATE()), decided_at = DATEADD(hour, 8, GETUTCDATE()), decided_by = ?, student_notified = 0
       WHERE student_id = ? AND status = 'pending' AND id <> ?`,
      [tutorId, app.student_id, app.id]
    );

    await connection.query(
      `UPDATE tutor_schedule_applications
       SET status = 'accepted', updated_at = DATEADD(hour, 8, GETUTCDATE()), decided_at = DATEADD(hour, 8, GETUTCDATE()), decided_by = ?, student_notified = 0
       WHERE id = ?`,
      [tutorId, app.id]
    );

    const ids = teachable.map((row) => Number(row.id));
    await connection.query(
      `UPDATE user_subject_assignments
       SET tutor_id = ?, time_slot = ?, assigned_at = DATEADD(hour, 8, GETUTCDATE()), accepted_by = ?, updated_at = DATEADD(hour, 8, GETUTCDATE())
       WHERE id IN (${ids.map(() => '?').join(', ')})`,
      [app.tutor_id, app.time_slot, tutorId, ...ids]
    );
    return { subjects: teachable.map((row) => row.subject_name) };
  });
}

/**
 * Does this student already have a tutor? Read from the ASSIGNMENTS, which are
 * the authoritative record, rather than from tutor_schedule_applications.
 *
 * The distinction matters as soon as an admin can set a tutor directly (Phase
 * 5): an admin-assigned student has no accepted application row, so a guard
 * that only looked at applications would happily let them apply for a different
 * tutor and schedule themselves — exactly what the rule forbids.
 */
async function getAssignedTutorFor(studentId, connection = null) {
  const run = connection
    ? async (sql, params) => (await connection.query(sql, params))[0]
    : async (sql, params) => query(sql, params);
  const rows = await run(
    `SELECT TOP 1 usa.tutor_id, usa.time_slot, u.first_name, u.middle_name, u.last_name, u.image_path
       FROM user_subject_assignments usa
       INNER JOIN users u ON u.id = usa.tutor_id
      WHERE usa.student_id = ? AND usa.is_archived = 0 AND usa.tutor_id IS NOT NULL`,
    [studentId]
  );
  if (!rows.length) return null;
  return {
    tutor_id: rows[0].tutor_id,
    time_slot: rows[0].time_slot,
    tutor_image_path: rows[0].image_path || null,
    tutor_name: fullName({
      first_name: rows[0].first_name, middle_name: rows[0].middle_name, last_name: rows[0].last_name
    })
  };
}

/**
 * Admin sets a student's tutor and schedule.
 *
 * A TUTOR TEACHES ONLY THE SUBJECTS THEY TEACH
 * The tutor is written to the student's subjects that the tutor actually
 * teaches. It used to be written to EVERY subject the student held, so a Math
 * tutor became the English tutor as well. A subject the tutor does not teach is
 * left as it was, and is reported back so the admin can give it its own tutor.
 *
 * `subjectIds` narrows it to particular subjects — the per-subject rows on the
 * profile. Asking for a subject the tutor does not teach is refused outright,
 * because there the admin named it.
 *
 * WHY THE SCHEDULE IS ADMIN-ONLY
 * The time slot moves with the tutor — a new tutor has a different diary — so
 * the two are set together, here, by staff. A student may only pick a tutor
 * for a subject that has none yet.
 *
 * @param {number} studentId
 * @param {object} input   { tutorId, timeSlot, subjectIds? }  tutorId empty clears
 * @param {object} actor   the admin doing it
 * @returns {Promise<{tutorId, tutorName, timeSlot, subjectsUpdated, subjectNames, skippedSubjects}>}
 */
async function setStudentTutorAndSchedule(studentId, input = {}, actor = null) {
  const tutorId = input.tutorId === '' || input.tutorId == null ? null : Number(input.tutorId);
  const timeSlot = String(input.timeSlot || '').trim();
  const requested = [...new Set((Array.isArray(input.subjectIds) ? input.subjectIds : [input.subjectIds])
    .map((value) => Number(value)).filter(Boolean))];

  return withTransaction(async (connection) => {
    const student = await getUserById(studentId);
    if (!student || student.role !== 'student') throw new Error('Student not found.');

    const [activeRows] = await connection.query(
      `SELECT usa.id, usa.subject_id, usa.tutor_id, usa.time_slot, s.name AS subject_name
         FROM user_subject_assignments usa
         INNER JOIN subjects s ON s.id = usa.subject_id
        WHERE usa.student_id = ? AND usa.is_archived = 0`,
      [studentId]
    );
    if (!activeRows.length) {
      throw new Error('This student has no active subjects, so there is nothing to assign a tutor to.');
    }

    const targets = requested.length
      ? activeRows.filter((row) => requested.includes(Number(row.subject_id)))
      : activeRows;
    if (!targets.length) throw new Error('That subject is not one this student is enrolled in.');
    const idList = (rows) => rows.map((row) => Number(row.id));
    const inList = (rows) => rows.map(() => '?').join(', ');

    // Clearing the tutor: drop the schedule with it, or the student keeps a slot
    // in a diary nobody is holding.
    if (!tutorId) {
      await connection.query(
        `UPDATE user_subject_assignments
            SET tutor_id = NULL, time_slot = NULL, assigned_at = NULL, accepted_by = ?,
                updated_at = DATEADD(hour, 8, GETUTCDATE())
          WHERE id IN (${inList(targets)})`,
        [actor?.id || null, ...idList(targets)]
      );
      // Requests the student has open to a tutor who no longer teaches them
      // anything are closed with it.
      await connection.query(
        `UPDATE tutor_schedule_applications
            SET status = 'cancelled', decided_by = ?, decided_at = DATEADD(hour, 8, GETUTCDATE()),
                updated_at = DATEADD(hour, 8, GETUTCDATE()), student_notified = 0
          WHERE student_id = ? AND status IN ('pending','accepted')
            AND tutor_id NOT IN (SELECT tutor_id FROM user_subject_assignments
                                  WHERE student_id = ? AND is_archived = 0 AND tutor_id IS NOT NULL)`,
        [actor?.id || null, studentId, studentId]
      );
      return {
        tutorId: null,
        timeSlot: null,
        subjectsUpdated: targets.length,
        subjectNames: targets.map((row) => row.subject_name),
        skippedSubjects: []
      };
    }

    const tutor = await getUserById(tutorId);
    if (!tutor || tutor.role !== 'tutor') throw new Error('Tutor not found.');

    // A tutor may serve several branches (extra.branch_ids), so check the whole
    // set rather than only their home branch.
    const tutorBranches = new Set(
      [tutor.branch_id, ...safeJsonArray(tutor.extra?.branch_ids || [])]
        .map((id) => Number(id)).filter(Boolean)
    );
    if (student.branch_id && tutorBranches.size && !tutorBranches.has(Number(student.branch_id))) {
      throw new Error('That tutor does not teach at this student\'s branch.');
    }

    if (timeSlot && !FIXED_TIME_SLOTS.includes(timeSlot)) {
      throw new Error('Choose one of the centre\'s time slots.');
    }

    const teachable = targets.filter((row) => tutorTeachesSubject(tutor, row.subject_name));
    const skipped = targets.filter((row) => !tutorTeachesSubject(tutor, row.subject_name));
    if (!teachable.length) {
      throw new Error(
        `${fullName(tutor)} does not teach ${listSubjectNames(targets.map((row) => row.subject_name))}. `
        + `Choose a tutor who teaches ${targets.length === 1 ? 'it' : 'them'}.`
      );
    }
    if (requested.length && skipped.length) {
      throw new Error(
        `${fullName(tutor)} does not teach ${listSubjectNames(skipped.map((row) => row.subject_name))}. `
        + `Choose another tutor for ${skipped.length === 1 ? 'that subject' : 'those subjects'}.`
      );
    }

    if (timeSlot) {
      // One tutor cannot hold the same slot for two different students.
      const [clashRows] = await connection.query(
        `SELECT TOP 1 usa.student_id, u.first_name, u.last_name
           FROM user_subject_assignments usa
           INNER JOIN users u ON u.id = usa.student_id
          WHERE usa.tutor_id = ? AND usa.time_slot = ? AND usa.is_archived = 0
            AND usa.student_id <> ?`,
        [tutorId, timeSlot, studentId]
      );
      if (clashRows.length) {
        throw new Error(
          `${fullName(tutor)} already teaches ${clashRows[0].first_name} ${clashRows[0].last_name || ''} at ${timeSlot}. `
          + 'Pick another slot.'
        );
      }

      // Nor can one student be with two tutors at once.
      const teachableIds = new Set(idList(teachable));
      const ownClash = activeRows.find((row) => !teachableIds.has(Number(row.id))
        && row.tutor_id && Number(row.tutor_id) !== tutorId && row.time_slot === timeSlot);
      if (ownClash) {
        throw new Error(
          `This student already has ${ownClash.subject_name} with another tutor at ${timeSlot}. Pick another slot.`
        );
      }
    }

    await connection.query(
      `UPDATE user_subject_assignments
          SET tutor_id = ?, time_slot = ?, assigned_at = DATEADD(hour, 8, GETUTCDATE()),
              accepted_by = ?, updated_at = DATEADD(hour, 8, GETUTCDATE())
        WHERE id IN (${inList(teachable)})`,
      [tutorId, timeSlot || null, actor?.id || null, ...idList(teachable)]
    );

    // The admin's decision supersedes anything the student had in flight.
    await connection.query(
      `UPDATE tutor_schedule_applications
          SET status = 'cancelled', decided_by = ?, decided_at = DATEADD(hour, 8, GETUTCDATE()),
              updated_at = DATEADD(hour, 8, GETUTCDATE()), student_notified = 0
        WHERE student_id = ? AND status = 'pending'`,
      [actor?.id || null, studentId]
    );

    return {
      tutorId,
      tutorName: fullName(tutor),
      timeSlot: timeSlot || null,
      subjectsUpdated: teachable.length,
      subjectNames: teachable.map((row) => row.subject_name),
      skippedSubjects: skipped.map((row) => row.subject_name)
    };
  });
}

// Function: createTutorScheduleApplicationForAllSubjects

// Role: Handles a reusable server-side operation used by this module.

/**
 * A student asks a tutor to teach them, at a time slot.
 *
 * Only for subjects that have NO tutor yet — a subject that has one is the
 * office's to change (TUTOR_LOCKED_MESSAGE) — and only the ones this tutor
 * teaches. When the tutor accepts, those subjects are theirs; any subject the
 * tutor does not teach stays open, and the student asks another tutor for it.
 *
 * @param {object} [options]  { subjectIds } narrows the request to particular subjects
 * @returns {Promise<{subjects: string[]}>}  the subjects the request covers
 */
async function createTutorScheduleApplicationForAllSubjects(studentId, tutorId, timeSlot, options = {}) {
  const only = [...new Set((options.subjectIds || []).map((value) => Number(value)).filter(Boolean))];
  return withTransaction(async (connection) => {
    const [activeRows] = await connection.query(
      `SELECT usa.id, usa.subject_id, usa.tutor_id, usa.time_slot, s.name AS subject_name
         FROM user_subject_assignments usa
         INNER JOIN subjects s ON s.id = usa.subject_id
        WHERE usa.student_id = ? AND usa.is_archived = 0`,
      [studentId]
    );
    if (!activeRows.length) throw new Error('You have no enrolled subjects.');

    const scoped = only.length ? activeRows.filter((row) => only.includes(Number(row.subject_id))) : activeRows;
    if (!scoped.length) throw new Error('You are not enrolled in this subject.');

    // The lock is checked FIRST, before anything about the tutor or slot they
    // picked: a student whose subjects all have a tutor needs to be told that
    // only an admin can change it, not a detail of a choice they could not make.
    const open = scoped.filter((row) => !row.tutor_id);
    if (!open.length) throw new Error(TUTOR_LOCKED_MESSAGE);

    const student = await getUserById(studentId);
    const tutor = await getUserById(tutorId);
    if (!student || !tutor || tutor.role !== 'tutor') throw new Error('Tutor not found.');
    if (String(student.branch_id || '') !== String(tutor.branch_id || '')) throw new Error('You can only apply to tutors in your branch.');
    if (!FIXED_TIME_SLOTS.includes(timeSlot)) throw new Error('Invalid time slot selected.');

    const teachable = open.filter((row) => tutorTeachesSubject(tutor, row.subject_name));
    if (!teachable.length) {
      throw new Error(
        `${fullName(tutor)} does not teach ${listSubjectNames(open.map((row) => row.subject_name))}. `
        + `Choose a tutor who teaches ${open.length === 1 ? 'it' : 'them'}.`
      );
    }

    const blocked = await getBlockedSlotsForTutor(tutorId, studentId, connection);
    if (blocked.has(timeSlot)) throw new Error('That time slot is no longer available.');

    const [existingPendingRows] = await connection.query(
      `SELECT TOP 1 id FROM tutor_schedule_applications WHERE student_id = ? AND status = 'pending'`,
      [studentId]
    );
    if (existingPendingRows.length) throw new Error('You already have a pending tutor application.');

    // The first subject it covers names the request; acceptance assigns every
    // open subject this tutor teaches.
    await connection.query(
      `INSERT INTO tutor_schedule_applications (student_id, tutor_id, subject_id, branch_id, time_slot, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', DATEADD(hour, 8, GETUTCDATE()), DATEADD(hour, 8, GETUTCDATE()))`,
      [studentId, tutorId, teachable[0].subject_id, student.branch_id || tutor.branch_id || null, timeSlot]
    );
    return { subjects: teachable.map((row) => row.subject_name) };
  });
}

// Function: cancelTutorScheduleApplication

// Role: Handles a reusable server-side operation used by this module.

async function cancelTutorScheduleApplication(applicationId, tutorId) {
  return withTransaction(async (connection) => {
    const [rows] = await connection.query(`SELECT TOP 1 * FROM tutor_schedule_applications WHERE id = ?`, [applicationId]);
    const app = rows[0];
    if (!app) throw new Error('Application not found.');
    if (Number(app.tutor_id) !== Number(tutorId)) throw new Error('You can only manage your own schedule requests.');
    if (!['pending','accepted'].includes(String(app.status).toLowerCase())) throw new Error('This application is already cancelled.');

    await connection.query(
      `UPDATE tutor_schedule_applications
       SET status = 'cancelled', updated_at = DATEADD(hour, 8, GETUTCDATE()), decided_at = DATEADD(hour, 8, GETUTCDATE()), decided_by = ?, student_notified = 0
       WHERE student_id = ? AND tutor_id = ? AND time_slot = ? AND status IN ('pending','accepted')`,
      [tutorId, app.student_id, app.tutor_id, app.time_slot]
    );
    await connection.query(
      `UPDATE user_subject_assignments
       SET tutor_id = CASE WHEN tutor_id = ? THEN NULL ELSE tutor_id END,
           time_slot = CASE WHEN tutor_id = ? THEN NULL ELSE time_slot END,
           updated_at = DATEADD(hour, 8, GETUTCDATE())
       WHERE student_id = ? AND is_archived = 0`,
      [app.tutor_id, app.tutor_id, app.student_id]
    );
    return true;
  });
}

// Function: markStudentScheduleNotificationRead

// Role: Handles a reusable server-side operation used by this module.

async function markStudentScheduleNotificationRead(applicationId, studentId) {
  await query(
    `UPDATE tutor_schedule_applications SET student_notified = 1, updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ? AND student_id = ?`,
    [applicationId, studentId]
  );
}

// Function: finishTutorScheduleApplication

// Role: Handles a reusable server-side operation used by this module.

async function finishTutorScheduleApplication(applicationId, tutorId) {
  return withTransaction(async (connection) => {
    const [rows] = await connection.query(
      `SELECT TOP 1 * FROM tutor_schedule_applications WHERE id = ?`,
      [applicationId]
    );
    const app = rows[0];
    if (!app) throw new Error('Application not found.');
    if (Number(app.tutor_id) !== Number(tutorId)) throw new Error('You can only manage your own schedule requests.');
    const currentStatus = String(app.status).toLowerCase();
    if (!['accepted', 'ongoing'].includes(currentStatus)) throw new Error('Only accepted or ongoing sessions can be finished.');

    await connection.query(
      `UPDATE tutor_schedule_applications
       SET status = 'finished', updated_at = DATEADD(hour, 8, GETUTCDATE()), decided_at = DATEADD(hour, 8, GETUTCDATE()), decided_by = ?, student_notified = 0
       WHERE id = ?`,
      [tutorId, app.id]
    );

    // Free up the time slot in user_subject_assignments
    await connection.query(
      `UPDATE user_subject_assignments
       SET tutor_id = CASE WHEN tutor_id = ? THEN NULL ELSE tutor_id END,
           time_slot = CASE WHEN tutor_id = ? THEN NULL ELSE time_slot END,
           updated_at = DATEADD(hour, 8, GETUTCDATE())
       WHERE student_id = ? AND is_archived = 0`,
      [app.tutor_id, app.tutor_id, app.student_id]
    );
    return true;
  });
}

// Function: getTutorScheduleOverview

// Role: Handles a reusable server-side operation used by this module.

/**
 * A tutor's day: every one of the centre's time slots, and who holds it.
 *
 * Read from the ENROLMENTS (user_subject_assignments.tutor_id + time_slot),
 * which are the record of who is taught when. This used to read only accepted
 * tutor_schedule_applications — but an admin assigning a tutor and schedule
 * (Phase 5) writes the enrolments and creates no application, so nearly every
 * slot a tutor actually teaches showed as "Available" here.
 *
 * A pending request from a student is shown too, so the tutor can see a slot
 * is spoken for before they accept it.
 */
async function getTutorScheduleOverview(tutorId) {
  const [taken, applications] = await Promise.all([
    query(
      `SELECT usa.time_slot, usa.student_id, s.name AS subject_name,
              st.first_name, st.middle_name, st.last_name
         FROM user_subject_assignments usa
         INNER JOIN users st ON st.id = usa.student_id
         INNER JOIN subjects s ON s.id = usa.subject_id
        WHERE usa.tutor_id = ? AND usa.is_archived = 0 AND st.is_archived = 0
          AND usa.time_slot IS NOT NULL AND LTRIM(RTRIM(usa.time_slot)) <> ''
        ORDER BY s.name ASC`,
      [tutorId]
    ),
    query(
      `SELECT tsa.id, tsa.student_id, tsa.time_slot, tsa.status,
              st.first_name, st.middle_name, st.last_name, s.name AS subject_name
         FROM tutor_schedule_applications tsa
         LEFT JOIN users st ON st.id = tsa.student_id
         LEFT JOIN subjects s ON s.id = tsa.subject_id
        WHERE tsa.tutor_id = ? AND tsa.status IN ('pending', 'accepted', 'ongoing')
        ORDER BY tsa.updated_at DESC`,
      [tutorId]
    )
  ]);

  // Slots outside the centre's fixed list are still the tutor's — listed after.
  const slotOrder = [...FIXED_TIME_SLOTS];
  for (const row of taken) {
    if (!slotOrder.includes(row.time_slot)) slotOrder.push(row.time_slot);
  }

  return slotOrder.map((slot) => {
    const holders = taken.filter((row) => row.time_slot === slot);
    if (holders.length) {
      const students = [];
      for (const row of holders) {
        if (!students.some((s) => Number(s.id) === Number(row.student_id))) {
          students.push({ id: Number(row.student_id), name: fullName(row), subjects: [] });
        }
        const entry = students.find((s) => Number(s.id) === Number(row.student_id));
        if (!entry.subjects.includes(row.subject_name)) entry.subjects.push(row.subject_name);
      }
      // The student's own accepted request, if the slot came from one — that is
      // what "Finish" closes.
      const application = applications.find((app) => app.time_slot === slot
        && ['accepted', 'ongoing'].includes(String(app.status).toLowerCase())
        && students.some((s) => s.id === Number(app.student_id)));
      const names = students.map((s) => s.name).join(', ');
      return {
        time_slot: slot,
        status: `Taken by ${names}`,
        raw_status: application ? String(application.status).toLowerCase() : 'taken',
        application_id: application ? application.id : null,
        student_id: students[0].id,
        student_name: names,
        subject_name: [...new Set(students.flatMap((s) => s.subjects))].join(', ')
      };
    }

    const pending = applications.find((app) => app.time_slot === slot && String(app.status).toLowerCase() === 'pending');
    if (pending) {
      return {
        time_slot: slot,
        status: `Requested by ${fullName(pending)}`,
        raw_status: 'pending',
        application_id: pending.id,
        student_id: Number(pending.student_id),
        student_name: fullName(pending),
        subject_name: pending.subject_name || ''
      };
    }

    return {
      time_slot: slot,
      status: 'Available',
      raw_status: 'available',
      application_id: null,
      student_id: null,
      student_name: '',
      subject_name: ''
    };
  });
}

// ============================================================================
// AI SYSTEM — Phase 2: New data layer functions
// ============================================================================

// Function: archiveSubjectResource
// Role: Soft-delete a module (admin can archive from subject detail)
async function archiveSubjectResource(resourceId) {
  await query(
    `UPDATE subject_resources SET is_archived = 1, archived_at = DATEADD(hour, 8, GETUTCDATE()), updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?`,
    [resourceId]
  );
}

// Function: recoverSubjectResource
// Role: Recover an archived module
async function recoverSubjectResource(resourceId) {
  await query(
    `UPDATE subject_resources SET is_archived = 0, recovered_at = DATEADD(hour, 8, GETUTCDATE()), updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?`,
    [resourceId]
  );
}

// Function: getAdminSubjectResourcesWithArchived
// Role: Returns all admin modules including archived ones (for admin manage view)
async function getAdminSubjectResourcesWithArchived(subjectId) {
  const rows = await query(
    `SELECT sr.*, u.first_name, u.middle_name, u.last_name
     FROM subject_resources sr
     INNER JOIN users u ON u.id = sr.tutor_id
     WHERE sr.subject_id = ? AND sr.created_by_role IN ('admin_template','ai_generated')
     ORDER BY ISNULL(sr.is_archived, 0) ASC, sr.created_at DESC`,
    [subjectId]
  );
  return rows.map((row) => ({ ...row, tutor_name: fullName(row) }));
}

// Function: getModulesForStudent
// Role: Returns modules visible to a student based on subject + education level group
async function getModulesForStudent(studentId, subjectId) {
  const student = await getUserById(studentId);
  if (!student) return [];
  const levelGroup = student.education_level_group || student.year_level || '';
  const rows = await query(
    `SELECT sr.*, u.first_name, u.middle_name, u.last_name,
            mr.read_at AS student_read_at
     FROM subject_resources sr
     INNER JOIN users u ON u.id = sr.tutor_id
     LEFT JOIN module_reads mr ON mr.resource_id = sr.id AND mr.student_id = ?
     WHERE sr.subject_id = ? AND ISNULL(sr.is_archived, 0) = 0
       AND (
         (sr.created_by_role = 'tutor_share' AND sr.assigned_student_id = ?)
         OR (sr.created_by_role = 'ai_generated' AND sr.assigned_student_id = ?)
         OR (sr.created_by_role IN ('admin_template') AND (sr.type_of_module IS NULL OR sr.type_of_module = ? OR sr.type_of_module = ''))
       )
     ORDER BY sr.created_at DESC`,
    [studentId, subjectId, studentId, studentId, levelGroup]
  );
  return rows.map((row) => ({ ...row, tutor_name: fullName(row), is_read: !!row.student_read_at }));
}

// Function: markModuleRead
// Role: Records that a student has read/viewed a module
async function getModuleReads(studentId, subjectId) {
  return query(
    `SELECT mr.*, sr.title AS module_title
     FROM module_reads mr
     INNER JOIN subject_resources sr ON sr.id = mr.resource_id
     WHERE mr.student_id = ? AND mr.subject_id = ?
     ORDER BY mr.read_at DESC`,
    [studentId, subjectId]
  );
}

// Function: getStudentAnalytics
// Role: Gathers analytics data for a student on a specific subject
/**
 * One student's record in one subject: modules opened, every assessment they
 * sat (Pre-Assessment, module activities, Post-Assessment) and the ones still
 * waiting, the anti-cheat strikes, and the figures that summarise them.
 *
 * Read from the tables the system WRITES today — student_module_reads,
 * tutor_assessment_submissions, assessment_violations, student_subject_levels.
 * It used to read module_reads, assessments/assessment_results,
 * assessment_attempts, assessment_anti_cheat_logs and student_learning_cycles:
 * the retired first-generation tables nothing has written to since the module
 * overhaul. So My Progress, the admin's and the tutor's student analytics all
 * showed zero modules, zero assessments and a 0% average for every student, no
 * matter what they had done — "progress is not being recorded".
 *
 * The returned shape is unchanged (moduleReads, assessments, attempts,
 * antiCheatLogs, learningCycles, stats), plus `scoreTrend` — one point per
 * submission, oldest first — for the per-subject score chart.
 */
async function getStudentAnalytics(studentId, subjectId) {
  const student = await getUserById(studentId);
  const subject = await getSubjectById(subjectId);
  if (!student || !subject) return null;

  const [readRows, submissionRows, violationRows, levelRow, completion] = await Promise.all([
    query(
      `SELECT smr.module_id, smr.first_opened_at, smr.last_opened_at, m.order_number, m.title
         FROM student_module_reads smr
         INNER JOIN modules m ON m.id = smr.module_id
        WHERE smr.student_id = ? AND smr.subject_id = ?
        ORDER BY smr.first_opened_at DESC`,
      [studentId, subjectId]
    ),
    query(
      `SELECT sub.id AS submission_id, sub.score, sub.total_points, sub.percentage, sub.level,
              sub.submitted_at, sub.violation_count, sub.is_auto_submitted,
              ta.id AS assessment_id, ta.title, ta.assessment_kind, ta.purpose,
              m.order_number AS module_number, m.title AS module_title
         FROM tutor_assessment_submissions sub
         INNER JOIN tutor_assessments ta ON ta.id = sub.assessment_id
         LEFT JOIN modules m ON m.id = ta.module_id
        WHERE sub.student_id = ? AND ta.subject_id = ?
        ORDER BY sub.submitted_at ASC, sub.id ASC`,
      [studentId, subjectId]
    ),
    query(
      `SELECT v.violation_type, v.violation_detail, v.violation_number, v.occurred_at, ta.title
         FROM assessment_violations v
         INNER JOIN tutor_assessments ta ON ta.id = v.assessment_id
        WHERE v.student_id = ? AND ta.subject_id = ?
        ORDER BY v.occurred_at DESC, v.id DESC`,
      [studentId, subjectId]
    ),
    getStudentSubjectLevel(studentId, subjectId),
    getStudentSubjectCompletion(studentId, subjectId).catch(() => null)
  ]);

  const kindOf = (row) => (row.assessment_kind === 'pre_assessment' ? 'pre'
    : row.assessment_kind === 'post_assessment' ? 'post' : 'module');
  const moduleLabel = (row) => (row.module_number ? `Module ${row.module_number} — ${row.module_title}` : '');

  const taken = submissionRows.map((row) => ({
    ...row,
    id: row.assessment_id,
    assessment_type: kindOf(row),
    source_module_title: moduleLabel(row),
    total_questions: row.total_points,
    taken_at: row.submitted_at
  }));

  // Module activities the student can see but has not answered yet, so the
  // history says what is still to do, not only what is done.
  const pending = (completion?.pendingAssessments || []).map((item) => ({
    id: item.id,
    title: item.title,
    assessment_type: 'module',
    assessment_kind: 'tutor_assessment',
    source_module_title: '',
    score: null,
    total_questions: null,
    percentage: null,
    level: null,
    taken_at: null
  }));

  const graded = taken.filter((row) => row.percentage != null);
  const avgPercentage = graded.length
    ? graded.reduce((sum, row) => sum + Number(row.percentage || 0), 0) / graded.length
    : 0;
  const latest = graded.length ? graded[graded.length - 1] : null;

  return {
    student,
    subject,
    moduleReads: readRows.map((row) => ({
      module_id: row.module_id,
      module_title: `Module ${row.order_number} — ${row.title}`,
      read_at: row.first_opened_at,
      last_opened_at: row.last_opened_at
    })),
    // Newest first for the history table; the chart reads scoreTrend instead.
    assessments: [...taken].reverse().concat(pending),
    scoreTrend: graded.map((row) => ({
      label: row.title,
      kind: kindOf(row),
      percentage: Number(Number(row.percentage).toFixed(1)),
      submitted_at: row.submitted_at
    })),
    attempts: taken,
    antiCheatLogs: violationRows.map((row) => ({
      event_type: String(row.violation_type || '').replace(/_/g, ' '),
      event_detail: row.violation_detail,
      violation_count: row.violation_number,
      created_at: row.occurred_at,
      title: row.title
    })),
    // The retired learning-cycle table; nothing writes it any more.
    learningCycles: [],
    completion,
    stats: {
      totalModulesRead: completion ? completion.modulesOpened : readRows.length,
      totalModules: completion ? completion.modulesTotal : readRows.length,
      totalAssessments: taken.length + pending.length,
      completedAssessments: taken.length,
      totalAttempts: taken.length,
      totalViolations: violationRows.length,
      avgPercentage: Number(avgPercentage.toFixed(1)),
      // The classification on record (the latest measurement), falling back to
      // the latest score's band, and plainly "Not assessed" before any.
      currentLevel: levelRow?.level || (latest ? latest.level : 'Not assessed'),
      latestPercentage: latest ? Number(Number(latest.percentage).toFixed(1)) : null,
      preAssessment: taken.find((row) => row.assessment_kind === 'pre_assessment') || null,
      postAssessment: [...taken].reverse().find((row) => row.assessment_kind === 'post_assessment') || null,
      currentRound: 0
    }
  };
}

// Function: createAssessmentAttempt
// Role: Creates a new attempt record when a student starts or submits an assessment
async function createAssessmentAttempt(assessmentId, studentId, data = {}) {
  const existingAttempts = await query(
    'SELECT COUNT(*) AS cnt FROM assessment_attempts WHERE assessment_id = ? AND student_id = ?',
    [assessmentId, studentId]
  );
  const attemptNumber = Number(existingAttempts[0]?.cnt || 0) + 1;
  const result = await query(
    `INSERT INTO assessment_attempts (assessment_id, student_id, attempt_number, score, total_questions, percentage, level, answers_json, submitted_at, is_auto_submitted, auto_submit_reason, time_spent_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      assessmentId, studentId, attemptNumber,
      data.score || 0, data.total_questions || 0, data.percentage || 0,
      data.level || 'Beginner', data.answers_json || null,
      data.submitted_at || null, data.is_auto_submitted ? 1 : 0,
      data.auto_submit_reason || null, data.time_spent_seconds || null
    ]
  );
  return { insertId: result.insertId, attemptNumber };
}

// Function: logAntiCheatEvent
// Role: Records an anti-cheat violation (tab switch, blur, etc.)
async function logAntiCheatEvent(assessmentId, studentId, eventType, eventDetail = null, attemptId = null) {
  // Get current count for this assessment+student
  const existing = await query(
    'SELECT COUNT(*) AS cnt FROM assessment_anti_cheat_logs WHERE assessment_id = ? AND student_id = ?',
    [assessmentId, studentId]
  );
  const violationCount = Number(existing[0]?.cnt || 0) + 1;
  await query(
    `INSERT INTO assessment_anti_cheat_logs (assessment_id, student_id, attempt_id, event_type, event_detail, violation_count)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [assessmentId, studentId, attemptId, eventType, eventDetail, violationCount]
  );
  return { violationCount };
}

// Function: getAntiCheatViolationCount
// Role: Returns the total violation count for a student on an assessment
async function getAntiCheatViolationCount(assessmentId, studentId) {
  const rows = await query(
    'SELECT COUNT(*) AS cnt FROM assessment_anti_cheat_logs WHERE assessment_id = ? AND student_id = ?',
    [assessmentId, studentId]
  );
  return Number(rows[0]?.cnt || 0);
}

// Function: getStudentLearningCycles
// Role: Returns all learning cycles for a student in a subject
async function getStudentLearningCycles(studentId, subjectId) {
  return query(
    `SELECT slc.*, sr.title AS resource_title, a.title AS assessment_title
     FROM student_learning_cycles slc
     LEFT JOIN subject_resources sr ON sr.id = slc.resource_id
     LEFT JOIN assessments a ON a.id = slc.assessment_id
     WHERE slc.student_id = ? AND slc.subject_id = ?
     ORDER BY slc.round_number ASC`,
    [studentId, subjectId]
  );
}

// Function: getActiveLearningCycle
// Role: Returns the active (non-completed) learning cycle for a student in a subject
/**
 * The ₱500 floor is a DOWN PAYMENT: it applies to the first payment on an account
 * and to nothing after it, so a student settling the tail of their balance can pay
 * whatever they have. The rule itself lives in lib/billing.js and is shared with
 * the cash-request path, so the online and cash routes cannot drift apart.
 */
async function assertMeetsMinimum(bill, amount) {
  const { minimumPaymentFor, minimumPaymentError } = require('./billing');
  const paidRows = await query(
    'SELECT COALESCE(SUM(amount), 0) AS paid FROM payment_entries WHERE billing_id = ?',
    [bill.id]
  );
  const minimum = minimumPaymentFor(bill, paidRows[0]?.paid);
  if (amount < minimum) throw new Error(minimumPaymentError(minimum));
}

async function createOnlinePayment(studentId, amount, options = {}) {
  const bill = await getBillingByStudentId(studentId);
  if (!bill) throw new Error('No billing record found.');
  if (amount <= 0) throw new Error('Payment amount must be greater than zero.');
  const { exceedsBalance, overpaymentError } = require('./billing');
  const forSettlement = Number(bill.for_settlement || 0);
  if (exceedsBalance(amount, forSettlement)) throw new Error(overpaymentError(amount, forSettlement, { audience: 'student' }));
  await assertMeetsMinimum(bill, amount);

  const providerRef = 'MQ-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8).toUpperCase();
  const result = await query(
    `INSERT INTO online_payments (student_id, billing_id, amount, payment_method, provider, provider_reference, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, 'processing', ?)`,
    [studentId, bill.id, amount, options.payment_method || 'online', options.provider || 'MindQuest Mock Pay', providerRef, options.notes || '']
  );
  return { paymentId: result.insertId, providerReference: providerRef };
}

// Function: completeOnlinePayment
// Role: Completes an online payment and applies it to billing
/**
 * @param {number} paymentId
 * @param {object} [options]
 * @param {string} [options.transactionReference]
 *        The gateway's reference for the TRANSACTION, when the webhook was able
 *        to read one. PayMongo gives us two different ids: the checkout session
 *        (`cs_…`, created up front and used to find this row again) and the
 *        payment itself (`pay_…`, which only exists once money has moved). The
 *        second is the one printed on the student's receipt and the one the
 *        office needs when querying a charge, so it wins when present — the
 *        session id is kept as the fallback so a row is never left with no
 *        reference at all.
 * @param {string} [options.method]
 *        How PayMongo says it was paid ('gcash', 'card', ...), when the caller
 *        already has it. Otherwise PayMongo is asked. The ledger files the
 *        payment under that method — GCash, not "Online" — so Payment
 *        Collection's GCash filter finds it.
 */
async function completeOnlinePayment(paymentId, options = {}) {
  const rows = await query('SELECT TOP 1 * FROM online_payments WHERE id = ?', [paymentId]);
  const payment = rows[0];
  if (!payment) throw new Error('Payment not found.');
  if (payment.status === 'completed') throw new Error('Payment already completed.');

  const transactionReference = String(options.transactionReference || '').trim() || null;
  const ledgerReference = transactionReference || payment.provider_reference || null;

  const { onlineMethodLabel } = require('./billing');
  // "Online" only when PayMongo could not be reached; resolveOnlinePaymentMethods
  // names it on the next start.
  const method = onlineMethodLabel(options.method)
    || (payment.provider === 'PayMongo' ? onlineMethodLabel(await fetchPayMongoMethod(ledgerReference)) : null)
    || 'Online';

  // Claim the row and complete it in ONE statement. Two paths can now finish a
  // payment — PayMongo's webhook, and the check made when the student returns
  // from the checkout page — and a read-then-update would let both see
  // "pending" and add the money to the ledger twice. Only the caller whose
  // UPDATE actually changed the row goes on to write the ledger entry.
  const claimed = await query(
    `UPDATE online_payments
        SET status = 'completed', paid_at = DATEADD(hour, 8, GETUTCDATE()),
            notes = ?, updated_at = DATEADD(hour, 8, GETUTCDATE())
     OUTPUT inserted.id AS claimed_id
      WHERE id = ? AND status IN ('pending', 'processing')`,
    [
      transactionReference && transactionReference !== payment.provider_reference
        ? `${payment.notes ? `${payment.notes} · ` : ''}Gateway transaction ${transactionReference} (checkout ${payment.provider_reference})`
        : (payment.notes || ''),
      paymentId
    ]
  );
  if (!claimed.length) throw new Error('Payment already completed.');

  // Apply it through the ledger, exactly like a counter payment. Doing the
  // arithmetic here as well would give online payments a second, competing way to
  // move a balance — and the two would eventually disagree.
  const { addPaymentEntry } = require('./billing');
  await addPaymentEntry({
    studentId: payment.student_id,
    amount: Number(payment.amount),
    paymentMethod: method,
    purpose: 'Tuition',
    referenceNo: ledgerReference,
    notes: `Online payment via ${payment.provider || 'MindQuest Mock Pay'}`
      + (transactionReference && transactionReference !== payment.provider_reference
        ? ` · checkout ${payment.provider_reference}`
        : ''),
    actor: null,
    source: 'online',
    // The gateway has already taken this money. If the balance shrank while
    // the student was on the checkout page (a cash payment landed meanwhile),
    // refusing the entry would lose a real payment — it is recorded, and the
    // excess shows on the account for the office to settle.
    allowOverpayment: true
  });
  return true;
}

/**
 * Ask PayMongo about this student's recent open checkouts, and settle any that
 * have been paid.
 *
 * A payment used to be recorded ONLY when PayMongo's webhook reached
 * /webhook/paymongo. If that call was late, failed, or was never configured for
 * the deployment, the student paid and came back to an unchanged balance. This
 * is called when they return from the checkout page (and whenever they open
 * Billing Data while a checkout is still open), so the money is recorded
 * either way. Safe to run beside the webhook: completeOnlinePayment claims the
 * row atomically, so whichever gets there second does nothing.
 *
 * A checkout PayMongo reports as expired is closed as failed, so it stops being
 * asked about.
 */
async function reconcilePayMongoPayments(studentId) {
  const key = process.env.PAYMONGO_SECRET_KEY || '';
  const outcome = { completed: [], closed: 0, stillOpen: 0 };
  if (key.length <= 10) return outcome;

  const open = await query(
    `SELECT TOP 5 id, amount, provider_reference
       FROM online_payments
      WHERE student_id = ? AND provider = 'PayMongo' AND status IN ('pending', 'processing')
        AND provider_reference LIKE 'cs[_]%'
        AND created_at >= DATEADD(day, -3, DATEADD(hour, 8, GETUTCDATE()))
      ORDER BY id DESC`,
    [studentId]
  );

  for (const row of open) {
    let attributes = null;
    try {
      const response = await fetch(`https://api.paymongo.com/v1/checkout_sessions/${encodeURIComponent(row.provider_reference)}`, {
        headers: { Authorization: 'Basic ' + Buffer.from(key + ':').toString('base64') }
      });
      if (!response.ok) { outcome.stillOpen++; continue; }
      attributes = (await response.json())?.data?.attributes || null;
    } catch (error) {
      console.error('[PayMongo] could not check checkout', row.provider_reference, error.message);
      outcome.stillOpen++;
      continue;
    }

    const paid = (attributes?.payments || []).find((p) => p?.attributes?.status === 'paid');
    if (paid) {
      try {
        await completeOnlinePayment(row.id, {
          transactionReference: paid.id,
          method: attributes.payment_method_used || paid.attributes?.source?.type
        });
        outcome.completed.push(Number(row.amount));
      } catch (error) {
        // The webhook got there first — the money is recorded, which is the point.
        if (!/already completed/i.test(error.message)) throw error;
      }
    } else if (attributes?.status === 'expired') {
      await query(
        `UPDATE online_payments
            SET status = 'failed', notes = ?, updated_at = DATEADD(hour, 8, GETUTCDATE())
          WHERE id = ? AND status IN ('pending', 'processing')`,
        ['Checkout expired on PayMongo without a payment.', row.id]
      );
      outcome.closed++;
    } else {
      outcome.stillOpen++;
    }
  }
  return outcome;
}

/**
 * Ask PayMongo how a checkout (cs_…) or a payment (pay_…) was paid: 'gcash',
 * 'card', 'paymaya', 'grab_pay'. A checkout session carries it as
 * payment_method_used, a payment as source.type. Null when there is no key,
 * the reference is not PayMongo's, or PayMongo cannot be reached — callers fall
 * back rather than fail a payment over a label.
 */
async function fetchPayMongoMethod(reference) {
  const key = process.env.PAYMONGO_SECRET_KEY || '';
  const ref = String(reference || '').trim();
  if (key.length <= 10 || !/^(cs|pay)_[A-Za-z0-9]+$/.test(ref)) return null;

  const resource = ref.startsWith('pay_') ? 'payments' : 'checkout_sessions';
  try {
    const response = await fetch(`https://api.paymongo.com/v1/${resource}/${ref}`, {
      headers: { Authorization: 'Basic ' + Buffer.from(key + ':').toString('base64') }
    });
    if (!response.ok) return null;
    const attributes = (await response.json())?.data?.attributes || {};
    const paid = (attributes.payments || []).find((p) => p?.attributes?.status === 'paid');
    return attributes.payment_method_used || attributes.source?.type || paid?.attributes?.source?.type || null;
  } catch (error) {
    console.error('[PayMongo] could not read the payment method of', ref, error.message);
    return null;
  }
}

/**
 * Re-file ledger entries written as "Online" under the method PayMongo says
 * was used (GCash, Maya, GrabPay, Card).
 *
 * Every online payment used to be written as "Online", so Payment
 * Collection's GCash filter missed students who paid with GCash. Only the
 * method's label changes: amount, reference and balance are untouched, and an
 * entry PayMongo cannot account for is left as it is. Runs at every start
 * (server.js), which also catches a payment completed while PayMongo was
 * unreachable; scripts/backfill-online-payment-methods.js runs it by hand.
 *
 * @param {object} [options]
 * @param {boolean} [options.commit=true]  false = report only, write nothing
 */
async function resolveOnlinePaymentMethods({ commit = true } = {}) {
  const { onlineMethodLabel } = require('./billing');
  const entries = await query(
    `SELECT TOP 100 id, reference_no, payment_method
       FROM payment_entries
      WHERE LOWER(payment_method) = 'online'
        AND (reference_no LIKE 'cs[_]%' OR reference_no LIKE 'pay[_]%')
      ORDER BY id`
  );

  const outcome = { checked: entries.length, changed: [], unresolved: [] };
  for (const entry of entries) {
    const method = onlineMethodLabel(await fetchPayMongoMethod(entry.reference_no));
    if (!method) {
      outcome.unresolved.push(entry.id);
      continue;
    }
    if (commit) {
      await query(
        "UPDATE payment_entries SET payment_method = ? WHERE id = ? AND LOWER(payment_method) = 'online'",
        [method, entry.id]
      );
    }
    outcome.changed.push({ id: entry.id, reference: entry.reference_no, from: entry.payment_method, to: method });
  }
  return outcome;
}

// Function: getOnlinePayments
// Role: Returns online payment records for a student
async function getOnlinePayments(studentId) {
  return query(
    `SELECT * FROM online_payments WHERE student_id = ? ORDER BY created_at DESC`,
    [studentId]
  );
}

// Function: logAiGeneration
// Role: Creates an entry in ai_generation_logs for audit purposes
async function logAiGeneration(data = {}) {
  const result = await query(
    `INSERT INTO ai_generation_logs (generation_type, student_id, subject_id, resource_id, assessment_id, input_summary, output_summary, ai_provider, ai_model, tokens_used, success, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.generation_type || 'unknown',
      data.student_id || null,
      data.subject_id || null,
      data.resource_id || null,
      data.assessment_id || null,
      data.input_summary || null,
      data.output_summary || null,
      data.ai_provider || null,
      data.ai_model || null,
      data.tokens_used || null,
      data.success !== false ? 1 : 0,
      data.error_message || null
    ]
  );
  return result.insertId;
}

// Function: normalizeNumericInput
// Role: Provides helper logic for this file.
function normalizeNumericInput(value) {
  if (Array.isArray(value)) {
    value = value[0];
  }
  if (value === null || value === undefined) return 0;
  const raw = String(value).trim();
  if (!raw) return 0;
  const cleaned = raw.replace(/,/g, '').replace(/\s+/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

// ============================================================================
// Phase 3: Assessment Request Workflow (Tutor Approval)
// ============================================================================

// Function: createAssessmentRequest
// Role: Student requests to take an assessment; tutor must approve
async function getAllStudentsForAnalytics(scopeBranchId = null, search = '') {
  const scope = buildScopeClause(scopeBranchId, 'u.branch_id');
  let searchClause = '';
  const params = [...scope.params];
  if (search) {
    searchClause = ` AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.user_id LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const students = await query(
    `SELECT u.id, u.user_id, u.first_name, u.middle_name, u.last_name,
            u.branch_id, b.name AS branch_name,
            u.year_level, u.grade_level, u.updated_at AS last_activity_date
     FROM users u
     LEFT JOIN branches b ON b.id = u.branch_id
     WHERE u.role = 'student' AND u.is_archived = 0 ${scope.sql} ${searchClause}
     ORDER BY u.first_name ASC, u.last_name ASC`,
    params
  );

  // Enrich each student with assignment, assessment, and level data
  const enriched = [];
  for (const student of students) {
    const assignments = await query(
      `SELECT usa.subject_id, s.name AS subject_name,
              t.first_name AS tutor_first_name, t.last_name AS tutor_last_name
       FROM user_subject_assignments usa
       INNER JOIN subjects s ON s.id = usa.subject_id
       LEFT JOIN users t ON t.id = usa.tutor_id
       WHERE usa.student_id = ? AND usa.is_archived = 0`,
      [student.id]
    );
    const subjects = assignments.map((a) => a.subject_name).join(', ') || '-';
    const tutors = [...new Set(assignments.filter((a) => a.tutor_first_name).map((a) => `${a.tutor_first_name} ${a.tutor_last_name}`))].join(', ') || '-';

    // Get latest assessment result
    const latestResult = await query(
      `SELECT TOP 1 ar.percentage, ar.level, ar.taken_at
       FROM assessment_results ar
       INNER JOIN assessments a ON a.id = ar.assessment_id
       WHERE ar.student_id = ?
       ORDER BY ar.taken_at DESC`,
      [student.id]
    );

    // Get modules read count
    const moduleReads = await query(
      'SELECT COUNT(*) AS cnt FROM module_reads WHERE student_id = ?',
      [student.id]
    );

    // Get completed assessments count
    const assessmentCount = await query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN ar.taken_at IS NOT NULL THEN 1 ELSE 0 END) AS completed
       FROM assessments a
       LEFT JOIN assessment_results ar ON ar.assessment_id = a.id AND ar.student_id = a.assigned_student_id
       WHERE a.assigned_student_id = ?`,
      [student.id]
    );

    const progressStatus = !latestResult.length ? 'Not Started'
      : latestResult[0].level === 'Advance' ? 'Advanced'
      : 'In Progress';

    enriched.push({
      ...student,
      full_name: fullName(student),
      subjects,
      tutor_name: tutors,
      current_level: latestResult.length ? latestResult[0].level : '-',
      avg_score: latestResult.length ? Number(latestResult[0].percentage || 0).toFixed(1) + '%' : '-',
      modules_read: Number(moduleReads[0]?.cnt || 0),
      assessments_completed: Number(assessmentCount[0]?.completed || 0),
      assessments_total: Number(assessmentCount[0]?.total || 0),
      progress_status: progressStatus,
      last_assessment_date: latestResult.length ? latestResult[0].taken_at : null
    });
  }
  return enriched;
}

// Function: getTutorStudentsForAnalytics
// Role: Returns analytics data for students assigned to a specific tutor
async function getTutorStudentsForAnalytics(tutorId, search = '') {
  let searchClause = '';
  const params = [tutorId];
  if (search) {
    searchClause = ` AND (u.first_name LIKE ? OR u.last_name LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`);
  }
  const students = await query(
    `SELECT DISTINCT u.id, u.user_id, u.first_name, u.middle_name, u.last_name,
            u.branch_id, b.name AS branch_name, u.year_level, u.grade_level,
            u.updated_at AS last_activity_date
     FROM user_subject_assignments usa
     INNER JOIN users u ON u.id = usa.student_id
     LEFT JOIN branches b ON b.id = u.branch_id
     WHERE usa.tutor_id = ? AND usa.is_archived = 0 AND u.is_archived = 0 ${searchClause}
     ORDER BY u.first_name ASC, u.last_name ASC`,
    params
  );

  const pendingRequests = await query(
    `SELECT COUNT(*) AS cnt FROM assessment_requests WHERE tutor_id = ? AND status = 'pending'`,
    [tutorId]
  );

  let totalScore = 0;
  let scoreCount = 0;
  const enriched = [];
  for (const student of students) {
    const assignments = await query(
      `SELECT usa.subject_id, s.name AS subject_name
       FROM user_subject_assignments usa
       INNER JOIN subjects s ON s.id = usa.subject_id
       WHERE usa.student_id = ? AND usa.tutor_id = ? AND usa.is_archived = 0`,
      [student.id, tutorId]
    );
    const subjects = assignments.map((a) => a.subject_name).join(', ') || '-';

    const latestResult = await query(
      `SELECT TOP 1 ar.percentage, ar.level, ar.taken_at
       FROM assessment_results ar WHERE ar.student_id = ?
       ORDER BY ar.taken_at DESC`,
      [student.id]
    );

    const moduleReads = await query('SELECT COUNT(*) AS cnt FROM module_reads WHERE student_id = ?', [student.id]);

    const activeCycle = await query(
      `SELECT TOP 1 slc.*, sr.title AS resource_title
       FROM student_learning_cycles slc
       LEFT JOIN subject_resources sr ON sr.id = slc.resource_id
       WHERE slc.student_id = ? AND slc.status <> 'completed'
       ORDER BY slc.round_number DESC`,
      [student.id]
    );

    const completedModules = await query(
      `SELECT COUNT(*) AS cnt FROM student_learning_cycles WHERE student_id = ? AND status = 'completed'`,
      [student.id]
    );

    const pendingReqForStudent = await query(
      `SELECT COUNT(*) AS cnt FROM assessment_requests WHERE student_id = ? AND tutor_id = ? AND status = 'pending'`,
      [student.id, tutorId]
    );

    const violationLogs = await query(
      `SELECT COUNT(*) AS cnt FROM assessment_anti_cheat_logs WHERE student_id = ?`,
      [student.id]
    );

    if (latestResult.length && latestResult[0].percentage != null) {
      totalScore += Number(latestResult[0].percentage);
      scoreCount++;
    }

    enriched.push({
      ...student,
      full_name: fullName(student),
      subjects,
      current_level: latestResult.length ? latestResult[0].level : '-',
      avg_score: latestResult.length ? Number(latestResult[0].percentage || 0).toFixed(1) + '%' : '-',
      modules_read: Number(moduleReads[0]?.cnt || 0),
      completed_modules: Number(completedModules[0]?.cnt || 0),
      current_module: activeCycle.length ? activeCycle[0].resource_title || '-' : '-',
      pending_requests: Number(pendingReqForStudent[0]?.cnt || 0),
      total_violations: Number(violationLogs[0]?.cnt || 0),
      last_assessment_date: latestResult.length ? latestResult[0].taken_at : null
    });
  }

  return {
    students: enriched,
    summary: {
      totalStudents: enriched.length,
      pendingRequests: Number(pendingRequests[0]?.cnt || 0),
      completedStudents: enriched.filter((s) => s.completed_modules > 0).length,
      avgScore: scoreCount > 0 ? Number((totalScore / scoreCount).toFixed(1)) : 0
    }
  };
}

// ============================================================================
// Phase 3: PayMongo Integration
// ============================================================================

// Function: createPayMongoPayment
// Role: Creates a PayMongo checkout session for online payment
async function createPayMongoPayment(studentId, amount, billingInfo = {}) {
  const bill = await getBillingByStudentId(studentId);
  if (!bill) throw new Error('No billing record found.');
  if (amount <= 0) throw new Error('Payment amount must be greater than zero.');
  // Checked before the minimum so a student who typed too MUCH is told the
  // exact amount to pay, rather than being sent to the gateway for it.
  const { exceedsBalance, overpaymentError } = require('./billing');
  const forSettlement = Number(bill.for_settlement || 0);
  if (exceedsBalance(amount, forSettlement)) throw new Error(overpaymentError(amount, forSettlement, { audience: 'student' }));
  await assertMeetsMinimum(bill, amount);

  // PayMongo API key from environment
  const PAYMONGO_SECRET_KEY = process.env.PAYMONGO_SECRET_KEY || '';

  let checkoutUrl = null;
  let providerRef = 'MQ-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8).toUpperCase();
  let provider = 'MindQuest Mock Pay';

  if (PAYMONGO_SECRET_KEY && PAYMONGO_SECRET_KEY.length > 10) {
    // Real PayMongo integration
    try {
      const amountInCentavos = Math.round(amount * 100);
      const payload = {
        data: {
          attributes: {
            line_items: [{
              currency: 'PHP',
              amount: amountInCentavos,
              name: 'MindQuest Tuition Payment',
              quantity: 1
            }],
            payment_method_types: ['gcash', 'grab_pay', 'card', 'paymaya'],
            // The student's own ID (STD-0046) and name, not the database row
            // number, so the receipt and the office's ledger say the same thing.
            description: `Tuition payment — ${billingInfo.label || `student #${studentId}`}`,
            send_email_receipt: true,
            success_url: `${process.env.APP_URL || 'http://localhost:3000'}/student/billing?payment=success`,
            cancel_url: `${process.env.APP_URL || 'http://localhost:3000'}/student/billing?payment=cancelled`,
            metadata: { student_id: String(studentId), billing_id: String(bill.id) }
          }
        }
      };

      // Prefilled on PayMongo's page. Its Pay button stays disabled until a name
      // and an email are there, so a session created without them strands the
      // student on a form they did not expect to fill.
      if (billingInfo.email) {
        payload.data.attributes.billing = {
          name: billingInfo.name || '',
          email: billingInfo.email || '',
          ...(billingInfo.phone ? { phone: billingInfo.phone } : {})
        };
      }

      const response = await fetch('https://api.paymongo.com/v1/checkout_sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + Buffer.from(PAYMONGO_SECRET_KEY + ':').toString('base64')
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('[PayMongo] Checkout creation failed:', errText);
        throw new Error('PayMongo checkout creation failed. Please try again.');
      }

      const data = await response.json();
      checkoutUrl = data.data?.attributes?.checkout_url || null;
      providerRef = data.data?.id || providerRef;
      provider = 'PayMongo';
    } catch (error) {
      console.error('[PayMongo] Error:', error.message);
      throw new Error('Payment gateway error: ' + error.message);
    }
  }

  // Save payment record
  const result = await query(
    `INSERT INTO online_payments (student_id, billing_id, amount, payment_method, provider, provider_reference, status, notes, checkout_url, billing_name, billing_email, billing_phone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      studentId, bill.id, amount,
      'online', provider, providerRef,
      checkoutUrl ? 'pending' : 'processing',
      billingInfo.notes || '',
      checkoutUrl,
      billingInfo.name || null,
      billingInfo.email || null,
      billingInfo.phone || null
    ]
  );

  // If no PayMongo (mock mode), auto-complete
  if (!checkoutUrl) {
    await completeOnlinePayment(result.insertId);
  }

  return {
    paymentId: result.insertId,
    providerReference: providerRef,
    checkoutUrl,
    provider
  };
}


module.exports = {
  getBranches,
  getBranchById,
  addBranch,
  archiveBranch,
  recoverBranch,
  deleteBranchPermanently,
  getBranchMembers,
  isDuplicatePersonName,
  getSubjects,
  getSubjectById,
  isEmailTaken,
  createSubmission,
  getSubmissionById,
  getNotifications,
  getUnreadNotificationCount,
  markNotificationRead,
  declineNotification,
  archiveNotification,
  recoverNotification,
  acceptNotification,
  getDashboardCounts,
  getRecentSubmissions,
  getUsers,
  getAssistantAccounts,
  getAvailableAssistantBranches,
  getUserById,
  changeUserPassword,
  updateUser,
  archiveUser,
  recoverUser,
  deleteUserPermanently,
  createAssistantAccount,
  updateAssistantAccount,
  getStudentAssignments,
  getTutorAssignments,
  getTutorAssignedSubjects,
  getStudentSubjectsOverview,
  createSubjectEnrollmentRequest,
  getAdminInboxNotifications,
  acceptSubjectEnrollmentRequest,
  cancelSubjectEnrollmentRequest,
  getStudentDashboardData,
  getTutorDashboardData,
  getBillingRows,
  getBillingByStudentId,
  updateBilling,
  reenrollStudents,
  // Phase 4.1: the one function allowed to price an account from its enrolments.
  recalculateStudentBilling,
  // Phase 5: admin sets the tutor and schedule; one tutor per student.
  setStudentTutorAndSchedule,
  getAssignedTutorFor,
  FIXED_TIME_SLOTS,
  TUTOR_LOCKED_MESSAGE,
  SUBJECT_MONTHLY_FEE,
  MONTHLY_FULL_BILL,
  markBillPaid,
  getPaymentHistory,
  postSoa,
  getStudentBillingView,
  addSubject,
  archiveSubject,
  recoverSubject,
  deleteSubjectPermanently,
  getSubjectMembers,
  assignStudentsToTutor,
  archiveAssignment,
  recoverAssignment,
  getSubjectArchivedAssignments,
  getSubjectArchivedTutors,
  archiveTutorSubject,
  recoverTutorSubject,
  addSubjectResource,
  getAdminSubjectResources,
  getTutorSharedResources,
  shareAdminResourceToStudents,
  deleteSubjectResource,
  getSubjectResources,
  getTutorSubjectsWithStudents,
  getTutorStudentsBySubject,
  saveAttendance,
  getAttendanceBySubject,
  getAttendanceByTutor,
  getTutorAvailabilityForSubject,
  getTutorAvailabilityForStudent,
  createTutorScheduleApplication,
  createTutorScheduleApplicationForAllSubjects,
  getTutorScheduleNotifications,
  getStudentScheduleNotifications,
  acceptTutorScheduleApplication,
  cancelTutorScheduleApplication,
  finishTutorScheduleApplication,
  markStudentScheduleNotificationRead,
  getTutorScheduleOverview,
  getAllowedContacts,
  getConversation,
  saveMessage,
  getMessageById,
  updateMessageBody,
  unsendMessage,
  createAssessmentTemplate,
  getAssessmentTemplates,
  getAssessmentTemplateById,
  getStudentsMatchingAssessmentTemplate,
  assignAssessmentTemplateToStudents,
  createAssessment,
  getAssessments,
  getAssessmentHistory,
  getAssessmentById,
  getStudentAssessments,
  markAssessmentDone,
  recoverAssessment,
  deleteAssessmentPermanently,
  submitAssessment,
  gradeSubmittedAssessment,
  resetAssessmentResult,
  canonicalizeSubjectNames,
  matchesTutorStudentScope,
  getAssignableStudentsForTutor,
  // Phase 2: AI system functions
  archiveSubjectResource,
  recoverSubjectResource,
  getAdminSubjectResourcesWithArchived,
  getModulesForStudent,
  getModuleReads,
  getStudentAnalytics,
  createAssessmentAttempt,
  logAntiCheatEvent,
  getAntiCheatViolationCount,
  getStudentLearningCycles,
  createOnlinePayment,
  completeOnlinePayment,
  fetchPayMongoMethod,
  resolveOnlinePaymentMethods,
  reconcilePayMongoPayments,
  getOnlinePayments,
  logAiGeneration,
  scoreToLevel,
  // Phase 3: Assessment requests, analytics, PayMongo
  getAllStudentsForAnalytics,
  getTutorStudentsForAnalytics,
  createPayMongoPayment,
  // Phase 4: Admin pre/post assessments
  createSubjectAssessment,
  getSubjectAssessments,
  getSubjectAssessmentForStudent,
  // Phase 5: Module & Level Management
  getModulesBySubject,
  getSubjectModules,
  getModuleById,
  createSubjectModule,
  updateSubjectModule,
  MAX_MODULE_NUMBER,
  getModuleHandouts,
  addModuleHandouts,
  archiveModuleHandout,
  saveHandoutExtraction,
  getModuleHandoutById,
  getModuleHandoutByPath,
  getSubjectHandoutTexts,
  getModuleHandoutTexts,
  getPreAssessmentStatus,
  // Post-Assessment (Phase 8)
  recordModuleOpen,
  getStudentSubjectCompletion,
  getPostAssessment,
  getStudentPostSubmission,
  createPostAssessmentFromPre,
  getSubjectPrePostComparison,
  getSubjectPostReadiness,
  createGeneratedAssessment,
  getGeneratedAssessment,
  getAssessmentWithQuestions,
  getOrCreatePreAssessment,
  gradeAndSubmitAssessment,
  hasCompletedPreAssessment,
  getStudentSubjectModules,
  getSubmissionWithAnswers,
  getWeakAreasForSubmission,
  getSubjectSubmissions,
  bumpSubjectHandoutVersion,
  getModuleTargetOptions,
  moduleTargetsStudent,
  sanitizeModuleTargets,
  getModuleBySubjectAndLevel,
  upsertModule,
  deleteModule,
  getAllModulesAdmin,
  getStudentSubjectLevel,
  setStudentSubjectLevel,
  createTutorAssessment,
  getTutorAssessmentsByModule,
  getSubmissionsByAssessment,
  getTutorAssessmentById,
  getTutorAssessmentQuestions,
  addTutorAssessmentQuestion,
  getStudentSubmissions,
  getAllTutorAssessmentsAdmin,
  getStudentResultsAdmin,
  getTutorStudentResults,
  getStudentProgress,
  resetPreAssessment
};

// ============================================================================
// Phase 4: Admin-created Pre/Post assessments per subject
// ============================================================================

/**
 * Create a pre or post assessment for a subject (admin only).
 * assessment_type should be 'pre' or 'post'.
 * Each question has: question_text, question_type, correct_answer,
 * choice_a/b/c/d (for MC), essay_rubric_keywords (for essay).
 */
async function createSubjectAssessment(subjectId, adminUserId, payload) {
  return withTransaction(async (connection) => {
    const {
      assessment_type, // 'pre' or 'post'
      source_module_title,
      questions = []
    } = payload;

    if (!['pre', 'post'].includes(assessment_type)) {
      throw new Error('Assessment type must be "pre" or "post".');
    }
    if (!questions.length) {
      throw new Error('Please add at least one question.');
    }

    // Get all enrolled students in this subject
    const [studentRows] = await connection.query(
      `SELECT DISTINCT usa.student_id
       FROM user_subject_assignments usa
       WHERE usa.subject_id = ? AND usa.is_archived = 0`,
      [subjectId]
    );
    const studentIds = studentRows.map(r => r.student_id).filter(Boolean);

    // Get subject for title
    const [subjectRows] = await connection.query(
      'SELECT TOP 1 name FROM subjects WHERE id = ?', [subjectId]
    );
    const subjectName = subjectRows[0]?.name || 'Subject';
    const title = `${assessment_type === 'pre' ? 'Pre' : 'Post'}-Assessment: ${subjectName}`;

    let lastAssessmentId = null;

    // Create one assessment per student (or a single one if no students yet)
    const targetIds = studentIds.length ? studentIds : [null];
    for (const studentId of targetIds) {
      const [insertResult] = await connection.query(
        `INSERT INTO assessments (title, assessment_type, assigned_student_id, created_by, is_published, subject_id, assessment_origin, source_module_title)
         VALUES (?, ?, ?, ?, ?, ?, 'admin_created', ?)`,
        [title, assessment_type, studentId, adminUserId, assessment_type === 'pre' ? 1 : 0, subjectId, source_module_title || null]
      );
      const assessmentId = insertResult.insertId;
      lastAssessmentId = assessmentId;

      for (const q of questions) {
        await connection.query(
          `INSERT INTO assessment_questions (assessment_id, question_text, choice_a, choice_b, choice_c, choice_d, correct_answer, question_type, points, essay_rubric_keywords, source_module_title)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            assessmentId,
            q.question_text,
            q.choice_a || '',
            q.choice_b || '',
            q.choice_c || '',
            q.choice_d || '',
            q.correct_answer || '',
            q.question_type || 'Multiple Choice',
            Number(q.points || 1),
            q.essay_rubric_keywords || null,
            q.source_module_title || null
          ]
        );
      }
    }
    return lastAssessmentId;
  });
}

/**
 * Get all pre/post assessments for a subject (admin view).
 */
async function getSubjectAssessments(subjectId) {
  return query(
    `SELECT a.id, a.title, a.assessment_type, a.is_published, a.source_module_title, a.assessment_origin, a.created_at,
            u.first_name, u.middle_name, u.last_name,
            (SELECT COUNT(*) FROM assessment_questions aq WHERE aq.assessment_id = a.id) AS total_questions,
            ar.score, ar.total_questions AS result_total, ar.percentage, ar.level, ar.taken_at
     FROM assessments a
     LEFT JOIN users u ON u.id = a.assigned_student_id
     LEFT JOIN assessment_results ar ON ar.assessment_id = a.id AND ar.student_id = a.assigned_student_id
     WHERE a.subject_id = ? AND a.assessment_origin = 'admin_created'
     ORDER BY a.assessment_type ASC, a.created_at DESC`,
    [subjectId]
  );
}

/**
 * Get pre/post assessments assigned to a specific student for a subject.
 */
async function getSubjectAssessmentForStudent(studentId, subjectId) {
  return query(
    `SELECT a.id, a.title, a.assessment_type, a.is_published, a.source_module_title, a.assessment_origin,
            ar.score, ar.total_questions, ar.percentage, ar.level, ar.taken_at,
            (SELECT COUNT(*) FROM assessment_questions aq WHERE aq.assessment_id = a.id) AS question_count
     FROM assessments a
     LEFT JOIN assessment_results ar ON ar.assessment_id = a.id AND ar.student_id = a.assigned_student_id
     WHERE a.assigned_student_id = ? AND a.subject_id = ? AND a.assessment_origin = 'admin_created'
     ORDER BY a.assessment_type ASC, a.created_at DESC`,
    [studentId, subjectId]
  );
}

// ============================================================================
// Phase 5: Module & Level Management
// ============================================================================

async function getModulesBySubject(subjectId) {
  return query(
    `SELECT m.*, s.name as subject_name 
     FROM modules m 
     JOIN subjects s ON s.id = m.subject_id 
     WHERE m.subject_id = ? AND m.is_archived = 0 
     ORDER BY m.level ASC`,
    [subjectId]
  );
}

async function getModuleBySubjectAndLevel(subjectId, level) {
  const rows = await query(
    `SELECT * FROM modules WHERE subject_id = ? AND level = ? AND is_archived = 0`,
    [subjectId, level]
  );
  return rows[0] || null;
}

async function upsertModule(data) {
  return withTransaction(async (connection) => {
    const { subject_id, level, title, description, file_path, file_original_name, file_type, uploaded_by } = data;
    
    const [existing] = await connection.query(
      `SELECT id FROM modules WHERE subject_id = ? AND level = ?`, 
      [subject_id, level]
    );

    if (existing.length > 0) {
      const updates = [];
      const params = [];
      if (title) { updates.push('title = ?'); params.push(title); }
      if (description) { updates.push('description = ?'); params.push(description); }
      if (file_path) { updates.push('file_path = ?'); params.push(file_path); }
      if (file_original_name) { updates.push('file_original_name = ?'); params.push(file_original_name); }
      if (file_type) { updates.push('file_type = ?'); params.push(file_type); }
      if (uploaded_by) { updates.push('uploaded_by = ?'); params.push(uploaded_by); }
      
      updates.push('is_archived = 0', 'updated_at = DATEADD(hour, 8, GETUTCDATE())');
      params.push(existing[0].id);
      
      await connection.query(`UPDATE modules SET ${updates.join(', ')} WHERE id = ?`, params);
      return existing[0].id;
    } else {
      const [res] = await connection.query(
        `INSERT INTO modules (subject_id, level, title, description, file_path, file_original_name, file_type, uploaded_by) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [subject_id, level, title, description, file_path, file_original_name, file_type, uploaded_by]
      );
      return res.insertId;
    }
  });
}

async function deleteModule(moduleId) {
  return query(`UPDATE modules SET is_archived = 1, updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?`, [moduleId]);
}

async function getAllModulesAdmin() {
  return query(
    `SELECT m.*, s.name as subject_name, u.first_name, u.last_name
     FROM modules m
     JOIN subjects s ON s.id = m.subject_id
     LEFT JOIN users u ON u.id = m.uploaded_by
     WHERE m.is_archived = 0
     ORDER BY s.name ASC, m.order_number ASC, m.id ASC`
  );
}

// ============================================================================
// Module -> Handout system (Module/Assessment overhaul, Phase 3)
// ============================================================================

const MODULE_YEAR_LEVEL_GROUPS = ['Pre School Level', 'Primary Level', 'Junior High Level', 'Senior High Level'];
const MODULE_GRADES_BY_GROUP = {
  'Pre School Level': ['Kinder 1', 'Kinder 2'],
  'Primary Level': ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6'],
  'Junior High Level': ['Grade 7', 'Grade 8', 'Grade 9', 'Grade 10'],
  'Senior High Level': ['Grade 11', 'Grade 12']
};

/** Grouped options for the Admin "visible to" multi-select. */
function getModuleTargetOptions() {
  return MODULE_YEAR_LEVEL_GROUPS.map((group) => ({
    group,
    grades: MODULE_GRADES_BY_GROUP[group] || []
  }));
}

/** Case/spacing-insensitive comparison token for a level label. */
function normalizeLevelToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Keep only labels this system recognises, so a typo cannot silently hide a
 * module from everyone. Accepts either a year-level group or a specific grade.
 */
function sanitizeModuleTargets(values = []) {
  const allowed = new Map();
  for (const group of MODULE_YEAR_LEVEL_GROUPS) {
    allowed.set(normalizeLevelToken(group), group);
    for (const grade of MODULE_GRADES_BY_GROUP[group] || []) {
      allowed.set(normalizeLevelToken(grade), grade);
    }
  }
  const out = [];
  for (const raw of normalizeYearLevels(values)) {
    const canonical = allowed.get(normalizeLevelToken(raw));
    if (canonical && !out.includes(canonical)) out.push(canonical);
  }
  return out;
}

/**
 * Does this module show for this student?
 *
 * NOTE: this deliberately does NOT use normalizeYearLevelKey(). That helper
 * collapses every grade into one of four groups, so 'Kinder 1' and 'Grade 5'
 * both become 'primary level' — a Kinder-1-only module would leak to Grade 5
 * students, which is exactly the case the spec calls out. Matching here is on
 * the exact label instead, against BOTH the student's year_level (the group)
 * and grade_level (the specific year).
 *
 * Selecting a group also matches its grades, so targeting 'Pre School Level'
 * reaches a student recorded only as 'Kinder 1'.
 *
 * An empty target list means "no restriction" -> visible to every student.
 */
function moduleTargetsStudent(mod, student) {
  const selected = sanitizeModuleTargets(safeJsonArray(mod?.target_year_levels_json));
  if (!selected.length) return true;

  const expanded = new Set();
  for (const label of selected) {
    expanded.add(normalizeLevelToken(label));
    for (const grade of MODULE_GRADES_BY_GROUP[label] || []) {
      expanded.add(normalizeLevelToken(grade));
    }
  }

  const studentTokens = [
    student?.year_level,
    student?.grade_level,
    student?.student_year_level,
    student?.student_grade_level
  ]
    .map(normalizeLevelToken)
    .filter(Boolean);

  return studentTokens.some((token) => expanded.has(token));
}

/** Bump the subject's handout version so cached pre-assessments read as stale. */
async function bumpSubjectHandoutVersion(subjectId, connection = null) {
  const sql = 'UPDATE subjects SET handout_version = handout_version + 1, updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?';
  if (connection) return connection.query(sql, [subjectId]);
  return query(sql, [subjectId]);
}

/** Modules of a subject, in Module 1..N order, with their handout counts. */
async function getSubjectModules(subjectId) {
  const rows = await query(
    `SELECT m.*, s.name AS subject_name,
            (SELECT COUNT(*) FROM module_handouts h WHERE h.module_id = m.id AND h.is_archived = 0) AS handout_count,
            (SELECT COUNT(*) FROM tutor_assessments ta WHERE ta.module_id = m.id AND ta.is_archived = 0) AS assessment_count
     FROM modules m
     JOIN subjects s ON s.id = m.subject_id
     WHERE m.subject_id = ? AND m.is_archived = 0
     ORDER BY m.order_number ASC, m.id ASC`,
    [subjectId]
  );
  return rows.map((row) => ({
    ...row,
    target_year_levels: sanitizeModuleTargets(safeJsonArray(row.target_year_levels_json))
  }));
}

async function getModuleById(moduleId) {
  const rows = await query(
    `SELECT m.*, s.name AS subject_name, s.handout_version
     FROM modules m
     JOIN subjects s ON s.id = m.subject_id
     WHERE m.id = ? AND m.is_archived = 0`,
    [moduleId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    target_year_levels: sanitizeModuleTargets(safeJsonArray(row.target_year_levels_json))
  };
}

/**
 * Create the next module in a subject. order_number is assigned as MAX+1 inside
 * a transaction so two admins adding at once cannot both land on "Module 3".
 */
/**
 * Decide which number a module gets, and refuse a clash.
 *
 * Only **live** modules reserve a number. Archiving a module used to leave its
 * number spent forever, because the old rule was MAX(order_number) + 1 across
 * every row: remove Module 1, 2 and 3 and the next one you create is called
 * "Module 4" even though it is the only module in the subject. Counting just the
 * live rows means a removed number becomes available again, which is what an
 * admin looking at the page expects.
 *
 * Left blank, this fills the lowest gap rather than continuing past the end —
 * so a subject with Modules 1, 2, 3 offers 4, and a subject whose only live
 * module is numbered 7 offers 1.
 *
 * @param {number|string|null} requested what the admin typed, or blank for auto
 * @param {number|null} excludeModuleId  the module being renumbered, if any
 */
async function resolveModuleNumber(connection, subjectId, requested, excludeModuleId = null) {
  const [rows] = await connection.query(
    `SELECT order_number, title FROM modules
      WHERE subject_id = ? AND is_archived = 0${excludeModuleId ? ' AND id <> ?' : ''}`,
    excludeModuleId ? [subjectId, excludeModuleId] : [subjectId]
  );
  const taken = new Map(rows.map((row) => [Number(row.order_number), row.title]));

  const raw = requested === undefined || requested === null ? '' : String(requested).trim();
  if (!raw) {
    let candidate = 1;
    while (taken.has(candidate)) candidate++;
    return candidate;
  }

  const wanted = Number(raw);
  if (!Number.isInteger(wanted) || wanted < 1 || wanted > MAX_MODULE_NUMBER) {
    throw new Error(`Module number must be a whole number from 1 to ${MAX_MODULE_NUMBER}.`);
  }
  if (taken.has(wanted)) {
    throw new Error(
      `Module ${wanted} already exists in this subject ("${taken.get(wanted)}"). `
      + 'Choose a different number, or remove that module first.'
    );
  }
  return wanted;
}

async function createSubjectModule(data = {}) {
  const { subject_id, title, description, target_year_levels, uploaded_by, order_number } = data;
  if (!subject_id) throw new Error('Subject is required.');

  const targets = sanitizeModuleTargets(target_year_levels);

  return withTransaction(async (connection) => {
    // Resolved inside the transaction so two admins adding at once cannot both
    // land on the same number.
    const nextOrder = await resolveModuleNumber(connection, subject_id, order_number);
    const finalTitle = String(title || '').trim() || `Module ${nextOrder}`;

    const [res] = await connection.query(
      `INSERT INTO modules (subject_id, order_number, title, description, target_year_levels_json, level, uploaded_by)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      [subject_id, nextOrder, finalTitle, String(description || '').trim(), JSON.stringify(targets), uploaded_by || null]
    );
    return { id: res.insertId, order_number: nextOrder, title: finalTitle };
  });
}

async function updateSubjectModule(moduleId, data = {}) {
  const targets = sanitizeModuleTargets(data.target_year_levels);
  return withTransaction(async (connection) => {
    const [current] = await connection.query(
      'SELECT TOP 1 subject_id, order_number FROM modules WHERE id = ?',
      [moduleId]
    );
    if (!current.length) throw new Error('Module not found.');

    // Renumbering runs through the same check as creating, so an admin cannot
    // move a module on top of one that already holds that number. Blank keeps
    // the number it has rather than reassigning it.
    const requested = String(data.order_number ?? '').trim();
    const order = requested
      ? await resolveModuleNumber(connection, current[0].subject_id, requested, moduleId)
      : Number(current[0].order_number);

    await connection.query(
      `UPDATE modules
          SET title = ?, description = ?, target_year_levels_json = ?, order_number = ?,
              updated_at = DATEADD(hour, 8, GETUTCDATE())
        WHERE id = ?`,
      [
        String(data.title || '').trim(),
        String(data.description || '').trim(),
        JSON.stringify(targets),
        order,
        moduleId
      ]
    );
    return { order_number: order };
  });
}

async function getModuleHandouts(moduleId) {
  return query(
    `SELECT h.*, u.first_name, u.last_name
     FROM module_handouts h
     LEFT JOIN users u ON u.id = h.uploaded_by
     WHERE h.module_id = ? AND h.is_archived = 0
     ORDER BY h.created_at ASC, h.id ASC`,
    [moduleId]
  );
}

/**
 * Attach handout files to a module and invalidate the subject's cached
 * pre-assessment in the same transaction, so a new handout can never be added
 * without the generated assessment being marked stale.
 */
async function addModuleHandouts(moduleId, subjectId, files = [], uploadedBy = null) {
  if (!files.length) return { inserted: 0, ids: [] };
  return withTransaction(async (connection) => {
    const ids = [];
    for (const file of files) {
      const [res] = await connection.query(
        `INSERT INTO module_handouts
           (module_id, title, file_path, file_original_name, file_type, file_size_bytes, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          moduleId,
          file.title || null,
          file.file_path,
          file.file_original_name || null,
          file.file_type || null,
          file.file_size_bytes || null,
          uploadedBy
        ]
      );
      ids.push(res.insertId);
    }
    await bumpSubjectHandoutVersion(subjectId, connection);
    return { inserted: ids.length, ids };
  });
}

/**
 * Store the outcome of text extraction for one handout.
 *
 * extracted_at is set only when the text is actually usable, so the Admin UI can
 * distinguish "parsed and ready to feed generation" from "we read the file but
 * there was nothing in it". A non-usable outcome — a scanned PDF, a legacy .doc,
 * a corrupt file — is recorded in extraction_error as the human-readable reason,
 * because from the admin's point of view they all mean the same thing: this
 * handout cannot produce questions.
 */
async function saveHandoutExtraction(handoutId, result = {}) {
  const usable = !!result.usable;
  const reason = usable ? null : (result.error || result.warning || 'No readable text found.');
  return query(
    `UPDATE module_handouts
        SET extracted_text = ?,
            extracted_at = ${usable ? 'DATEADD(hour, 8, GETUTCDATE())' : 'NULL'},
            extraction_error = ?,
            extraction_method = ?,
            updated_at = DATEADD(hour, 8, GETUTCDATE())
      WHERE id = ?`,
    [usable ? String(result.text || '') : null, reason, result.method || 'text', handoutId]
  );
}

/**
 * Resolve a handout from its public file path, with the parent module's subject
 * and year-level targeting attached. Used by the /uploads/handouts guard so a
 * direct file URL can be authorised the same way the page route is.
 */
async function getModuleHandoutByPath(filePath) {
  const rows = await query(
    `SELECT h.id, h.module_id, h.file_original_name,
            m.subject_id, m.order_number, m.title AS module_title, m.target_year_levels_json,
            m.is_archived AS module_archived
     FROM module_handouts h
     JOIN modules m ON m.id = h.module_id
     WHERE h.file_path = ? AND h.is_archived = 0 AND m.is_archived = 0`,
    [filePath]
  );
  return rows[0] || null;
}

async function getModuleHandoutById(handoutId) {
  const rows = await query(
    `SELECT h.*, m.subject_id, m.order_number, m.title AS module_title
     FROM module_handouts h
     JOIN modules m ON m.id = h.module_id
     WHERE h.id = ?`,
    [handoutId]
  );
  return rows[0] || null;
}

/**
 * Every usable handout text for a subject, newest module order first, for AI
 * generation. Each row carries the module and handout ids so generated questions
 * can be attributed back to their source (weak-area reporting).
 */
async function getSubjectHandoutTexts(subjectId) {
  return query(
    `SELECT h.id AS handout_id, h.file_original_name, h.extracted_text,
            m.id AS module_id, m.order_number, m.title AS module_title
     FROM module_handouts h
     JOIN modules m ON m.id = h.module_id
     WHERE m.subject_id = ?
       AND m.is_archived = 0
       AND h.is_archived = 0
       AND h.extracted_at IS NOT NULL
       AND h.extracted_text IS NOT NULL
     ORDER BY m.order_number ASC, h.id ASC`,
    [subjectId]
  );
}

/**
 * Persist a generated assessment: the header row, its questions, and the choice
 * rows for multiple-choice items — all in one transaction, so a half-written
 * assessment can never be served to a student.
 */
async function createGeneratedAssessment(data = {}) {
  const {
    subject_id, module_id = null, assessment_kind, title, instructions = null,
    purpose, question_type, item_count, handout_version = null,
    source_pre_assessment_id = null, tutor_id = null, questions = []
  } = data;

  return withTransaction(async (connection) => {
    const [res] = await connection.query(
      `INSERT INTO tutor_assessments
         (subject_id, module_id, tutor_id, title, instructions, purpose, assessment_kind,
          question_type, item_count, handout_version, source_pre_assessment_id, is_published)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        subject_id, module_id, tutor_id, title, instructions,
        purpose, assessment_kind, question_type, item_count, handout_version, source_pre_assessment_id
      ]
    );
    const assessmentId = res.insertId;

    for (const q of questions) {
      const [qRes] = await connection.query(
        `INSERT INTO tutor_assessment_questions
           (assessment_id, question_text, question_type, points, correct_answer,
            explanation, answer_rubric, source_module_id, source_handout_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          assessmentId, q.question_text, q.question_type, Number(q.points || 1), q.correct_answer,
          q.explanation || null, q.answer_rubric || null, q.source_module_id || null, q.source_handout_id || null
        ]
      );
      for (const choice of q.choices || []) {
        await connection.query(
          'INSERT INTO tutor_question_options (question_id, option_label, option_text) VALUES (?, ?, ?)',
          [qRes.insertId, choice.label, choice.text]
        );
      }
    }

    return { id: assessmentId, question_count: questions.length };
  });
}

/**
 * Whether a subject's Pre-Assessment is built and current, for the Admin UI.
 *
 * `stale` is the interesting field: an assessment can exist while belonging to an
 * older handout_version, which happens in the seconds between a handout upload
 * and the background warm-up finishing. Showing "ready" then would be a lie the
 * admin would only discover from a student.
 */
async function getPreAssessmentStatus(subjectId) {
  const rows = await query('SELECT TOP 1 handout_version FROM subjects WHERE id = ?', [subjectId]);
  const currentVersion = Number(rows[0] ? rows[0].handout_version : 1) || 1;

  const live = await getGeneratedAssessment(subjectId, 'pre_assessment');
  const readableHandouts = (await getSubjectHandoutTexts(subjectId)).length;

  if (!live) {
    return { exists: false, stale: false, currentVersion, readableHandouts, itemCount: 0, version: null };
  }
  const version = Number(live.handout_version) || null;
  return {
    exists: true,
    stale: version !== currentVersion,
    currentVersion,
    version,
    readableHandouts,
    itemCount: Number(live.item_count) || 0,
    generatedAt: live.created_at
  };
}

/** The live generated assessment of a kind for a subject, if any. */
async function getGeneratedAssessment(subjectId, kind, handoutVersion = null) {
  const params = [subjectId, kind];
  let versionClause = '';
  if (handoutVersion !== null) {
    versionClause = ' AND handout_version = ?';
    params.push(handoutVersion);
  }
  const rows = await query(
    `SELECT TOP 1 * FROM tutor_assessments
      WHERE subject_id = ? AND assessment_kind = ? AND is_archived = 0${versionClause}
      ORDER BY created_at DESC, id DESC`,
    params
  );
  return rows[0] || null;
}

/** Full assessment with questions and choices, ready to render or grade. */
async function getAssessmentWithQuestions(assessmentId) {
  const rows = await query(
    `SELECT ta.*, s.name AS subject_name
     FROM tutor_assessments ta
     JOIN subjects s ON s.id = ta.subject_id
     WHERE ta.id = ? AND ta.is_archived = 0`,
    [assessmentId]
  );
  const assessment = rows[0];
  if (!assessment) return null;

  const questions = await query(
    `SELECT q.*, m.order_number AS source_order_number, m.title AS source_module_title,
            h.file_original_name AS source_handout_name
     FROM tutor_assessment_questions q
     LEFT JOIN modules m ON m.id = q.source_module_id
     LEFT JOIN module_handouts h ON h.id = q.source_handout_id
     WHERE q.assessment_id = ?
     ORDER BY q.id ASC`,
    [assessmentId]
  );

  if (questions.length) {
    const options = await query(
      `SELECT o.* FROM tutor_question_options o
       JOIN tutor_assessment_questions q ON q.id = o.question_id
       WHERE q.assessment_id = ?
       ORDER BY o.option_label ASC`,
      [assessmentId]
    );
    const byQuestion = new Map();
    for (const opt of options) {
      const key = Number(opt.question_id);
      if (!byQuestion.has(key)) byQuestion.set(key, []);
      byQuestion.get(key).push(opt);
    }
    for (const q of questions) q.options = byQuestion.get(Number(q.id)) || [];
  }

  return { ...assessment, questions };
}

/**
 * In-flight generation promises, keyed by subject.
 *
 * Two students opening the same subject at the same moment would otherwise each
 * pay for a full generation. The DB's uq_ta_pre_per_version index is the real
 * guarantee; this just avoids the wasted API call in the common single-server case.
 */
const preAssessmentInFlight = new Map();

/**
 * Get the subject's Pre-Assessment, generating it only when needed.
 *
 * Regenerate-vs-reuse: a generated assessment records the subjects.handout_version
 * it was built from. While that version still matches, the stored assessment is
 * reused — so opening a subject repeatedly costs nothing. Adding or removing a
 * handout bumps the version, which makes the stored copy stale and triggers one
 * regeneration.
 *
 * @returns {Promise<{assessment: object, generated: boolean}>}
 */
async function getOrCreatePreAssessment(subjectId, options = {}) {
  const { PRE_ASSESSMENT_ITEM_COUNT } = require('../config/assessmentDefaults');
  const { itemCount = PRE_ASSESSMENT_ITEM_COUNT } = options;
  const numericId = Number(subjectId);

  const subjectRows = await query('SELECT TOP 1 id, name, handout_version FROM subjects WHERE id = ?', [numericId]);
  const subject = subjectRows[0];
  if (!subject) throw new Error('Subject not found.');
  const version = Number(subject.handout_version || 1);

  const current = await getGeneratedAssessment(numericId, 'pre_assessment', version);
  if (current) {
    return { assessment: await getAssessmentWithQuestions(current.id), generated: false };
  }

  if (preAssessmentInFlight.has(numericId)) {
    return preAssessmentInFlight.get(numericId);
  }

  const work = (async () => {
    const handouts = await getSubjectHandoutTexts(numericId);
    if (!handouts.length) {
      throw new Error('This subject has no handouts with readable text yet, so a Pre-Assessment cannot be generated.');
    }

    const { generateAssessmentFromHandouts, PRE_POST_QUESTION_TYPES } = require('../services/aiService');
    let generated;
    try {
      generated = await generateAssessmentFromHandouts({
        handouts,
        subject: subject.name,
        itemCount,
        // Multiple Choice only, by requirement. The Post-Assessment reuses these
        // exact items to measure improvement, so every one has to grade the same
        // way twice with no judgement in the loop.
        questionType: 'multiple_choice',
        allowedTypes: PRE_POST_QUESTION_TYPES
      });
    } catch (error) {
      // success must be `false`, not 0: logAiGeneration tests `!== false`.
      // assessment_id is deliberately not passed — ai_generation_logs.assessment_id
      // has an FK to the legacy `assessments` table, so a tutor_assessments id
      // would violate it. The id goes in output_summary instead.
      await logAiGeneration({
        generation_type: 'pre_assessment',
        subject_id: numericId,
        input_summary: `${handouts.length} handout(s), ${itemCount} items requested`,
        success: false,
        error_message: error.message
      }).catch((logError) => console.error('[getOrCreatePreAssessment] could not write ai_generation_logs:', logError.message));
      throw error;
    }

    // Retire older versions so only one live Pre-Assessment exists per subject.
    await query(
      `UPDATE tutor_assessments
          SET is_archived = 1, updated_at = DATEADD(hour, 8, GETUTCDATE())
        WHERE subject_id = ? AND assessment_kind = 'pre_assessment' AND is_archived = 0`,
      [numericId]
    );

    let created;
    try {
      created = await createGeneratedAssessment({
        subject_id: numericId,
        module_id: null,
        assessment_kind: 'pre_assessment',
        title: `Pre-Assessment — ${subject.name}`,
        instructions: 'Answer every item. This helps your tutor see what you already know before the lessons begin.',
        purpose: 'pre',
        question_type: 'multiple_choice',
        item_count: generated.kept,
        handout_version: version,
        questions: generated.questions
      });
    } catch (error) {
      // Lost the race against another request: reuse whatever it stored.
      const raced = await getGeneratedAssessment(numericId, 'pre_assessment', version);
      if (raced) return { assessment: await getAssessmentWithQuestions(raced.id), generated: false };
      throw error;
    }

    await logAiGeneration({
      generation_type: 'pre_assessment',
      subject_id: numericId,
      input_summary: `${handouts.length} handout(s), handout_version ${version}`,
      output_summary: `tutor_assessment #${created.id}: ${generated.kept} of ${generated.requested} questions kept`,
      ai_provider: generated.provider,
      ai_model: generated.model,
      tokens_used: generated.tokensUsed,
      success: true
    }).catch((logError) => console.error('[getOrCreatePreAssessment] could not write ai_generation_logs:', logError.message));

    return { assessment: await getAssessmentWithQuestions(created.id), generated: true };
  })();

  preAssessmentInFlight.set(numericId, work);
  try {
    return await work;
  } finally {
    preAssessmentInFlight.delete(numericId);
  }
}

// ============================================================================
// Student attempts: grading, classification, weak areas (overhaul Phase 6)
// ============================================================================

/** Loose comparison for typed answers: case, spacing and edge punctuation. */
function normalizeTypedAnswer(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[."'(\[]+|[.,;:!?"')\]]+$/g, '')
    .trim();
}

/**
 * Grade one question that can be marked without the AI.
 * Returns { isCorrect, normalized } or null when the type needs AI grading.
 */
function gradeObjectiveAnswer(question, submitted) {
  const raw = String(submitted ?? '').trim();

  if (question.question_type === 'multiple_choice') {
    // The form posts the option label, but accept the full option text too.
    let letter = /^[A-E]$/i.test(raw) ? raw.toUpperCase() : '';
    if (!letter) {
      const match = (question.options || []).find(
        (o) => normalizeTypedAnswer(o.option_text) === normalizeTypedAnswer(raw)
      );
      if (match) letter = match.option_label;
    }
    return { isCorrect: !!letter && letter === String(question.correct_answer || '').trim().toUpperCase(), normalized: letter };
  }

  if (question.question_type === 'true_false') {
    const answer = raw.toLowerCase();
    const normalized = ['true', 't', 'yes'].includes(answer) ? 'true'
      : ['false', 'f', 'no'].includes(answer) ? 'false' : '';
    return { isCorrect: !!normalized && normalized === String(question.correct_answer || '').trim().toLowerCase(), normalized };
  }

  if (question.question_type === 'fill_blank') {
    const student = normalizeTypedAnswer(raw);
    const expected = normalizeTypedAnswer(question.correct_answer);
    return { isCorrect: !!student && !!expected && student === expected, normalized: raw };
  }

  return null; // essay
}

/**
 * Grade and record a student's attempt.
 *
 * Reads and AI essay grading happen with NO transaction open — the AI call is a
 * network round trip and holding a SQL transaction across it risks timeouts and
 * lock contention on the remote database. Only the writes are transactional.
 *
 * Per-question `is_correct`, `points_earned` and `ai_feedback` are all persisted,
 * so the result breakdown a student sees is the stored grading rather than a
 * re-derivation that could disagree with the score.
 *
 * @returns {Promise<{submissionId:number, score:number, totalPoints:number, percentage:number, level:string}>}
 */
async function gradeAndSubmitAssessment(data = {}) {
  const { assessment_id, student_id, answers = [], started_at = null } = data;

  const assessment = await getAssessmentWithQuestions(assessment_id);
  if (!assessment) throw new Error('Assessment not found.');
  if (!assessment.questions.length) throw new Error('This assessment has no questions yet.');

  const existing = await query(
    'SELECT TOP 1 id FROM tutor_assessment_submissions WHERE assessment_id = ? AND student_id = ?',
    [assessment_id, student_id]
  );
  if (existing.length) throw new Error('You have already submitted this assessment.');

  const submittedByQuestion = new Map();
  for (const a of answers) submittedByQuestion.set(Number(a.question_id), a.student_answer);

  const graded = [];
  const essays = [];

  for (const question of assessment.questions) {
    const submitted = submittedByQuestion.get(Number(question.id)) ?? '';
    const points = Number(question.points || 1);
    const objective = gradeObjectiveAnswer(question, submitted);

    if (objective) {
      graded.push({
        question,
        student_answer: String(submitted ?? '').trim(),
        is_correct: objective.isCorrect,
        points_earned: objective.isCorrect ? points : 0,
        ai_feedback: null
      });
    } else {
      const entry = {
        question,
        student_answer: String(submitted ?? '').trim(),
        is_correct: false,
        points_earned: 0,
        ai_feedback: null
      };
      graded.push(entry);
      essays.push(entry);
    }
  }

  // Batch the essays into a single AI call, outside any transaction.
  if (essays.length) {
    try {
      const { gradeEssayAnswers } = require('../services/aiService');
      const results = await gradeEssayAnswers(
        essays.map((e) => ({
          questionText: e.question.question_text,
          studentAnswer: e.student_answer,
          expectedAnswer: e.question.answer_rubric || e.question.correct_answer || ''
        }))
      );
      for (let i = 0; i < essays.length; i++) {
        const entry = essays[i];
        const result = results[i] || {};
        const points = Number(entry.question.points || 1);
        // Partial credit: an essay that captures some key points earns some marks.
        const ratio = Math.max(0, Math.min(1, Number(result.score ?? (result.isCorrect ? 1 : 0))));
        entry.is_correct = !!result.isCorrect;
        entry.points_earned = Number((points * ratio).toFixed(2));
        entry.ai_feedback = result.feedback || null;
      }
    } catch (error) {
      console.error('[gradeAndSubmitAssessment] essay grading failed:', error.message);
      for (const entry of essays) {
        entry.ai_feedback = 'This answer could not be graded automatically and needs your tutor to review it.';
      }
    }
  }

  const totalPoints = assessment.questions.reduce((sum, q) => sum + Number(q.points || 1), 0);
  const score = Number(graded.reduce((sum, g) => sum + Number(g.points_earned || 0), 0).toFixed(2));
  const percentage = totalPoints ? Number(((score / totalPoints) * 100).toFixed(2)) : 0;
  const level = determineLevel(percentage);

  const outcome = await withTransaction(async (connection) => {
    let submissionId;
    try {
      const [res] = await connection.query(
        `INSERT INTO tutor_assessment_submissions
           (assessment_id, student_id, score, total_points, percentage, level, started_at, time_spent_seconds)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          assessment_id, student_id, score, totalPoints, percentage, level,
          started_at || null,
          started_at ? Math.max(0, Math.round((Date.now() - new Date(started_at).getTime()) / 1000)) : null
        ]
      );
      submissionId = res.insertId;
    } catch (error) {
      // uq_tas_student_assessment: a double submit raced us.
      if (/duplicate key|unique index|UNIQUE KEY/i.test(error.message)) {
        throw new Error('You have already submitted this assessment.');
      }
      throw error;
    }

    for (const g of graded) {
      await connection.query(
        `INSERT INTO tutor_student_answers
           (submission_id, question_id, student_answer, correct_answer, is_correct, points_earned, ai_feedback)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          submissionId, g.question.id, g.student_answer,
          String(g.question.correct_answer || '').slice(0, 500),
          g.is_correct ? 1 : 0, g.points_earned, g.ai_feedback
        ]
      );
    }

    return { submissionId, score, totalPoints, percentage, level };
  });

  // The classification on record follows the LATEST measurement, whichever kind
  // of assessment produced it.
  //
  // This used to be the caller's job, and only the Pre- and Post-Assessment
  // routes remembered to do it — the module-assessment route did not. A student
  // who opened at 30% and later scored 100% on a module assessment stayed
  // "Beginner" on record for ever, so Analytics showed them, and the whole
  // level-spread chart, in the Beginner colour no matter how well they did.
  //
  // Doing it here means every graded submission moves the classification and a
  // fourth submit route cannot quietly forget again. It runs after the
  // transaction commits, not inside it: setStudentSubjectLevel opens its own,
  // and a failure to update a label must never roll back a graded submission the
  // student has already been shown.
  await setStudentSubjectLevel({
    student_id,
    subject_id: assessment.subject_id,
    level: outcome.level,
    pre_assessment_id: assessment_id,
    score: Math.round(outcome.score),
    total_points: outcome.totalPoints,
    percentage: outcome.percentage
  }).catch((error) => console.error('[gradeAndSubmitAssessment] could not save subject level:', error.message));

  return outcome;
}

/** Has this student finished the subject's Pre-Assessment? Drives the lock. */
async function hasCompletedPreAssessment(studentId, subjectId) {
  const rows = await query(
    `SELECT TOP 1 sub.id, sub.percentage, sub.level, sub.submitted_at, sub.assessment_id
     FROM tutor_assessment_submissions sub
     JOIN tutor_assessments ta ON ta.id = sub.assessment_id
     WHERE sub.student_id = ? AND ta.subject_id = ? AND ta.assessment_kind = 'pre_assessment'
     ORDER BY sub.submitted_at DESC`,
    [studentId, subjectId]
  );
  return rows[0] || null;
}

/**
 * The modules a student may see in a subject: not archived, and targeted at their
 * year level. Uses moduleTargetsStudent(), NOT normalizeYearLevelKey — see the
 * note on that function for why the collapsed key would leak Kinder 1 modules to
 * Grade 5 students.
 */
async function getStudentSubjectModules(studentId, subjectId) {
  const student = await getUserById(studentId);
  const modules = await getSubjectModules(subjectId);
  const visible = modules.filter((mod) => moduleTargetsStudent(mod, student));

  for (const mod of visible) {
    mod.handouts = await getModuleHandouts(mod.id);
  }
  return visible;
}

// ---------------------------------------------------------------------------
// Post-Assessment (overhaul Phase 8, spec Section 4b)
// ---------------------------------------------------------------------------

/**
 * Record that a student opened a module. Idempotent by the unique index on
 * (student_id, module_id): a second open updates the timestamp instead of
 * inflating the completion count.
 */
async function recordModuleOpen(studentId, moduleId, subjectId) {
  await query(
    `UPDATE student_module_reads
        SET last_opened_at = DATEADD(hour, 8, GETUTCDATE())
      WHERE student_id = ? AND module_id = ?`,
    [studentId, moduleId]
  );
  await query(
    `INSERT INTO student_module_reads (student_id, module_id, subject_id)
     SELECT ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM student_module_reads WHERE student_id = ? AND module_id = ?
      )`,
    [studentId, moduleId, subjectId, studentId, moduleId]
  );
}

/**
 * Has this student finished everything the subject asks of them?
 *
 * Per-student, not per-class (decision D5): the Post-Assessment opens for the
 * student who is ready, rather than making them wait on their classmates.
 *
 * "All modules" means the modules *visible to this student* — a module targeted
 * at another year level is not theirs to complete, and counting it would leave
 * them permanently one short. Same for tutor assessments: only those attached to
 * a module they can see.
 */
async function getStudentSubjectCompletion(studentId, subjectId) {
  const modules = await getStudentSubjectModules(studentId, subjectId);
  const moduleIds = modules.map((m) => Number(m.id));

  const preDone = await hasCompletedPreAssessment(studentId, subjectId);

  let modulesOpened = 0;
  let assessments = [];
  let assessmentsDone = 0;

  if (moduleIds.length) {
    const placeholders = moduleIds.map(() => '?').join(',');
    const opened = await query(
      `SELECT COUNT(*) AS c FROM student_module_reads
        WHERE student_id = ? AND module_id IN (${placeholders})`,
      [studentId, ...moduleIds]
    );
    modulesOpened = Number(opened[0].c || 0);

    assessments = await query(
      `SELECT ta.id, ta.title, ta.module_id,
              (SELECT COUNT(*) FROM tutor_assessment_submissions s
                WHERE s.assessment_id = ta.id AND s.student_id = ?) AS submitted
       FROM tutor_assessments ta
       WHERE ta.module_id IN (${placeholders})
         AND ta.assessment_kind = 'tutor_assessment'
         AND ta.is_archived = 0
         AND ta.is_published = 1`,
      [studentId, ...moduleIds]
    );
    assessmentsDone = assessments.filter((a) => Number(a.submitted) > 0).length;
  }

  const postSubmission = await getStudentPostSubmission(studentId, subjectId);

  return {
    preDone: !!preDone,
    modulesTotal: modules.length,
    modulesOpened,
    assessmentsTotal: assessments.length,
    assessmentsDone,
    pendingAssessments: assessments.filter((a) => !Number(a.submitted)),
    postTaken: !!postSubmission,
    postSubmission,
    // A subject with no modules yet is not "complete" — there is nothing to have
    // learned, so a Post-Assessment would measure nothing.
    isComplete: !!preDone
      && modules.length > 0
      && modulesOpened >= modules.length
      && assessmentsDone >= assessments.length
  };
}

/** The live Post-Assessment for a subject, if a tutor has created one. */
async function getPostAssessment(subjectId) {
  const rows = await query(
    `SELECT TOP 1 * FROM tutor_assessments
      WHERE subject_id = ? AND assessment_kind = 'post_assessment' AND is_archived = 0
      ORDER BY created_at DESC, id DESC`,
    [subjectId]
  );
  return rows[0] || null;
}

/** This student's Post-Assessment attempt for a subject, if they have taken it. */
async function getStudentPostSubmission(studentId, subjectId) {
  const rows = await query(
    `SELECT TOP 1 sub.*, ta.title
       FROM tutor_assessment_submissions sub
       JOIN tutor_assessments ta ON ta.id = sub.assessment_id
      WHERE sub.student_id = ? AND ta.subject_id = ? AND ta.assessment_kind = 'post_assessment'
      ORDER BY sub.submitted_at DESC`,
    [studentId, subjectId]
  );
  return rows[0] || null;
}

/**
 * Create the subject's Post-Assessment by copying its Pre-Assessment.
 *
 * The spec requires the *exact same items*, so the copy is a row-level clone of
 * the questions and their choices, with source_pre_assessment_id recording where
 * they came from. Nothing is regenerated: a second call to the AI would produce
 * different questions and the pre-vs-post comparison would be meaningless.
 *
 * ⚠️ An earlier draft of the plan proposed reusing the old "copy-as-post" route.
 * That route never worked — it crashed with MODULE_NOT_FOUND on every click
 * (audit finding #16) — so this is written fresh.
 */
async function createPostAssessmentFromPre(subjectId, tutorId = null) {
  const pre = await getGeneratedAssessment(subjectId, 'pre_assessment');
  if (!pre) throw new Error('This subject has no Pre-Assessment to copy yet.');

  const existing = await getPostAssessment(subjectId);
  if (existing) return { id: existing.id, created: false };

  return withTransaction(async (connection) => {
    const [insert] = await connection.query(
      `INSERT INTO tutor_assessments
         (subject_id, module_id, tutor_id, title, instructions, purpose, assessment_kind,
          question_type, item_count, handout_version, source_pre_assessment_id, is_published)
       VALUES (?, NULL, ?, ?, ?, 'post', 'post_assessment', ?, ?, ?, ?, 1)`,
      [
        subjectId, tutorId,
        String(pre.title || 'Assessment').replace(/^Pre-Assessment/, 'Post-Assessment'),
        'The same questions as your Pre-Assessment. Answer them again so your tutor can see how much you have improved.',
        pre.question_type, pre.item_count, pre.handout_version, pre.id
      ]
    );
    const postId = insert.insertId;

    const [questions] = await connection.query(
      `SELECT * FROM tutor_assessment_questions WHERE assessment_id = ? ORDER BY id ASC`,
      [pre.id]
    );
    for (const q of questions) {
      const [qRes] = await connection.query(
        `INSERT INTO tutor_assessment_questions
           (assessment_id, question_text, question_type, points, correct_answer,
            explanation, answer_rubric, source_module_id, source_handout_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          postId, q.question_text, q.question_type, q.points, q.correct_answer,
          q.explanation, q.answer_rubric, q.source_module_id, q.source_handout_id
        ]
      );
      const [options] = await connection.query(
        `SELECT * FROM tutor_question_options WHERE question_id = ? ORDER BY option_label ASC`,
        [q.id]
      );
      for (const o of options) {
        await connection.query(
          'INSERT INTO tutor_question_options (question_id, option_label, option_text) VALUES (?, ?, ?)',
          [qRes.insertId, o.option_label, o.option_text]
        );
      }
    }

    return { id: postId, created: true, question_count: questions.length };
  });
}

/**
 * Which students in a subject have finished everything, for the tutor's
 * "Create Post Assessment" decision. Per student (D5), so the tutor can see who
 * is ready rather than a single class-wide yes/no.
 */
async function getSubjectPostReadiness(subjectId, options = {}) {
  /*
   * options.studentIds narrows the class to those students — a tutor sees their
   * own learners, not every student taking the subject in every branch.
   *
   * The same answer getStudentSubjectCompletion gives for one student, worked
   * out for the whole class from SIX queries instead of about six PER STUDENT.
   * Called once per student it cost ~500 queries for a subject with 86 learners,
   * and the tutor's subject page took minutes to open. Each fact below is read
   * once for the subject and then looked up per student in memory.
   */
  const allStudents = await query(
    `SELECT DISTINCT u.id, u.first_name, u.middle_name, u.last_name, u.user_id AS student_code,
            u.year_level, u.grade_level
     FROM users u
     JOIN user_subject_assignments usa
       ON usa.student_id = u.id AND usa.subject_id = ? AND usa.is_archived = 0
     WHERE u.role = 'student' AND u.is_archived = 0
     ORDER BY u.last_name ASC, u.first_name ASC`,
    [subjectId]
  );
  const onlyThese = Array.isArray(options.studentIds) ? new Set(options.studentIds.map(Number)) : null;
  const students = onlyThese ? allStudents.filter((s) => onlyThese.has(Number(s.id))) : allStudents;

  const modules = await getSubjectModules(subjectId);
  const moduleIds = modules.map((m) => Number(m.id));
  const inList = moduleIds.map(() => '?').join(',');

  const [preRows, readRows, assessmentRows, postRows] = await Promise.all([
    query(
      `SELECT DISTINCT sub.student_id
         FROM tutor_assessment_submissions sub
         JOIN tutor_assessments ta ON ta.id = sub.assessment_id
        WHERE ta.subject_id = ? AND ta.assessment_kind = 'pre_assessment'`,
      [subjectId]
    ),
    moduleIds.length
      ? query(`SELECT student_id, module_id FROM student_module_reads WHERE module_id IN (${inList})`, moduleIds)
      : Promise.resolve([]),
    moduleIds.length
      ? query(
        `SELECT ta.id, ta.title, ta.module_id
           FROM tutor_assessments ta
          WHERE ta.module_id IN (${inList})
            AND ta.assessment_kind = 'tutor_assessment'
            AND ta.is_archived = 0
            AND ta.is_published = 1`,
        moduleIds
      )
      : Promise.resolve([]),
    query(
      `SELECT sub.*, ta.title
         FROM tutor_assessment_submissions sub
         JOIN tutor_assessments ta ON ta.id = sub.assessment_id
        WHERE ta.subject_id = ? AND ta.assessment_kind = 'post_assessment'
        ORDER BY sub.submitted_at DESC`,
      [subjectId]
    )
  ]);

  const submittedRows = assessmentRows.length
    ? await query(
      `SELECT assessment_id, student_id, COUNT(*) AS submitted
         FROM tutor_assessment_submissions
        WHERE assessment_id IN (${assessmentRows.map(() => '?').join(',')})
        GROUP BY assessment_id, student_id`,
      assessmentRows.map((a) => Number(a.id))
    )
    : [];

  const preDone = new Set(preRows.map((r) => Number(r.student_id)));
  const opened = new Set(readRows.map((r) => `${r.student_id}|${r.module_id}`));
  const submitted = new Map(submittedRows.map((r) => [`${r.student_id}|${r.assessment_id}`, Number(r.submitted || 0)]));
  const latestPost = new Map();
  for (const row of postRows) {
    if (!latestPost.has(Number(row.student_id))) latestPost.set(Number(row.student_id), row);
  }

  const rows = students.map((student) => {
    const studentId = Number(student.id);
    // Only the modules aimed at this student's level are theirs to finish.
    const visible = modules.filter((mod) => moduleTargetsStudent(mod, student));
    const visibleIds = new Set(visible.map((m) => Number(m.id)));
    const modulesOpened = visible.filter((m) => opened.has(`${studentId}|${m.id}`)).length;
    const assessments = assessmentRows
      .filter((a) => visibleIds.has(Number(a.module_id)))
      .map((a) => ({ id: a.id, title: a.title, module_id: a.module_id, submitted: submitted.get(`${studentId}|${a.id}`) || 0 }));
    const assessmentsDone = assessments.filter((a) => Number(a.submitted) > 0).length;
    const postSubmission = latestPost.get(studentId) || null;
    const isPreDone = preDone.has(studentId);

    const { year_level: _yearLevel, grade_level: _gradeLevel, ...identity } = student;
    return {
      ...identity,
      preDone: isPreDone,
      modulesTotal: visible.length,
      modulesOpened,
      assessmentsTotal: assessments.length,
      assessmentsDone,
      pendingAssessments: assessments.filter((a) => !Number(a.submitted)),
      postTaken: !!postSubmission,
      postSubmission,
      isComplete: isPreDone
        && visible.length > 0
        && modulesOpened >= visible.length
        && assessmentsDone >= assessments.length
    };
  });

  return {
    students: rows,
    readyCount: rows.filter((r) => r.isComplete).length,
    total: rows.length
  };
}

/**
 * Pre versus post for every student in a subject — the comparison the Student,
 * Tutor and Admin views all read (spec Section 4b).
 *
 * `delta` is a percentage-point change; `level_changed` is the classification
 * move the spec asks to show ("Beginner -> Intermediate").
 */
async function getSubjectPrePostComparison(subjectId) {
  const rows = await query(
    `SELECT u.id AS student_id, u.first_name, u.middle_name, u.last_name,
            u.user_id AS student_code, u.year_level, u.grade_level,
            pre.id AS pre_submission_id, pre.percentage AS pre_percentage,
            pre.level AS pre_level, pre.submitted_at AS pre_submitted_at,
            post.id AS post_submission_id, post.percentage AS post_percentage,
            post.level AS post_level, post.submitted_at AS post_submitted_at
     FROM users u
     JOIN user_subject_assignments usa
       ON usa.student_id = u.id AND usa.subject_id = ? AND usa.is_archived = 0
     OUTER APPLY (
       SELECT TOP 1 s.id, s.percentage, s.level, s.submitted_at
       FROM tutor_assessment_submissions s
       JOIN tutor_assessments a ON a.id = s.assessment_id
       WHERE s.student_id = u.id AND a.subject_id = ? AND a.assessment_kind = 'pre_assessment'
       ORDER BY s.submitted_at DESC
     ) pre
     OUTER APPLY (
       SELECT TOP 1 s.id, s.percentage, s.level, s.submitted_at
       FROM tutor_assessment_submissions s
       JOIN tutor_assessments a ON a.id = s.assessment_id
       WHERE s.student_id = u.id AND a.subject_id = ? AND a.assessment_kind = 'post_assessment'
       ORDER BY s.submitted_at DESC
     ) post
     WHERE u.role = 'student' AND u.is_archived = 0
     ORDER BY u.last_name ASC, u.first_name ASC`,
    [subjectId, subjectId, subjectId]
  );

  return rows.map((r) => {
    const hasBoth = r.pre_submission_id && r.post_submission_id;
    return {
      ...r,
      delta: hasBoth ? Number((Number(r.post_percentage) - Number(r.pre_percentage)).toFixed(1)) : null,
      level_changed: hasBoth && r.pre_level !== r.post_level
    };
  });
}

/** A submission with its per-question breakdown, for the result page. */
async function getSubmissionWithAnswers(submissionId) {
  const rows = await query(
    `SELECT sub.*, ta.title, ta.assessment_kind, ta.subject_id, s.name AS subject_name,
            u.first_name, u.middle_name, u.last_name, u.user_id AS student_code
     FROM tutor_assessment_submissions sub
     JOIN tutor_assessments ta ON ta.id = sub.assessment_id
     JOIN subjects s ON s.id = ta.subject_id
     JOIN users u ON u.id = sub.student_id
     WHERE sub.id = ?`,
    [submissionId]
  );
  const submission = rows[0];
  if (!submission) return null;

  const answers = await query(
    `SELECT a.*, q.question_text, q.question_type, q.points, q.explanation, q.answer_rubric,
            q.source_module_id, q.source_handout_id,
            m.order_number AS source_order_number, m.title AS source_module_title,
            h.file_original_name AS source_handout_name
     FROM tutor_student_answers a
     JOIN tutor_assessment_questions q ON q.id = a.question_id
     LEFT JOIN modules m ON m.id = q.source_module_id
     LEFT JOIN module_handouts h ON h.id = q.source_handout_id
     WHERE a.submission_id = ?
     ORDER BY a.id ASC`,
    [submissionId]
  );

  // Attach choices so the result page can show which option was picked.
  const mcIds = answers.filter((a) => a.question_type === 'multiple_choice').map((a) => Number(a.question_id));
  if (mcIds.length) {
    const options = await query(
      `SELECT * FROM tutor_question_options WHERE question_id IN (${mcIds.map(() => '?').join(',')}) ORDER BY option_label ASC`,
      mcIds
    );
    const byQuestion = new Map();
    for (const o of options) {
      const key = Number(o.question_id);
      if (!byQuestion.has(key)) byQuestion.set(key, []);
      byQuestion.get(key).push(o);
    }
    for (const a of answers) a.options = byQuestion.get(Number(a.question_id)) || [];
  }

  return { ...submission, answers };
}

/**
 * Weak areas: group the wrong answers by the module and handout the question came
 * from, so a tutor can see "weak in Module 2 — Handout: Fractions".
 *
 * Questions whose source handout has since been deleted fall into an "Unattributed"
 * bucket rather than being dropped, so the totals still add up.
 */
async function getWeakAreasForSubmission(submissionId) {
  const rows = await query(
    `SELECT q.source_module_id, q.source_handout_id,
            m.order_number, m.title AS module_title,
            h.file_original_name AS handout_name,
            COUNT(*) AS total,
            SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END) AS correct
     FROM tutor_student_answers a
     JOIN tutor_assessment_questions q ON q.id = a.question_id
     LEFT JOIN modules m ON m.id = q.source_module_id
     LEFT JOIN module_handouts h ON h.id = q.source_handout_id
     WHERE a.submission_id = ?
     GROUP BY q.source_module_id, q.source_handout_id, m.order_number, m.title, h.file_original_name
     ORDER BY m.order_number ASC, h.file_original_name ASC`,
    [submissionId]
  );

  return rows.map((r) => {
    const total = Number(r.total || 0);
    const correct = Number(r.correct || 0);
    const wrong = total - correct;
    return {
      module_id: r.source_module_id,
      handout_id: r.source_handout_id,
      order_number: r.order_number,
      module_title: r.module_title || 'Unattributed',
      handout_name: r.handout_name || null,
      total,
      correct,
      wrong,
      percentage: total ? Number(((correct / total) * 100).toFixed(1)) : 0,
      is_weak: total > 0 && correct / total < 0.6
    };
  });
}

/** Every submission for a subject, for the Tutor/Admin results view. */
async function getSubjectSubmissions(subjectId, options = {}) {
  const params = [subjectId];
  let kindClause = '';
  if (options.kind) {
    kindClause = ' AND ta.assessment_kind = ?';
    params.push(options.kind);
  }
  return query(
    `SELECT sub.id, sub.student_id, sub.score, sub.total_points, sub.percentage, sub.level, sub.submitted_at,
            ta.id AS assessment_id, ta.title, ta.assessment_kind,
            u.first_name, u.middle_name, u.last_name, u.user_id AS student_code, u.year_level, u.grade_level
     FROM tutor_assessment_submissions sub
     JOIN tutor_assessments ta ON ta.id = sub.assessment_id
     JOIN users u ON u.id = sub.student_id
     WHERE ta.subject_id = ?${kindClause}
     ORDER BY sub.submitted_at DESC`,
    params
  );
}

async function archiveModuleHandout(handoutId) {
  return withTransaction(async (connection) => {
    const [rows] = await connection.query(
      `SELECT h.id, m.subject_id
       FROM module_handouts h
       JOIN modules m ON m.id = h.module_id
       WHERE h.id = ?`,
      [handoutId]
    );
    const found = rows[0];
    if (!found) throw new Error('Handout not found.');
    await connection.query(
      'UPDATE module_handouts SET is_archived = 1, updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?',
      [handoutId]
    );
    await bumpSubjectHandoutVersion(found.subject_id, connection);
    return { subject_id: found.subject_id };
  });
}

async function getStudentSubjectLevel(studentId, subjectId) {
  const rows = await query(
    `SELECT * FROM student_subject_levels WHERE student_id = ? AND subject_id = ?`,
    [studentId, subjectId]
  );
  return rows[0] || null;
}

async function setStudentSubjectLevel(data) {
  return withTransaction(async (connection) => {
    const { student_id, subject_id, level, pre_assessment_id, score, total_points, percentage } = data;
    
    const [existing] = await connection.query(
      `SELECT id FROM student_subject_levels WHERE student_id = ? AND subject_id = ?`,
      [student_id, subject_id]
    );

    if (existing.length > 0) {
      await connection.query(
        `UPDATE student_subject_levels SET level = ?, pre_assessment_id = ?, score = ?, total_points = ?, percentage = ?, assigned_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?`,
        [level, pre_assessment_id, score, total_points, percentage, existing[0].id]
      );
    } else {
      await connection.query(
        `INSERT INTO student_subject_levels (student_id, subject_id, level, pre_assessment_id, score, total_points, percentage) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [student_id, subject_id, level, pre_assessment_id, score, total_points, percentage]
      );
    }
  });
}

/**
 * Create a tutor's own assessment for one module (spec Section 4a).
 *
 * Extended in Phase 7 to carry what the overhaul added: assessment_kind (so a
 * tutor's assessment is distinguishable from a generated pre/post), the chosen
 * question_type and item_count, essay rubrics, and the source module/handout of
 * each question. That last pair is what lets an AI-drafted tutor assessment feed
 * the same weak-area view as the Pre-Assessment; a hand-written question simply
 * attributes to the module it was written for.
 */
async function createTutorAssessment(data) {
  const { MODULE_QUESTION_TYPES } = require('../services/aiService');

  // A module assessment may only be Multiple Choice, Fill in the Blank or True
  // or False. Checked HERE and not only in the form, because the builder posts a
  // JSON blob: a hand-edited request could otherwise store an essay question
  // that nothing in the app knows how to render or mark.
  const offending = (data.questions || []).find(
    (q) => !MODULE_QUESTION_TYPES.includes(String(q.question_type || ''))
  );
  if (offending) {
    throw new Error(
      `"${offending.question_type}" is not an allowed question type. `
      + 'Module assessments may use Multiple Choice, Fill in the Blank or True or False.'
    );
  }

  // Fill in the blank is marked by comparing text, so an empty answer key would
  // mark every attempt wrong. Catch it at write time rather than at grading time.
  const blankWithoutAnswer = (data.questions || []).find(
    (q) => q.question_type === 'fill_blank' && !String(q.correct_answer || '').trim()
  );
  if (blankWithoutAnswer) {
    throw new Error('Every Fill in the Blank question needs an answer key.');
  }

  return withTransaction(async (connection) => {
    const {
      subject_id, module_id, tutor_id, title, instructions, purpose,
      assessment_kind = 'tutor_assessment', question_type = 'mixed',
      item_count = null, is_published = 1, questions
    } = data;

    const [res] = await connection.query(
      `INSERT INTO tutor_assessments
         (subject_id, module_id, tutor_id, title, instructions, purpose,
          assessment_kind, question_type, item_count, is_published)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        subject_id, module_id, tutor_id, title, instructions, purpose,
        assessment_kind, question_type, item_count === null ? questions.length : item_count,
        is_published ? 1 : 0
      ]
    );
    const assessmentId = res.insertId;

    for (const q of questions) {
      const [qRes] = await connection.query(
        `INSERT INTO tutor_assessment_questions
           (assessment_id, question_text, question_type, points, correct_answer,
            explanation, answer_rubric, source_module_id, source_handout_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          assessmentId, q.question_text, q.question_type, q.points || 1, q.correct_answer,
          q.explanation || null, q.answer_rubric || null,
          // Hand-written questions have no handout of origin, but they always
          // belong to the module the tutor is writing for.
          q.source_module_id || module_id || null,
          q.source_handout_id || null
        ]
      );

      const options = q.options || q.choices || [];
      if (q.question_type === 'multiple_choice' && options.length) {
        for (const opt of options) {
          await connection.query(
            `INSERT INTO tutor_question_options (question_id, option_label, option_text) VALUES (?, ?, ?)`,
            [qRes.insertId, opt.option_label || opt.label, opt.option_text || opt.text]
          );
        }
      }
    }
    return assessmentId;
  });
}

async function getTutorAssessmentsByModule(moduleId) {
  return query(
    `SELECT ta.*,
            (SELECT COUNT(*) FROM tutor_assessment_questions q WHERE q.assessment_id = ta.id) AS question_count,
            (SELECT COUNT(*) FROM tutor_assessment_submissions s WHERE s.assessment_id = ta.id) AS submission_count,
            u.first_name AS author_first_name, u.last_name AS author_last_name
     FROM tutor_assessments ta
     LEFT JOIN users u ON u.id = ta.tutor_id
     WHERE ta.module_id = ? AND ta.is_archived = 0
     ORDER BY ta.created_at ASC`,
    [moduleId]
  );
}

/**
 * Every attempt at one assessment, newest first, so the tutor can check the work
 * their students handed in on a module assessment they wrote.
 *
 * Students who have NOT answered matter as much as those who have, so this is a
 * LEFT JOIN from the enrolled students rather than a plain list of submissions:
 * a tutor checking a module needs to see who is still outstanding.
 */
async function getSubmissionsByAssessment(assessmentId, options = {}) {
  // options.tutorId narrows the class to that tutor's own students in the
  // subject. Without it this listed EVERY student taking the subject in every
  // branch — on a tutor's "Check Answers" page, dozens of other tutors'
  // learners showed as "Not answered yet".
  const tutorClause = options.tutorId ? ' AND usa.tutor_id = ?' : '';
  const params = options.tutorId ? [Number(options.tutorId), assessmentId] : [assessmentId];
  return query(
    `SELECT DISTINCT
            u.id AS student_id,
            u.first_name, u.last_name, u.user_id AS student_code,
            u.year_level, u.grade_level,
            tas.submission_id, tas.score, tas.total_points,
            tas.percentage, tas.level, tas.submitted_at,
            -- Selected, not just sorted on: SELECT DISTINCT rejects an ORDER BY
            -- over an expression that is not in the select list.
            CASE WHEN tas.submission_id IS NULL THEN 1 ELSE 0 END AS is_pending
     FROM tutor_assessments ta
     JOIN user_subject_assignments usa
          ON usa.subject_id = ta.subject_id AND usa.is_archived = 0${tutorClause}
     JOIN users u ON u.id = usa.student_id AND u.is_archived = 0
     OUTER APPLY (
       SELECT TOP 1 s.id AS submission_id, s.score, s.total_points,
                    s.percentage, s.level, s.submitted_at
       FROM tutor_assessment_submissions s
       WHERE s.assessment_id = ta.id AND s.student_id = u.id
       ORDER BY s.submitted_at DESC
     ) tas
     WHERE ta.id = ?
     ORDER BY is_pending ASC, tas.submitted_at DESC, u.first_name ASC`,
    params
  );
}

/**
 * The readable handout text of ONE module, for drafting a module-scoped
 * assessment. Same contract as getSubjectHandoutTexts: rows with no usable text
 * are excluded structurally, so generation can never be fed an empty string and
 * invent questions the handout does not support.
 */
async function getModuleHandoutTexts(moduleId) {
  return query(
    `SELECT h.id AS handout_id, h.file_original_name, h.extracted_text,
            m.id AS module_id, m.order_number, m.title AS module_title
     FROM module_handouts h
     JOIN modules m ON m.id = h.module_id
     WHERE h.module_id = ?
       AND m.is_archived = 0
       AND h.is_archived = 0
       AND h.extracted_at IS NOT NULL
       AND h.extracted_text IS NOT NULL
     ORDER BY h.id ASC`,
    [moduleId]
  );
}

async function getTutorAssessmentById(id) {
  const assessments = await query(`SELECT * FROM tutor_assessments WHERE id = ?`, [id]);
  if (!assessments.length) return null;
  const assessment = assessments[0];
  
  const questions = await query(`SELECT * FROM tutor_assessment_questions WHERE assessment_id = ? ORDER BY id ASC`, [id]);
  
  for (const q of questions) {
    if (q.question_type === 'multiple_choice') {
      q.options = await query(`SELECT * FROM tutor_question_options WHERE question_id = ? ORDER BY option_label ASC`, [q.id]);
    }
  }
  
  assessment.questions = questions;
  return assessment;
}

async function getTutorAssessmentQuestions(assessmentId) {
  return query(`SELECT * FROM tutor_assessment_questions WHERE assessment_id = ? ORDER BY id ASC`, [assessmentId]);
}

async function addTutorAssessmentQuestion(data) {
  return withTransaction(async (connection) => {
    // Basic wrapper for future use
  });
}

async function getStudentSubmissions(studentId, subjectId) {
  return query(
    // m.level is aliased: tas.* already has a level column, and two columns of
    // the same name come back as an array rather than a value.
    //
    // LEFT JOIN modules: the Pre- and Post-Assessment are subject-level and
    // carry no module, so an inner join dropped them — My Progress counted
    // neither in "Assessments Taken" or the average.
    `SELECT tas.*, ta.title, ta.purpose, ta.assessment_kind, m.level AS module_level, m.title as module_title
     FROM tutor_assessment_submissions tas
     JOIN tutor_assessments ta ON ta.id = tas.assessment_id
     LEFT JOIN modules m ON m.id = ta.module_id
     WHERE tas.student_id = ? AND ta.subject_id = ?
     ORDER BY tas.submitted_at DESC`,
    [studentId, subjectId]
  );
}

/**
 * Every assessment in a subject as it exists today — the generated
 * Pre-Assessment, each tutor's module assessments, and the Post-Assessment —
 * with how many students have answered each.
 *
 * The admin subject page's "Subject Assessments" used to read the retired
 * `assessments` table (getSubjectAssessments), which nothing writes any more,
 * so it was always empty.
 */
async function getSubjectAssessmentsOverview(subjectId) {
  return query(
    `SELECT ta.id, ta.title, ta.assessment_kind, ta.purpose, ta.is_published, ta.created_at,
            ta.item_count, m.order_number AS module_number, m.title AS module_title,
            u.first_name AS tutor_first_name, u.last_name AS tutor_last_name,
            (SELECT COUNT(*) FROM tutor_assessment_questions q WHERE q.assessment_id = ta.id) AS question_count,
            (SELECT COUNT(*) FROM tutor_assessment_submissions s WHERE s.assessment_id = ta.id) AS submission_count,
            (SELECT AVG(CAST(s.percentage AS FLOAT)) FROM tutor_assessment_submissions s WHERE s.assessment_id = ta.id) AS average_percentage
       FROM tutor_assessments ta
       LEFT JOIN modules m ON m.id = ta.module_id
       LEFT JOIN users u ON u.id = ta.tutor_id
      WHERE ta.subject_id = ? AND ta.is_archived = 0
      ORDER BY CASE ta.assessment_kind WHEN 'pre_assessment' THEN 0 WHEN 'tutor_assessment' THEN 1 ELSE 2 END,
               m.order_number ASC, ta.created_at ASC`,
    [subjectId]
  );
}

async function getAllTutorAssessmentsAdmin() {
  return query(
    `SELECT ta.*, s.name as subject_name, m.title as module_title, m.level, u.first_name, u.last_name,
            (SELECT COUNT(*) FROM tutor_assessment_questions WHERE assessment_id = ta.id) as question_count
     FROM tutor_assessments ta
     JOIN subjects s ON s.id = ta.subject_id
     JOIN modules m ON m.id = ta.module_id
     JOIN users u ON u.id = ta.tutor_id
     WHERE ta.is_archived = 0
     ORDER BY ta.created_at DESC`
  );
}

/**
 * Every submission, for the Admin / Admin Assistant results page. `modules` is a
 * LEFT JOIN because a Pre-Assessment is subject-level and carries module_id NULL —
 * as an INNER JOIN it silently dropped every generated Pre-Assessment from this
 * page. `level` now comes from the submission (the student's classification),
 * which is what the column has always claimed to show.
 */
async function getStudentResultsAdmin() {
  return query(
    `SELECT tas.*, ta.title as assessment_title, ta.purpose, ta.assessment_kind,
            s.name as subject_name, u.first_name, u.last_name, u.user_id AS student_code
     FROM tutor_assessment_submissions tas
     JOIN tutor_assessments ta ON ta.id = tas.assessment_id
     JOIN subjects s ON s.id = ta.subject_id
     JOIN users u ON u.id = tas.student_id
     ORDER BY tas.submitted_at DESC`
  );
}

/**
 * Every submission a tutor is entitled to see.
 *
 * Two joins here used to hide the generated Pre-Assessments completely: `modules`
 * was an INNER JOIN (a Pre-Assessment has module_id NULL because it is
 * subject-level), and the filter was `ta.tutor_id = ?` (a generated assessment has
 * no author). Both are relaxed: the module join is LEFT, and a tutor also sees
 * submissions for the subjects they are assigned to — the same rule the
 * /tutor/results/:id guard enforces.
 */
async function getTutorStudentResults(tutorId) {
  const assigned = await getTutorAssignedSubjects(tutorId);
  const subjectIds = [...new Set(assigned.map((a) => Number(a.subject_id)).filter(Boolean))];

  const params = [tutorId];
  let subjectClause = '';
  if (subjectIds.length) {
    subjectClause = ` OR ta.subject_id IN (${subjectIds.map(() => '?').join(',')})`;
    params.push(...subjectIds);
  }

  return query(
    `SELECT tas.*, ta.title as assessment_title, ta.purpose, ta.assessment_kind,
            s.name as subject_name, u.first_name, u.last_name
     FROM tutor_assessment_submissions tas
     JOIN tutor_assessments ta ON ta.id = tas.assessment_id
     JOIN subjects s ON s.id = ta.subject_id
     JOIN users u ON u.id = tas.student_id
     WHERE ta.tutor_id = ?${subjectClause}
     ORDER BY tas.submitted_at DESC`,
    params
  );
}

async function getStudentProgress(studentId) {
  return query(
    `SELECT ssl.*, s.name as subject_name
     FROM student_subject_levels ssl
     JOIN subjects s ON s.id = ssl.subject_id
     WHERE ssl.student_id = ?
     ORDER BY s.name ASC`,
    [studentId]
  );
}

async function resetPreAssessment(studentId, subjectId) {
  return withTransaction(async (connection) => {
    // Reset admin pre-assessment result
    await connection.query(
      `DELETE ar FROM assessment_results ar
       JOIN assessments a ON a.id = ar.assessment_id
       WHERE ar.student_id = ? AND a.subject_id = ? AND a.assessment_type = 'pre'`,
      [studentId, subjectId]
    );
    // Delete level assignment
    await connection.query(
      `DELETE FROM student_subject_levels WHERE student_id = ? AND subject_id = ?`,
      [studentId, subjectId]
    );
  });
}

// ============================================================================
// Management upgrade — one import surface
//
// The upgrade's data access lives in focused modules (billing, notifications,
// analytics, anti-cheat, focus handouts) rather than being appended to this
// already very large file. They are re-exported here so a route keeps a single
// import — `require('../lib/data')` — and nothing has to know which file a
// function happens to sit in.
//
// The list is explicit rather than a spread: a silent name collision between two
// modules would be very hard to trace from the call site.
// ============================================================================

const billingLedger = require('./billing');
const appNotifications = require('./appNotifications');
const analytics = require('./analytics');
const violations = require('./violations');
const focusHandouts = require('./focusHandouts');
const rbac = require('./rbac');
const assistantRoster = require('./assistantRoster');

Object.assign(module.exports, {
  getUsersPaged,
  countStudentsNeedingTutor,
  // A tutor teaches only the subjects they teach; lists read back repaired.
  repairNameList,
  tutorTeachesSubject,
  getBlockedSlotsForTutor,
  getSubjectAssessmentsOverview,
  // Never more than is owed (lib/billing.js).
  overpaymentError: billingLedger.overpaymentError,
  exceedsBalance: billingLedger.exceedsBalance,
  // Tutor year levels in the registration form's wording, whichever arrives.
  TUTOR_YEAR_LEVEL_OPTIONS,
  normalizeTutorYearLevels,

  // Who was under which Assistant Admin, kept after the assistant is replaced.
  syncAssistantRosters: assistantRoster.syncAssistantRosters,
  getAssistantRoster: assistantRoster.getAssistantRoster,
  getAssistantRosterCounts: assistantRoster.getAssistantRosterCounts,

  // Billing ledger (Billing 1 -> many PaymentEntries)
  PAYMENT_METHODS: billingLedger.PAYMENT_METHODS,
  PAYMENT_PURPOSES: billingLedger.PAYMENT_PURPOSES,
  STUDENT_PAYMENT_METHODS: billingLedger.STUDENT_PAYMENT_METHODS,
  studentPaymentMethodsFor: billingLedger.studentPaymentMethodsFor,
  cashPaymentLabel: billingLedger.cashPaymentLabel,
  FIRST_PAYMENT_MINIMUM: billingLedger.FIRST_PAYMENT_MINIMUM,
  INSTALMENT_SPLIT: billingLedger.INSTALMENT_SPLIT,
  paymentFloorFor: billingLedger.paymentFloorFor,
  minimumPaymentFor: billingLedger.minimumPaymentFor,
  // The Pre-Assessment down-payment gate (Phase 2.1).
  getDownPaymentStatus: billingLedger.getDownPaymentStatus,
  downPaymentBlockMessage: billingLedger.downPaymentBlockMessage,
  getPaymentEntries: billingLedger.getPaymentEntries,
  getStudentPaymentEntries: billingLedger.getStudentPaymentEntries,
  getBillingLedger: billingLedger.getBillingLedger,
  attachPaymentLedgers: billingLedger.attachLedgers,
  addPaymentEntry: billingLedger.addPaymentEntry,
  updateBillingHeader: billingLedger.updateBillingHeader,
  getPaymentLedger: billingLedger.getPaymentLedger,
  summarisePaymentLedger: billingLedger.summariseLedger,
  getStudentBillingData: billingLedger.getStudentBillingData,

  // Payment requests (student -> admin/assistant)
  createPaymentRequest: billingLedger.createPaymentRequest,
  getPaymentRequestById: billingLedger.getPaymentRequestById,
  getPaymentRequests: billingLedger.getPaymentRequests,
  countPendingPaymentRequests: billingLedger.countPendingPaymentRequests,
  completePaymentRequest: billingLedger.completePaymentRequest,
  cancelPaymentRequest: billingLedger.cancelPaymentRequest,
  getStudentPaymentRequests: billingLedger.getStudentPaymentRequests,

  // In-app notifications
  createAppNotification: appNotifications.createNotification,
  notifyAdminRoles: appNotifications.notifyAdminRoles,
  getAppNotifications: appNotifications.getNotificationsFor,
  countUnreadAppNotifications: appNotifications.countUnreadFor,
  markAppNotificationRead: appNotifications.markRead,
  markOwnAppNotificationRead: appNotifications.markReadByRecipient,
  markAppNotificationReferenceRead: appNotifications.markReferenceRead,
  archiveAppNotification: appNotifications.archiveNotification,

  // Analytics & Reports
  getAnalyticsDashboard: analytics.getAnalyticsDashboard,
  getScopedSubmissions: analytics.getScopedSubmissions,
  getScopedWeakTopics: analytics.getWeakTopics,
  getScopedStudentPerformance: analytics.getStudentPerformance,
  getScopedViolations: analytics.getViolationSummary,

  // Anti-cheating
  MAX_VIOLATIONS: violations.MAX_VIOLATIONS,
  VIOLATION_TYPES: violations.VIOLATION_TYPES,
  recordViolation: violations.recordViolation,
  attachViolationsToSubmission: violations.attachToSubmission,
  markSubmissionAutoSubmitted: violations.markAutoSubmitted,
  getViolationsForSubmission: violations.getViolationsForSubmission,
  getViolationSessionCount: violations.getSessionCount,

  // Auto weak-topic handouts
  runPreAssessmentFollowUp: focusHandouts.runPreAssessmentFollowUp,
  generateFocusHandout: focusHandouts.generateFocusHandout,
  getFocusHandoutById: focusHandouts.getFocusHandoutById,
  getFocusHandoutsForTutor: focusHandouts.getFocusHandoutsForTutor,
  getFocusHandoutsForStudent: focusHandouts.getFocusHandoutsForStudent,
  getFocusHandouts: focusHandouts.getFocusHandouts,
  markFocusHandoutViewed: focusHandouts.markTutorViewed,
  countUnviewedFocusHandouts: focusHandouts.countUnviewedForTutor,

  // Role-based scoping
  resolveScope: rbac.resolveScope,
  canViewAnalytics: rbac.canViewAnalytics,
  canViewFinancials: rbac.canViewFinancials,
  canActOnBranch: rbac.canActOnBranch
});
