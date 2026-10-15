/**
 * File: lib/reportsCsv.js
 * Purpose: The Analytics & Reports tables as CSV files, so the office can open
 * them in Excel, print them, or hand them to someone.
 *
 * The rows come from the same functions the page uses (lib/analytics.js), after
 * the same scope and the same filters, so the file says exactly what the screen
 * says — and a tutor, assistant or student gets only what they could see anyway.
 */

const { toInputDate } = require('./utils');

/**
 * One CSV cell. A text that starts with = + - @ (or a tab or return) would be run
 * as a formula by a spreadsheet — a learner's name is typed by a stranger — so it
 * gets a leading apostrophe. Numbers are written as they are.
 */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * @param {Array<{label:string, value:(row:object)=>any}>} columns
 * @param {Array<object>} rows
 * @returns {string} UTF-8 with a byte-order mark, so Excel reads the accents and
 *                   the peso sign correctly
 */
function toCsv(columns, rows) {
  const header = columns.map((column) => csvCell(column.label)).join(',');
  const lines = rows.map((row) => columns.map((column) => csvCell(column.value(row))).join(','));
  return `﻿${[header, ...lines].join('\r\n')}\r\n`;
}

// The calendar day the page shows for it (formatDate reads dates the same way),
// so a file and the screen never disagree by a day.
const fullDate = (value) => toInputDate(value) || '';

/** The user registry: one line per account. */
function registryCsv(rows = []) {
  return toCsv([
    { label: 'User ID', value: (row) => row.user_id },
    { label: 'Name', value: (row) => row.name },
    { label: 'Role', value: (row) => row.role_label },
    { label: 'Branch', value: (row) => row.branch_name },
    { label: 'Year / grade level', value: (row) => row.level },
    { label: 'Email', value: (row) => row.email },
    { label: 'Contact number', value: (row) => row.contact_number },
    { label: 'Subjects', value: (row) => row.subjects.join('; ') },
    { label: 'Status', value: (row) => row.status },
    { label: 'Joined', value: (row) => fullDate(row.joined_at) }
  ], rows);
}

/** Student progress: one line per learner and subject. */
function progressCsv(rows = []) {
  const name = (row) => [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(' ');
  return toCsv([
    { label: 'Student ID', value: (row) => row.student_code },
    { label: 'Learner', value: name },
    { label: 'Branch', value: (row) => row.branch_name },
    { label: 'Grade level', value: (row) => row.grade_level || row.year_level },
    { label: 'Subject', value: (row) => row.subject_name },
    { label: 'Pre-Assessment %', value: (row) => row.pre },
    { label: 'Module activities average %', value: (row) => row.module_average },
    { label: 'Post-Assessment %', value: (row) => row.post },
    { label: 'Change (points)', value: (row) => row.change },
    { label: 'Level before', value: (row) => row.pre_level },
    { label: 'Level after', value: (row) => row.post_level },
    { label: 'Modules opened', value: (row) => row.modules_opened },
    { label: 'Modules in grade', value: (row) => row.modules_total },
    { label: 'Status', value: (row) => row.status }
  ], rows);
}

module.exports = { csvCell, toCsv, registryCsv, progressCsv };
