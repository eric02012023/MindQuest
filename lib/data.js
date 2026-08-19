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
  generateUserCode,
  allowedContactRoles,
  titleCaseName
} = require('./utils');
const { determineLevel } = require('../config/levelThresholds');

const MONTHLY_FULL_BILL = 1800;
const TUTOR_YEAR_LEVEL_OPTIONS = ['Preschool', 'Primary School', 'Junior High School', 'Senior High School'];
const FIXED_TIME_SLOTS = ['7:00-8:00 AM', '8:00-9:00 AM', '9:00-10:00 AM', '11:00-12:00 PM', '1:00-2:00 PM', '2:00-3:00 PM', '3:00-4:00 PM', '5:00-6:00 PM', '6:00-7:00 PM'];

// Function: normalizeTutorYearLevels

// Role: Provides helper logic for this file.

function normalizeTutorYearLevels(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .flatMap((value) => Array.isArray(value) ? value : String(value || '').split(','))
    .map((value) => String(value || '').trim())
    .filter((value) => TUTOR_YEAR_LEVEL_OPTIONS.includes(value)))];
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


function parseRowArrays(row) {
  if (!row) return row;
  const extra = safeJsonObject(row.extra_json);
  return {
    ...row,
    first_name: titleCaseName(row.first_name),
    middle_name: titleCaseName(row.middle_name),
    last_name: titleCaseName(row.last_name),
    subjects: safeJsonArray(row.subjects_json),
    supports: safeJsonArray(row.support_json),
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

// Function: canonicalizeSubjectNames

// Role: Handles a reusable server-side operation used by this module.

async function canonicalizeSubjectNames(subjectNames = []) {
  const normalizedNames = uniqueNames(subjectNames).map((name) => normalizeSubjectName(name));
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
      const latest = existingRows[existingRows.length - 1];
      await connection.query(
        `UPDATE user_subject_assignments
         SET is_archived = 0, tutor_id = NULL, branch_id = ?, accepted_by = ?, enrolled_at = COALESCE(enrolled_at, DATEADD(hour, 8, GETUTCDATE())), updated_at = DATEADD(hour, 8, GETUTCDATE())
         WHERE id = ?`,
        [branchId || null, adminId || null, latest.id]
      );
      continue;
    }

    await connection.query(
      `INSERT INTO user_subject_assignments (
        student_id, tutor_id, subject_id, branch_id, enrolled_at, assigned_at, accepted_by, is_archived
      ) VALUES (?, NULL, ?, ?, DATEADD(hour, 8, GETUTCDATE()), NULL, ?, 0)`,
      [studentId, Number(subject.id), branchId || null, adminId || null]
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
      await connection.query(
        'UPDATE user_subject_assignments SET tutor_id = NULL, updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?',
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
    `SELECT usa.id, usa.subject_id, s.name AS subject_name, st.branch_id AS student_branch_id, st.year_level AS student_year_level
     FROM user_subject_assignments usa
     INNER JOIN subjects s ON s.id = usa.subject_id
     INNER JOIN users st ON st.id = usa.student_id
     WHERE usa.tutor_id = ? AND usa.is_archived = 0`,
    [tutorId]
  );

  for (const row of rows) {
    const invalidSubject = normalizedNames.size ? !normalizedNames.has(String(row.subject_name || '').trim()) : true;
    const scopeMatch = matchesTutorStudentScope(fallbackTutor, {
      branch_id: row.student_branch_id,
      year_level: row.student_year_level
    });
    if (invalidSubject || !scopeMatch.isMatch) {
      await connection.query(
        'UPDATE user_subject_assignments SET tutor_id = NULL, updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?',
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
  return withTransaction(async (connection) => {
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
      await syncStudentSubjectAssignments(
        connection,
        Number(newUserId),
        safeJsonArray(row.subjects_json),
        row.branch_id ? Number(row.branch_id) : null,
        Number(actor.id)
      );

      await connection.query(
        `INSERT INTO billing (
          student_id, full_bill, partial_payment, for_settlement, payment_due, payment_status, posted_by, notes
        ) VALUES (?, ?, 0.00, ?, ?, 'unpaid', ?, '')`,
        [Number(newUserId), MONTHLY_FULL_BILL, MONTHLY_FULL_BILL, plusOneMonth(new Date()), Number(actor.id)]
      );
    }

    await connection.query('UPDATE submissions SET status = ?, accepted_at = DATEADD(hour, 8, GETUTCDATE()), read_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?', ['accepted', row.id]);
    await connection.query('UPDATE notifications SET is_read = 1, moved_to_history = 1, is_archived = 0 WHERE id = ?', [id]);

    return newUserId;
  });
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

    const incomingYearLevels = uniqueNames(payload.year_levels || []);
    const fallbackYearLevels = getUserYearLevels(user);
    const nextYearLevels = incomingYearLevels.length ? incomingYearLevels : (fallbackYearLevels.length ? fallbackYearLevels : normalizeYearLevels(nextYearLevel));
    if (nextYearLevels.length) {
      nextYearLevel = nextYearLevels.join(', ');
      nextExtra.year_levels = nextYearLevels;
    }
  }

  return withTransaction(async (connection) => {
    await connection.query(
      `UPDATE users SET
        branch_id = ?, first_name = ?, middle_name = ?, last_name = ?, birth_date = ?, age = ?, gender = ?,
        contact_number = ?, email = ?, facebook_account = ?, address = ?, year_level = ?, grade_level = ?,
        parent_guardian_name = ?, parent_contact_number = ?, parent_email = ?, parent_facebook = ?,
        image_path = COALESCE(?, image_path), subjects_json = ?, support_json = ?, extra_json = ?
       WHERE id = ?`,
      [
        nextBranchId,
        titleCaseName(payload.first_name),
        titleCaseName(payload.middle_name || ''),
        titleCaseName(payload.last_name),
        payload.birth_date || null,
        calculateAgeFromBirthDate(payload.birth_date || user.birth_date) || null,
        payload.gender || '',
        payload.contact_number || '',
        payload.email || '',
        payload.facebook_account || '',
        payload.address || '',
        nextYearLevel || '',
        payload.grade_level || '',
        payload.parent_guardian_name || '',
        payload.parent_contact_number || '',
        payload.parent_email || '',
        payload.parent_facebook || '',
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
}

// Function: archiveUser

// Role: Handles a reusable server-side operation used by this module.

async function archiveUser(id, scopeBranchId = null) {
  const user = await getUserById(id);
  if (!user || user.role === 'admin') return false;
  if (scopeBranchId && Number(user.branch_id) !== Number(scopeBranchId)) return false;
  await query('UPDATE users SET is_archived = 1 WHERE id = ?', [id]);
  return true;
}

// Function: recoverUser

// Role: Handles a reusable server-side operation used by this module.

async function recoverUser(id, scopeBranchId = null) {
  const user = await getUserById(id);
  if (!user || user.role === 'admin') return false;
  if (scopeBranchId && Number(user.branch_id) !== Number(scopeBranchId)) return false;
  await query('UPDATE users SET is_archived = 0 WHERE id = ?', [id]);
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
  return withTransaction(async (connection) => {
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
  await query(`UPDATE users SET assistant_scope_branch_id = ?, branch_id = ?, email = ?, password_hash = ?, first_name = ?, last_name = ?, extra_json = ? WHERE id = ?`, [
    payload.branch_id || user.assistant_scope_branch_id,
    payload.branch_id || user.branch_id,
    nextEmail,
    passwordHash,
    branchName || user.first_name,
    'Assistant',
    JSON.stringify({ ...(parseRowArrays(user).extra || {}), visible_password: visiblePassword, assistant_name: titleCaseName(String(payload.assistant_name || '').trim() || (branchName ? `${branchName} Assistant` : nextEmail)) }),
    id
  ]);
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

    await connection.query('DELETE FROM users WHERE id = ?', [id]);
  });

  return true;
}

// Function: getStudentAssignments

// Role: Handles a reusable server-side operation used by this module.

async function getStudentAssignments(studentId) {
  const rows = await query(
    `SELECT usa.*, s.name AS subject_name, t.first_name AS tutor_first_name, t.middle_name AS tutor_middle_name,
            t.last_name AS tutor_last_name, t.id AS tutor_internal_id
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
      // Bug fix: Copy tutor_id and time_slot from existing active assignments so new subjects
      // inherit the student's current tutor instead of showing "Not yet assigned"
      const [existingTutorRows] = await connection.query(
        `SELECT TOP 1 tutor_id, time_slot
         FROM user_subject_assignments
         WHERE student_id = ? AND is_archived = 0 AND tutor_id IS NOT NULL
         ORDER BY assigned_at DESC`,
        [row.student_id]
      );
      const inheritedTutor = existingTutorRows[0] || null;
      await connection.query(
        `INSERT INTO user_subject_assignments (
          student_id, tutor_id, subject_id, branch_id, enrolled_at, assigned_at, accepted_by, is_archived, time_slot
        ) VALUES (?, ?, ?, ?, DATEADD(hour, 8, GETUTCDATE()), ${inheritedTutor ? 'DATEADD(hour, 8, GETUTCDATE())' : 'NULL'}, ?, 0, ?)`,
        [row.student_id, inheritedTutor?.tutor_id || null, row.subject_id, row.branch_id || row.student_branch_id || null, actor.id, inheritedTutor?.time_slot || null]
      );
    }

    const student = await getUserById(row.student_id);
    const currentSubjects = new Set((student.subjects || safeJsonArray(student.subjects_json || '[]')).map((item) => String(item || '').trim()).filter(Boolean));
    currentSubjects.add(row.subject_name);
    await connection.query(
      'UPDATE users SET subjects_json = ?, updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?',
      [JSON.stringify([...currentSubjects]), row.student_id]
    );

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
            st.last_name AS student_last_name, st.year_level, st.grade_level
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

async function getBillingRows(scopeBranchId = null, onlyPaid = false) {
  const statusSql = onlyPaid ? "AND b.payment_status = 'paid'" : "AND b.payment_status <> 'paid'";
  const scope = buildScopeClause(scopeBranchId, 'u.branch_id');
  return query(
    `SELECT b.*, u.id AS student_id, u.user_id, u.first_name, u.middle_name, u.last_name, u.address, u.branch_id, br.name AS branch_name
     FROM billing b
     INNER JOIN users u ON u.id = b.student_id
     LEFT JOIN branches br ON br.id = u.branch_id
     WHERE u.role = 'student' AND u.is_archived = 0 ${statusSql} ${scope.sql}
     ORDER BY u.first_name ASC`,
    scope.params
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

async function updateBilling(studentId, payload, adminId) {
  const currentBill = await getBillingByStudentId(studentId);
  if (!currentBill) throw new Error('Billing record not found.');

  const requestedFullBill = normalizeNumericInput(payload.full_bill);
  const fullBill = requestedFullBill > 0 ? requestedFullBill : Number(currentBill.full_bill || MONTHLY_FULL_BILL);
  const requestedPartial = normalizeNumericInput(payload.partial_payment);
  if (requestedPartial > 0 && requestedPartial < 500) {
    throw new Error('Minimum partial payment is 500.');
  }
  const partialPayment = Math.max(0, Math.min(requestedPartial, fullBill));
  const forSettlement = Math.max(fullBill - partialPayment, 0);
  let status = 'unpaid';
  if (fullBill > 0 && partialPayment > 0 && forSettlement > 0) status = 'partial';
  if (fullBill > 0 && forSettlement === 0) status = 'paid';

  await query(
    `UPDATE billing SET
      full_bill = ?, partial_payment = ?, for_settlement = ?, payment_due = ?,
      payment_status = ?, posted_by = ?, notes = ?, soa_type = COALESCE(?, soa_type),
      soa_posted_at = CASE WHEN ? = 1 THEN DATEADD(hour, 8, GETUTCDATE()) ELSE soa_posted_at END,
      updated_at = DATEADD(hour, 8, GETUTCDATE())
     WHERE student_id = ?`,
    [
      fullBill,
      partialPayment,
      forSettlement,
      payload.payment_due || null,
      status,
      adminId,
      payload.notes || '',
      payload.soa_type || null,
      payload.post_now ? 1 : 0,
      studentId
    ]
  );

  const bill = await getBillingByStudentId(studentId);
  if (bill) {
    const amountLogged = Math.max(partialPayment - Number(currentBill.partial_payment || 0), 0);
    const remarks = [];
    if (Number(currentBill.full_bill || 0) !== fullBill) {
      remarks.push(`Full bill updated from ${Number(currentBill.full_bill || 0).toFixed(2)} to ${fullBill.toFixed(2)}`);
    }
    if (amountLogged > 0) {
      remarks.push(`Partial payment added: ${amountLogged.toFixed(2)}`);
    }
    await query(
      `INSERT INTO payment_history (billing_id, student_id, amount, paid_at, recorded_by, transaction_type, payment_status, balance_after, remarks)
       VALUES (?, ?, ?, DATEADD(hour, 8, GETUTCDATE()), ?, ?, ?, ?, ?)`,
      [
        bill.id,
        studentId,
        amountLogged,
        adminId,
        amountLogged > 0 ? 'partial_payment' : 'billing_update',
        status,
        forSettlement,
        remarks.join(' | ') || 'Billing information updated.'
      ]
    );
  }
}

// Function: markBillPaid

// Role: Handles a reusable server-side operation used by this module.

async function markBillPaid(billingId, adminId) {
  const rows = await query('SELECT TOP 1 * FROM billing WHERE id = ?', [billingId]);
  const bill = rows[0];
  if (!bill) return false;
  if (Number(bill.for_settlement || 0) > 0 || Number(bill.full_bill || 0) <= 0) {
    throw new Error('Student must complete the full payment before marking as paid.');
  }
  const amount = Number(bill.full_bill || 0);
  await query(
    `UPDATE billing SET partial_payment = full_bill, for_settlement = 0.00, payment_status = 'paid', last_paid_at = DATEADD(hour, 8, GETUTCDATE()), posted_by = ? WHERE id = ?`,
    [adminId, billingId]
  );
  await query(
    'INSERT INTO payment_history (billing_id, student_id, amount, paid_at, recorded_by) VALUES (?, ?, ?, DATEADD(hour, 8, GETUTCDATE()), ?)',
    [billingId, bill.student_id, amount, adminId]
  );
  return true;
}

// Function: reenrollStudents

// Role: Handles a reusable server-side operation used by this module.

async function reenrollStudents(studentIds) {
  const ids = (Array.isArray(studentIds) ? studentIds : [studentIds]).map((id) => Number(id)).filter(Boolean);
  if (!ids.length) return false;
  const placeholders = ids.map(() => '?').join(',');
  await query(`UPDATE billing SET
      full_bill = ?,
      payment_status = CASE WHEN partial_payment >= ? THEN 'paid' WHEN partial_payment > 0 THEN 'partial' ELSE 'unpaid' END,
      for_settlement = CASE WHEN ? - partial_payment < 0 THEN 0 ELSE ? - partial_payment END,
      last_paid_at = NULL,
      updated_at = DATEADD(hour, 8, GETUTCDATE())
      WHERE student_id IN (${placeholders})`, [MONTHLY_FULL_BILL, MONTHLY_FULL_BILL, MONTHLY_FULL_BILL, MONTHLY_FULL_BILL, ...ids]);
  return true;
}

// Function: getPaymentHistory

// Role: Handles a reusable server-side operation used by this module.

async function getPaymentHistory(scopeBranchId = null) {
  const scope = buildScopeClause(scopeBranchId, 'u.branch_id');
  return query(
    `SELECT ph.*, u.first_name, u.middle_name, u.last_name, u.user_id, u.branch_id, br.name AS branch_name, b.full_bill
     FROM payment_history ph
     INNER JOIN users u ON u.id = ph.student_id
     LEFT JOIN branches br ON br.id = u.branch_id
     INNER JOIN billing b ON b.id = ph.billing_id
     WHERE 1=1 ${scope.sql}
     ORDER BY ph.paid_at DESC`,
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

async function getStudentBillingView(studentId) {
  const bill = await getBillingByStudentId(studentId);
  const statements = await query('SELECT * FROM soa_posts WHERE student_id = ? ORDER BY created_at DESC', [studentId]);
  const paymentHistory = await query(`SELECT ph.*, b.full_bill, b.payment_status
    FROM payment_history ph
    LEFT JOIN billing b ON b.id = ph.billing_id
    WHERE ph.student_id = ? ORDER BY ph.paid_at DESC, ph.id DESC`, [studentId]);
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
    const selectedSubjects = safeJsonArray(user.subjects_json);
    const archivedSubjects = safeJsonArray(user.extra?.archived_subjects || []);
    if (user.role === 'tutor' && subject && selectedSubjects.includes(subject.name) && !archivedSubjects.includes(subject.name)) {
      tutors.push(user);
    }
  }

  const assignmentScope = scopeBranchId ? 'AND u.branch_id = ?' : '';
  const rows = await query(
    `SELECT usa.*, u.user_id, u.first_name, u.middle_name, u.last_name, u.branch_id, u.year_level, u.grade_level,
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
  const subjectKey = normalizeSubjectName(subject.name);
  const tutorSubjects = new Set(safeJsonArray(tutor.subjects_json || tutor.subjects || []).map((name) => normalizeSubjectName(name)));
  const archivedTutorSubjects = new Set(safeJsonArray(tutor.extra?.archived_subjects || []).map((name) => normalizeSubjectName(name)));
  if (!tutorSubjects.has(subjectKey) || archivedTutorSubjects.has(subjectKey)) {
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
  const subjects = safeJsonArray(row.subjects_json).filter((name) => name !== row.subject_name);
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
  const subjects = safeJsonArray(row.subjects_json);
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
  const subjects = safeJsonArray(user.subjects_json).filter((name) => name !== subject.name);
  const archived = safeJsonArray(user.extra?.archived_subjects || []);
  if (!archived.includes(subject.name)) archived.push(subject.name);
  await query('UPDATE users SET subjects_json = ?, extra_json = ? WHERE id = ?', [JSON.stringify(subjects), JSON.stringify({ ...user.extra, archived_subjects: archived }), tutorId]);
}

// Function: recoverTutorSubject

// Role: Handles a reusable server-side operation used by this module.

async function recoverTutorSubject(subjectId, tutorId) {
  const [subject, user] = await Promise.all([getSubjectById(subjectId), getUserById(tutorId)]);
  if (!subject || !user) return;
  const subjects = safeJsonArray(user.subjects_json);
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
    const tutorSubjectNames = safeJsonArray(tutor.subjects_json || tutor.subjects || [])
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
    `SELECT usa.*, s.name AS subject_name, u.id AS student_id, u.user_id, u.first_name, u.middle_name, u.last_name, u.year_level, u.grade_level, u.branch_id, b.name AS branch_name
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
    `SELECT TOP 1 a.*, s.name AS subject_name, at.title AS template_title, u.user_id, u.first_name, u.middle_name, u.last_name, u.branch_id
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

async function getTutorAvailabilityForStudent(studentId) {
  // Returns tutors available for this student (branch-filtered), deduplicated across all enrolled subjects
  const student = await getUserById(studentId);
  if (!student) return [];

  const assignments = await getStudentAssignments(studentId);
  if (!assignments.length) return [];

  // Collect all tutors across enrolled subjects filtered by student branch
  const tutorMap = new Map();
  for (const assignment of assignments) {
    const tutors = await getSubjectMembers(assignment.subject_id, student.branch_id).then((data) => data.tutors || []);
    for (const tutor of tutors) {
      if (!tutorMap.has(tutor.id)) tutorMap.set(tutor.id, tutor);
    }
  }
  const allTutors = Array.from(tutorMap.values());

  const activeRows = await query(
    `SELECT tsa.*, u.first_name, u.middle_name, u.last_name
     FROM tutor_schedule_applications tsa
     INNER JOIN users u ON u.id = tsa.tutor_id
     WHERE tsa.branch_id = ? AND tsa.status IN ('pending','accepted')`,
    [student.branch_id || null]
  );

  return allTutors.map((tutor) => {
    const tutorRows = activeRows.filter((row) => Number(row.tutor_id) === Number(tutor.id));
    const taken = new Set(tutorRows.filter((row) => String(row.status).toLowerCase() === 'accepted').map((row) => row.time_slot));
    const pendingBySlot = new Set(tutorRows.filter((row) => String(row.status).toLowerCase() === 'pending').map((row) => row.time_slot));
    return {
      ...tutor,
      available_slots: FIXED_TIME_SLOTS.filter((slot) => !taken.has(slot) && !pendingBySlot.has(slot)),
      unavailable_slots: FIXED_TIME_SLOTS.filter((slot) => taken.has(slot) || pendingBySlot.has(slot))
    };
  });
}

// Function: createTutorScheduleApplication

// Role: Handles a reusable server-side operation used by this module.

async function createTutorScheduleApplication(studentId, subjectId, tutorId, timeSlot) {
  return withTransaction(async (connection) => {
    const [assignmentRows] = await connection.query(
      `SELECT TOP 1 * FROM user_subject_assignments WHERE student_id = ? AND subject_id = ? AND is_archived = 0`,
      [studentId, subjectId]
    );
    const assignment = assignmentRows[0];
    if (!assignment) throw new Error('You are not enrolled in this subject.');
    const student = await getUserById(studentId);
    const tutor = await getUserById(tutorId);
    if (!student || !tutor || tutor.role !== 'tutor') throw new Error('Tutor not found.');
    if (String(student.branch_id || '') !== String(tutor.branch_id || '')) throw new Error('You can only apply to tutors in your branch.');
    if (!FIXED_TIME_SLOTS.includes(timeSlot)) throw new Error('Invalid time slot selected.');

    const [slotTakenRows] = await connection.query(
      `SELECT TOP 1 id FROM tutor_schedule_applications
       WHERE tutor_id = ? AND time_slot = ? AND status IN ('pending','accepted')`,
      [tutorId, timeSlot]
    );
    if (slotTakenRows.length) throw new Error('That time slot is no longer available.');

    const [existingAcceptedRows] = await connection.query(
      `SELECT TOP 1 id FROM tutor_schedule_applications
       WHERE student_id = ? AND status = 'accepted'`,
      [studentId]
    );
    if (existingAcceptedRows.length) throw new Error('You already have an accepted tutor schedule.');

    const [existingPendingRows] = await connection.query(
      `SELECT TOP 1 id FROM tutor_schedule_applications
       WHERE student_id = ? AND status = 'pending'`,
      [studentId]
    );
    if (existingPendingRows.length) throw new Error('You already have a pending tutor application.');

    await connection.query(
      `INSERT INTO tutor_schedule_applications (student_id, tutor_id, subject_id, branch_id, time_slot, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', DATEADD(hour, 8, GETUTCDATE()), DATEADD(hour, 8, GETUTCDATE()))`,
      [studentId, tutorId, subjectId, student.branch_id || tutor.branch_id || null, timeSlot]
    );
    return true;
  });
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

    const [takenRows] = await connection.query(
      `SELECT TOP 1 id FROM tutor_schedule_applications WHERE tutor_id = ? AND time_slot = ? AND status = 'accepted' AND id <> ?`,
      [app.tutor_id, app.time_slot, app.id]
    );
    if (takenRows.length) throw new Error('This schedule was already taken.');

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

    await connection.query(
      `UPDATE user_subject_assignments
       SET tutor_id = ?, time_slot = ?, assigned_at = DATEADD(hour, 8, GETUTCDATE()), accepted_by = ?, updated_at = DATEADD(hour, 8, GETUTCDATE())
       WHERE student_id = ? AND is_archived = 0`,
      [app.tutor_id, app.time_slot, tutorId, app.student_id]
    );
    return true;
  });
}

// Function: createTutorScheduleApplicationForAllSubjects

// Role: Handles a reusable server-side operation used by this module.

async function createTutorScheduleApplicationForAllSubjects(studentId, tutorId, timeSlot) {
  // Apply tutor + time slot across ALL enrolled subjects of the student
  return withTransaction(async (connection) => {
    const student = await getUserById(studentId);
    const tutor = await getUserById(tutorId);
    if (!student || !tutor || tutor.role !== 'tutor') throw new Error('Tutor not found.');
    if (String(student.branch_id || '') !== String(tutor.branch_id || '')) throw new Error('You can only apply to tutors in your branch.');
    if (!FIXED_TIME_SLOTS.includes(timeSlot)) throw new Error('Invalid time slot selected.');

    const [slotTakenRows] = await connection.query(
      `SELECT TOP 1 id FROM tutor_schedule_applications WHERE tutor_id = ? AND time_slot = ? AND status IN ('pending','accepted')`,
      [tutorId, timeSlot]
    );
    if (slotTakenRows.length) throw new Error('That time slot is no longer available.');

    const [existingAcceptedRows] = await connection.query(
      `SELECT TOP 1 id FROM tutor_schedule_applications WHERE student_id = ? AND status = 'accepted'`,
      [studentId]
    );
    if (existingAcceptedRows.length) throw new Error('You already have an accepted tutor schedule.');

    const [existingPendingRows] = await connection.query(
      `SELECT TOP 1 id FROM tutor_schedule_applications WHERE student_id = ? AND status = 'pending'`,
      [studentId]
    );
    if (existingPendingRows.length) throw new Error('You already have a pending tutor application.');

    // Get the student's enrolled subjects
    const [assignmentRows] = await connection.query(
      `SELECT usa.subject_id FROM user_subject_assignments usa WHERE usa.student_id = ? AND usa.is_archived = 0`,
      [studentId]
    );
    if (!assignmentRows.length) throw new Error('You have no enrolled subjects.');

    // Use the first enrolled subject for the application record (tutor acceptance applies to all subjects)
    const subjectId = assignmentRows[0].subject_id;

    await connection.query(
      `INSERT INTO tutor_schedule_applications (student_id, tutor_id, subject_id, branch_id, time_slot, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', DATEADD(hour, 8, GETUTCDATE()), DATEADD(hour, 8, GETUTCDATE()))`,
      [studentId, tutorId, subjectId, student.branch_id || tutor.branch_id || null, timeSlot]
    );
    return true;
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

async function getTutorScheduleOverview(tutorId) {
  const rows = await query(
    `SELECT tsa.*, st.first_name AS student_first_name, st.middle_name AS student_middle_name, st.last_name AS student_last_name,
            s.name AS subject_name
     FROM tutor_schedule_applications tsa
     LEFT JOIN users st ON st.id = tsa.student_id
     LEFT JOIN subjects s ON s.id = tsa.subject_id
     WHERE tsa.tutor_id = ? AND tsa.status IN ('accepted', 'ongoing')
     ORDER BY tsa.time_slot ASC, tsa.updated_at DESC`,
    [tutorId]
  );
  const acceptedBySlot = new Map(rows.map((row) => [row.time_slot, row]));
  return FIXED_TIME_SLOTS.map((slot) => {
    const hit = acceptedBySlot.get(slot);
    return {
      time_slot: slot,
      status: hit ? `Taken by ${fullName({ first_name: hit.student_first_name, middle_name: hit.student_middle_name, last_name: hit.student_last_name })}` : 'Available',
      raw_status: hit ? String(hit.status).toLowerCase() : 'available',
      application_id: hit ? hit.id : null,
      student_name: hit ? fullName({ first_name: hit.student_first_name, middle_name: hit.student_middle_name, last_name: hit.student_last_name }) : '',
      subject_name: hit ? hit.subject_name : ''
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
async function markModuleRead(studentId, resourceId, subjectId) {
  const existing = await query(
    'SELECT TOP 1 id FROM module_reads WHERE student_id = ? AND resource_id = ?',
    [studentId, resourceId]
  );
  if (!existing.length) {
    await query(
      'INSERT INTO module_reads (student_id, resource_id, subject_id) VALUES (?, ?, ?)',
      [studentId, resourceId, subjectId]
    );
  }
  return true;
}

// Function: getModuleReads
// Role: Returns all module reads for a student in a subject
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
async function getStudentAnalytics(studentId, subjectId) {
  const student = await getUserById(studentId);
  const subject = await getSubjectById(subjectId);
  if (!student || !subject) return null;

  const moduleReads = await getModuleReads(studentId, subjectId);

  const assessmentRows = await query(
    `SELECT a.*, ar.score, ar.total_questions, ar.percentage, ar.level, ar.taken_at, ar.answers_json
     FROM assessments a
     LEFT JOIN assessment_results ar ON ar.assessment_id = a.id AND ar.student_id = a.assigned_student_id
     WHERE a.assigned_student_id = ? AND a.subject_id = ?
     ORDER BY COALESCE(ar.taken_at, a.created_at) DESC`,
    [studentId, subjectId]
  );

  const attempts = await query(
    `SELECT aa.*
     FROM assessment_attempts aa
     INNER JOIN assessments a ON a.id = aa.assessment_id
     WHERE aa.student_id = ? AND a.subject_id = ?
     ORDER BY aa.created_at DESC`,
    [studentId, subjectId]
  );

  const antiCheatLogs = await query(
    `SELECT acl.*
     FROM assessment_anti_cheat_logs acl
     INNER JOIN assessments a ON a.id = acl.assessment_id
     WHERE acl.student_id = ? AND a.subject_id = ?
     ORDER BY acl.created_at DESC`,
    [studentId, subjectId]
  );

  const learningCycles = await query(
    `SELECT slc.*
     FROM student_learning_cycles slc
     WHERE slc.student_id = ? AND slc.subject_id = ?
     ORDER BY slc.round_number DESC`,
    [studentId, subjectId]
  );

  const avgPercentage = assessmentRows.filter((r) => r.percentage != null).length
    ? (assessmentRows.filter((r) => r.percentage != null).reduce((sum, r) => sum + Number(r.percentage || 0), 0) / assessmentRows.filter((r) => r.percentage != null).length)
    : 0;
  const currentLevel = scoreToLevel(avgPercentage);

  return {
    student,
    subject,
    moduleReads,
    assessments: assessmentRows,
    attempts,
    antiCheatLogs,
    learningCycles,
    stats: {
      totalModulesRead: moduleReads.length,
      totalAssessments: assessmentRows.length,
      completedAssessments: assessmentRows.filter((r) => r.taken_at).length,
      totalAttempts: attempts.length,
      totalViolations: antiCheatLogs.length,
      avgPercentage: Number(avgPercentage.toFixed(2)),
      currentLevel,
      currentRound: learningCycles.length ? Math.max(...learningCycles.map((c) => c.round_number)) : 0
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
async function getActiveLearningCycle(studentId, subjectId) {
  const rows = await query(
    `SELECT TOP 1 slc.*, sr.title AS resource_title, a.title AS assessment_title
     FROM student_learning_cycles slc
     LEFT JOIN subject_resources sr ON sr.id = slc.resource_id
     LEFT JOIN assessments a ON a.id = slc.assessment_id
     WHERE slc.student_id = ? AND slc.subject_id = ? AND slc.status <> 'completed'
     ORDER BY slc.round_number DESC`,
    [studentId, subjectId]
  );
  return rows[0] || null;
}

// Function: createLearningCycle
// Role: Creates a new learning cycle entry (student reads module → takes assessment → AI generates next)
async function createLearningCycle(studentId, subjectId, resourceId, roundNumber = 1) {
  const result = await query(
    `INSERT INTO student_learning_cycles (student_id, subject_id, resource_id, round_number, status, started_at)
     VALUES (?, ?, ?, ?, 'reading', DATEADD(hour, 8, GETUTCDATE()))`,
    [studentId, subjectId, resourceId, roundNumber]
  );
  return result.insertId;
}

// Function: advanceLearningCycle
// Role: Advances a learning cycle to the next status
async function advanceLearningCycle(cycleId, updates = {}) {
  const setClauses = ['updated_at = DATEADD(hour, 8, GETUTCDATE())'];
  const params = [];
  if (updates.status) { setClauses.push('status = ?'); params.push(updates.status); }
  if (updates.assessment_id) { setClauses.push('assessment_id = ?'); params.push(updates.assessment_id); }
  if (updates.attempt_id) { setClauses.push('attempt_id = ?'); params.push(updates.attempt_id); }
  if (updates.result_level) { setClauses.push('result_level = ?'); params.push(updates.result_level); }
  if (updates.next_due_at) { setClauses.push('next_due_at = ?'); params.push(updates.next_due_at); }
  if (updates.completed_at) { setClauses.push('completed_at = ?'); params.push(updates.completed_at); }
  params.push(cycleId);
  await query(`UPDATE student_learning_cycles SET ${setClauses.join(', ')} WHERE id = ?`, params);
}

// Function: createOnlinePayment
// Role: Creates a mock online payment record
async function createOnlinePayment(studentId, amount, options = {}) {
  const bill = await getBillingByStudentId(studentId);
  if (!bill) throw new Error('No billing record found.');
  if (amount <= 0) throw new Error('Payment amount must be greater than zero.');
  if (amount < 500) throw new Error('Minimum online payment is ₱500.');
  const forSettlement = Number(bill.for_settlement || 0);
  if (amount > forSettlement) throw new Error(`Payment amount cannot exceed the remaining balance of ₱${forSettlement.toFixed(2)}.`);

  const providerRef = 'MQ-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8).toUpperCase();
  const result = await query(
    `INSERT INTO online_payments (student_id, billing_id, amount, payment_method, provider, provider_reference, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, 'processing', ?)`,
    [studentId, bill.id, amount, options.payment_method || 'online', options.provider || 'MindQuest Mock Pay', providerRef, options.notes || '']
  );
  return { paymentId: result.insertId, providerReference: providerRef };
}

// Function: completeOnlinePayment
// Role: Completes a mock online payment and applies it to billing
async function completeOnlinePayment(paymentId) {
  const rows = await query('SELECT TOP 1 * FROM online_payments WHERE id = ?', [paymentId]);
  const payment = rows[0];
  if (!payment) throw new Error('Payment not found.');
  if (payment.status === 'completed') throw new Error('Payment already completed.');

  // Update payment status
  await query(
    `UPDATE online_payments SET status = 'completed', paid_at = DATEADD(hour, 8, GETUTCDATE()), updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?`,
    [paymentId]
  );

  // Apply to billing
  const bill = await getBillingByStudentId(payment.student_id);
  if (bill) {
    const newPartial = Math.min(Number(bill.partial_payment || 0) + Number(payment.amount), Number(bill.full_bill || 0));
    const newSettlement = Math.max(Number(bill.full_bill || 0) - newPartial, 0);
    let newStatus = 'unpaid';
    if (newPartial > 0 && newSettlement > 0) newStatus = 'partial';
    if (newSettlement === 0) newStatus = 'paid';

    await query(
      `UPDATE billing SET partial_payment = ?, for_settlement = ?, payment_status = ?, updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE student_id = ?`,
      [newPartial, newSettlement, newStatus, payment.student_id]
    );

    // Record in payment_history
    await query(
      `INSERT INTO payment_history (billing_id, student_id, amount, paid_at, recorded_by, transaction_type, payment_status, balance_after, remarks, payment_method, provider_reference)
       VALUES (?, ?, ?, DATEADD(hour, 8, GETUTCDATE()), NULL, 'online_payment', ?, ?, ?, 'online', ?)`,
      [bill.id, payment.student_id, payment.amount, newStatus, newSettlement, 'Online payment via ' + (payment.provider || 'MindQuest Mock Pay'), payment.provider_reference]
    );
  }
  return true;
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
async function createAssessmentRequest(studentId, subjectId, resourceId) {
  // Find the tutor assigned to this student for this subject
  const assignments = await query(
    `SELECT TOP 1 usa.tutor_id FROM user_subject_assignments usa
     WHERE usa.student_id = ? AND usa.subject_id = ? AND usa.is_archived = 0 AND usa.tutor_id IS NOT NULL`,
    [studentId, subjectId]
  );
  if (!assignments.length || !assignments[0].tutor_id) {
    throw new Error('No tutor assigned for this subject. Please wait for admin to assign a tutor.');
  }
  const tutorId = assignments[0].tutor_id;

  // Check for existing pending request
  const existing = await query(
    `SELECT TOP 1 id FROM assessment_requests
     WHERE student_id = ? AND subject_id = ? AND resource_id = ? AND status = 'pending'`,
    [studentId, subjectId, resourceId]
  );
  if (existing.length) {
    throw new Error('You already have a pending assessment request for this module. Please wait for tutor approval.');
  }

  const result = await query(
    `INSERT INTO assessment_requests (student_id, tutor_id, subject_id, resource_id, status)
     VALUES (?, ?, ?, ?, 'pending')`,
    [studentId, tutorId, subjectId, resourceId]
  );
  return { requestId: result.insertId, tutorId };
}

// Function: getAssessmentRequestsForTutor
// Role: Returns pending assessment requests for a tutor
async function getAssessmentRequestsForTutor(tutorId) {
  return query(
    `SELECT ar.*, s.name AS subject_name, sr.title AS module_title,
            u.first_name AS student_first_name, u.middle_name AS student_middle_name,
            u.last_name AS student_last_name, u.user_id AS student_user_id,
            b.name AS branch_name
     FROM assessment_requests ar
     INNER JOIN users u ON u.id = ar.student_id
     INNER JOIN subjects s ON s.id = ar.subject_id
     LEFT JOIN subject_resources sr ON sr.id = ar.resource_id
     LEFT JOIN branches b ON b.id = u.branch_id
     WHERE ar.tutor_id = ?
     ORDER BY CASE ar.status WHEN 'pending' THEN 0 ELSE 1 END, ar.requested_at DESC`,
    [tutorId]
  );
}

// Function: getAssessmentRequestsForStudent
// Role: Returns assessment requests for a student
async function getAssessmentRequestsForStudent(studentId) {
  return query(
    `SELECT ar.*, s.name AS subject_name, sr.title AS module_title,
            t.first_name AS tutor_first_name, t.last_name AS tutor_last_name
     FROM assessment_requests ar
     INNER JOIN subjects s ON s.id = ar.subject_id
     LEFT JOIN subject_resources sr ON sr.id = ar.resource_id
     LEFT JOIN users t ON t.id = ar.tutor_id
     WHERE ar.student_id = ?
     ORDER BY ar.requested_at DESC`,
    [studentId]
  );
}

// Function: respondToAssessmentRequest
// Role: Tutor accepts or declines a student assessment request
async function respondToAssessmentRequest(requestId, tutorId, action, message = '', itemCount = null) {
  const rows = await query('SELECT TOP 1 * FROM assessment_requests WHERE id = ? AND tutor_id = ?', [requestId, tutorId]);
  if (!rows.length) throw new Error('Assessment request not found.');
  if (rows[0].status !== 'pending') throw new Error('This request has already been responded to.');

  const status = action === 'accept' ? 'accepted' : 'declined';
  const updateFields = itemCount
    ? `UPDATE assessment_requests SET status = ?, responded_at = DATEADD(hour, 8, GETUTCDATE()), tutor_message = ?, item_count = ?, updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?`
    : `UPDATE assessment_requests SET status = ?, responded_at = DATEADD(hour, 8, GETUTCDATE()), tutor_message = ?, updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE id = ?`;
  const updateParams = itemCount
    ? [status, message || null, itemCount, requestId]
    : [status, message || null, requestId];
  await query(updateFields, updateParams);
  return rows[0];
}

// Function: getAcceptedAssessmentRequest
// Role: Check if a student has an accepted request for a specific module
async function getAcceptedAssessmentRequest(studentId, subjectId, resourceId) {
  const rows = await query(
    `SELECT TOP 1 * FROM assessment_requests
     WHERE student_id = ? AND subject_id = ? AND resource_id = ? AND status = 'accepted'
     ORDER BY responded_at DESC`,
    [studentId, subjectId, resourceId]
  );
  return rows[0] || null;
}

// ============================================================================
// Phase 3: Admin/Assistant/Tutor Analytics & Reports
// ============================================================================

// Function: getAllStudentsForAnalytics
// Role: Returns all students with analytics data for admin/assistant reports
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
  if (amount < 500) throw new Error('Minimum online payment is ₱500.');
  const forSettlement = Number(bill.for_settlement || 0);
  if (amount > forSettlement) throw new Error(`Payment amount cannot exceed the remaining balance of ₱${forSettlement.toFixed(2)}.`);

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
            description: `Tuition payment for Student ID: ${studentId}`,
            send_email_receipt: true,
            success_url: `${process.env.APP_URL || 'http://localhost:3000'}/student/billing?payment=success`,
            cancel_url: `${process.env.APP_URL || 'http://localhost:3000'}/student/billing?payment=cancelled`,
            metadata: { student_id: String(studentId), billing_id: String(bill.id) }
          }
        }
      };

      if (billingInfo.email) {
        payload.data.attributes.billing = {
          name: billingInfo.name || '',
          email: billingInfo.email || '',
          phone: billingInfo.phone || ''
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
  markModuleRead,
  getModuleReads,
  getStudentAnalytics,
  createAssessmentAttempt,
  logAntiCheatEvent,
  getAntiCheatViolationCount,
  getStudentLearningCycles,
  getActiveLearningCycle,
  createLearningCycle,
  advanceLearningCycle,
  createOnlinePayment,
  completeOnlinePayment,
  getOnlinePayments,
  logAiGeneration,
  scoreToLevel,
  // Phase 3: Assessment requests, analytics, PayMongo
  createAssessmentRequest,
  getAssessmentRequestsForTutor,
  getAssessmentRequestsForStudent,
  respondToAssessmentRequest,
  getAcceptedAssessmentRequest,
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
  getModuleHandouts,
  addModuleHandouts,
  archiveModuleHandout,
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
  getTutorAssessmentById,
  getTutorAssessmentQuestions,
  addTutorAssessmentQuestion,
  submitTutorAssessment,
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
async function createSubjectModule(data = {}) {
  const { subject_id, title, description, target_year_levels, uploaded_by } = data;
  if (!subject_id) throw new Error('Subject is required.');

  const targets = sanitizeModuleTargets(target_year_levels);

  return withTransaction(async (connection) => {
    const [maxRows] = await connection.query(
      'SELECT ISNULL(MAX(order_number), 0) AS max_order FROM modules WHERE subject_id = ?',
      [subject_id]
    );
    const nextOrder = Number(maxRows[0]?.max_order || 0) + 1;
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
  return query(
    `UPDATE modules
        SET title = ?, description = ?, target_year_levels_json = ?,
            updated_at = DATEADD(hour, 8, GETUTCDATE())
      WHERE id = ?`,
    [String(data.title || '').trim(), String(data.description || '').trim(), JSON.stringify(targets), moduleId]
  );
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

async function createTutorAssessment(data) {
  return withTransaction(async (connection) => {
    const { subject_id, module_id, tutor_id, title, instructions, purpose, questions } = data;
    
    const [res] = await connection.query(
      `INSERT INTO tutor_assessments (subject_id, module_id, tutor_id, title, instructions, purpose) VALUES (?, ?, ?, ?, ?, ?)`,
      [subject_id, module_id, tutor_id, title, instructions, purpose]
    );
    const assessmentId = res.insertId;

    for (const q of questions) {
      const [qRes] = await connection.query(
        `INSERT INTO tutor_assessment_questions (assessment_id, question_text, question_type, points, correct_answer, explanation) VALUES (?, ?, ?, ?, ?, ?)`,
        [assessmentId, q.question_text, q.question_type, q.points || 1, q.correct_answer, q.explanation]
      );
      
      if (q.question_type === 'multiple_choice' && q.options) {
        for (const opt of q.options) {
          await connection.query(
            `INSERT INTO tutor_question_options (question_id, option_label, option_text) VALUES (?, ?, ?)`,
            [qRes.insertId, opt.option_label, opt.option_text]
          );
        }
      }
    }
    return assessmentId;
  });
}

async function getTutorAssessmentsByModule(moduleId) {
  return query(`SELECT * FROM tutor_assessments WHERE module_id = ? AND is_archived = 0 ORDER BY created_at ASC`, [moduleId]);
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

async function submitTutorAssessment(data) {
  return withTransaction(async (connection) => {
    const { assessment_id, student_id, answers } = data; // answers: [{ question_id, student_answer }]
    
    const [existing] = await connection.query(
      `SELECT id FROM tutor_assessment_submissions WHERE assessment_id = ? AND student_id = ?`,
      [assessment_id, student_id]
    );
    if (existing.length > 0) throw new Error("Assessment already submitted.");
    
    // Grade answers
    const questions = await connection.query(`SELECT * FROM tutor_assessment_questions WHERE assessment_id = ?`, [assessment_id]);
    let totalScore = 0;
    let totalPoints = 0;
    const processedAnswers = [];
    
    for (const q of questions) {
      const studentAnsObj = answers.find(a => Number(a.question_id) === Number(q.id));
      const studentAnsText = studentAnsObj ? String(studentAnsObj.student_answer || '').trim() : '';
      
      let isCorrect = false;
      if (q.question_type === 'fill_blank') {
        isCorrect = studentAnsText.toLowerCase() === String(q.correct_answer).trim().toLowerCase();
      } else {
        isCorrect = studentAnsText === String(q.correct_answer).trim();
      }
      
      const pointsEarned = isCorrect ? q.points : 0;
      totalScore += pointsEarned;
      totalPoints += q.points;
      
      processedAnswers.push({
        question_id: q.id,
        student_answer: studentAnsText,
        correct_answer: q.correct_answer,
        is_correct: isCorrect,
        points_earned: pointsEarned
      });
    }
    
    const percentage = totalPoints > 0 ? (totalScore / totalPoints) * 100 : 0;
    
    const [subRes] = await connection.query(
      `INSERT INTO tutor_assessment_submissions (assessment_id, student_id, score, total_points, percentage) VALUES (?, ?, ?, ?, ?)`,
      [assessment_id, student_id, totalScore, totalPoints, percentage]
    );
    const submissionId = subRes.insertId;
    
    for (const pa of processedAnswers) {
      await connection.query(
        `INSERT INTO tutor_student_answers (submission_id, question_id, student_answer, correct_answer, is_correct, points_earned) VALUES (?, ?, ?, ?, ?, ?)`,
        [submissionId, pa.question_id, pa.student_answer, pa.correct_answer, pa.is_correct ? 1 : 0, pa.points_earned]
      );
    }
    
    return { submissionId, score: totalScore, total: totalPoints, percentage };
  });
}

async function getStudentSubmissions(studentId, subjectId) {
  return query(
    `SELECT tas.*, ta.title, ta.purpose, m.level, m.title as module_title
     FROM tutor_assessment_submissions tas
     JOIN tutor_assessments ta ON ta.id = tas.assessment_id
     JOIN modules m ON m.id = ta.module_id
     WHERE tas.student_id = ? AND ta.subject_id = ?
     ORDER BY tas.submitted_at DESC`,
    [studentId, subjectId]
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

async function getStudentResultsAdmin() {
  return query(
    `SELECT tas.*, ta.title as assessment_title, ta.purpose, m.level, s.name as subject_name, u.first_name, u.last_name
     FROM tutor_assessment_submissions tas
     JOIN tutor_assessments ta ON ta.id = tas.assessment_id
     JOIN modules m ON m.id = ta.module_id
     JOIN subjects s ON s.id = ta.subject_id
     JOIN users u ON u.id = tas.student_id
     ORDER BY tas.submitted_at DESC`
  );
}

async function getTutorStudentResults(tutorId) {
  return query(
    `SELECT tas.*, ta.title as assessment_title, ta.purpose, m.level, s.name as subject_name, u.first_name, u.last_name
     FROM tutor_assessment_submissions tas
     JOIN tutor_assessments ta ON ta.id = tas.assessment_id
     JOIN modules m ON m.id = ta.module_id
     JOIN subjects s ON s.id = ta.subject_id
     JOIN users u ON u.id = tas.student_id
     WHERE ta.tutor_id = ?
     ORDER BY tas.submitted_at DESC`,
    [tutorId]
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
