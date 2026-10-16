/**
 * File: lib/postWindow.js
 * Purpose: A student's month in a subject — when its Post-Assessment opens, and
 * when the month is over.
 *
 * One rule for the student's pages (lib/data.js) and the reports
 * (lib/analytics.js), which cannot require each other — so it lives here.
 *
 * The month runs from the day the subject was taken out to its LAST DAY, one
 * month on: enrolled 15 September, the last day is 15 October.
 *
 * The Post-Assessment opens at 12:01 AM, Manila time, on that last day — on its
 * own, with nobody pressing a button. Before that a student cannot take it. It
 * does not close: a student who has not taken it can take it later.
 *
 * The month is over at 12:00 AM on the day after the last day (16 October). From
 * then the subject stays as it was: a module, a handout or an assessment added
 * later is not part of it (addedInMonth), and the student can still answer what
 * was left in it, for as long as they like. Once nothing is left, the subject is
 * theirs to view only (lib/data.js, subjectMonthState).
 */

const { atAppTime, plusOneMonth, toInputDate } = require('./utils');

const POST_ASSESSMENT_OPENS_AT = '00:01';

/** A calendar day plus some days, as a plain YYYY-MM-DD. */
function plusDays(day, count) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

/**
 * A calendar day as a plain YYYY-MM-DD — from the string a CONVERT gives, or the
 * Date a DATE column comes back as (read as the centre's own day).
 */
function dayOf(value) {
  if (!value) return '';
  if (value instanceof Date) return toInputDate(value);
  return String(value).slice(0, 10);
}

/** The end of a subject's month: end_date, or one month from when it started. */
function enrolmentEndDay(row) {
  if (!row) return '';
  if (row.end_date) return dayOf(row.end_date);
  if (row.start_date) return plusOneMonth(dayOf(row.start_date));
  const began = row.enrolled_at || row.created_at;
  return began ? plusOneMonth(began) : '';
}

/**
 * @param {object} row  an enrolment: end_date, else start_date / enrolled_at
 * @returns {{ endDate: string, opensAt: Date|null, isOpen: boolean }}
 */
function postWindowFor(row, now = new Date()) {
  const endDate = enrolmentEndDay(row);
  const opensAt = endDate ? atAppTime(endDate, POST_ASSESSMENT_OPENS_AT) : null;
  return { endDate, opensAt, isOpen: !!opensAt && now.getTime() >= opensAt.getTime() };
}

/**
 * The student's month in a subject, and whether it is over.
 *
 * @param {object} row  an enrolment: end_date, else start_date / enrolled_at
 * @returns {{ endDate: string, overAt: Date|null, overFrom: string, isOver: boolean }}
 *   overAt is the moment it is over — 12:00 AM on the day after its last day —
 *   and overFrom the same moment as the database writes times (storedTime).
 */
function monthOf(row, now = new Date()) {
  const endDate = enrolmentEndDay(row);
  const overDay = endDate ? plusDays(endDate, 1) : '';
  const overAt = overDay ? atAppTime(overDay, '00:00') : null;
  return {
    endDate,
    overAt,
    overFrom: overDay ? `${overDay} 00:00:00` : '',
    isOver: !!overAt && now.getTime() >= overAt.getTime()
  };
}

/**
 * A time the database wrote, as it wrote it: 'YYYY-MM-DD HH:mm:ss', Manila.
 *
 * The tables store Manila's clock (DATEADD(hour, 8, GETUTCDATE())) and the
 * driver hands it back as if it were UTC, so the Date's UTC reading is the
 * stored time.
 */
function storedTime(value) {
  if (!value) return '';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 19).replace('T', ' ');
  }
  return String(value).slice(0, 19).replace('T', ' ');
}

/**
 * Is a module, a handout or an assessment part of the student's month?
 * Everything is while the month runs; once it is over, only what was added
 * before it ended.
 *
 * @param {Date|string} createdAt  its created_at
 * @param {object} month           monthOf(...) for the student's enrolment
 */
function addedInMonth(createdAt, month) {
  if (!month || !month.isOver || !month.overFrom) return true;
  const stored = storedTime(createdAt);
  return !stored || stored < month.overFrom;
}

module.exports = {
  POST_ASSESSMENT_OPENS_AT,
  plusDays,
  dayOf,
  enrolmentEndDay,
  postWindowFor,
  monthOf,
  storedTime,
  addedInMonth
};
