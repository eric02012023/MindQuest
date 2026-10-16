/**
 * File: lib/postWindow.js
 * Purpose: When a student's Post-Assessment opens, and when it closes.
 *
 * One rule for the student's pages (lib/data.js) and the reports
 * (lib/analytics.js), which cannot require each other — so it lives here.
 *
 * It opens at 12:01 AM, Manila time, on the LAST DAY of the student's enrolment
 * in the subject — on its own, with nobody pressing a button. Enrolled 1 January,
 * the month ends 1 February, and from 12:01 AM on 1 February the Post-Assessment
 * is open. Before that a student cannot take it.
 *
 * It stays open for five days — the last day and the four after it (1 to
 * 5 February) — and at 12:00 AM on the sixth day (6 February) it closes. A
 * student who has not taken it by then can no longer take it.
 */

const { atAppTime, plusOneMonth, toInputDate } = require('./utils');

const POST_ASSESSMENT_OPENS_AT = '00:01';
const POST_ASSESSMENT_OPEN_DAYS = 5;

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
 * @returns {{ endDate: string, opensAt: Date|null, closesAt: Date|null,
 *   openUntil: Date|null, isOpen: boolean, isClosed: boolean }}
 *   openUntil is the last minute it can be taken (11:59 PM on the fifth day),
 *   for showing; closesAt is the moment after it.
 */
function postWindowFor(row, now = new Date()) {
  const endDate = enrolmentEndDay(row);
  const opensAt = endDate ? atAppTime(endDate, POST_ASSESSMENT_OPENS_AT) : null;
  const closesAt = endDate ? atAppTime(plusDays(endDate, POST_ASSESSMENT_OPEN_DAYS), '00:00') : null;
  const isClosed = !!closesAt && now.getTime() >= closesAt.getTime();
  return {
    endDate,
    opensAt,
    closesAt,
    openUntil: closesAt ? new Date(closesAt.getTime() - 60 * 1000) : null,
    isOpen: !!opensAt && now.getTime() >= opensAt.getTime() && !isClosed,
    isClosed
  };
}

module.exports = {
  POST_ASSESSMENT_OPENS_AT,
  POST_ASSESSMENT_OPEN_DAYS,
  plusDays,
  dayOf,
  enrolmentEndDay,
  postWindowFor
};
