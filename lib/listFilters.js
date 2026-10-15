/**
 * File: lib/listFilters.js
 * Purpose: The small filters a list page applies to rows it already has.
 *
 * Some lists (Payment History, Assessment Monitoring, a subject's students) come
 * from one query that is not worth parameterising for every filter a page offers,
 * and are short enough to narrow in memory. The page's filter bar is an ordinary
 * GET form; the route reads the query string, keeps the form's values to show
 * back, and passes the rows through these.
 */

const { toInputDate } = require('./utils');

function normalise(value) {
  return String(value == null ? '' : value).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Does this row say every word the person typed? Anywhere in the parts given —
 * a name, an ID, a title — in any order.
 *
 * @param {Array<string|number|null|undefined>} parts  what the row says
 * @param {string} term  what was typed; empty matches everything
 */
function matchesSearch(parts, term) {
  const words = normalise(term).split(' ').filter(Boolean);
  if (!words.length) return true;
  const text = normalise((parts || []).filter((part) => part != null && part !== '').join(' '));
  return words.every((word) => text.includes(word));
}

/**
 * Is this moment inside the range (both ends included, as calendar days in the
 * centre's own time — the same day the page shows for it)?
 *
 * @param {Date|string|null} value
 * @param {string} from  'YYYY-MM-DD' or ''
 * @param {string} to    'YYYY-MM-DD' or ''
 */
function withinDates(value, from, to) {
  if (!from && !to) return true;
  const day = toInputDate(value);
  if (!day) return false;
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

/** A name as one string — for searching, not for showing. */
function nameParts(row, prefix = '') {
  return [row[`${prefix}first_name`], row[`${prefix}middle_name`], row[`${prefix}last_name`]].filter(Boolean).join(' ');
}

/**
 * A date typed into a filter, or '' when it is not a real calendar day written
 * as a plain YYYY-MM-DD. "2026-13-45" has the shape but is no day: it would
 * reach a query as an Invalid Date.
 */
function cleanDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  const day = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === text ? text : '';
}

/**
 * A record id picked in a filter (a subject, a branch), or 'all'. Anything that
 * is not a whole number would reach a query as NaN, which the driver sends as
 * NULL — so a hand-edited address quietly showed an empty list.
 */
function cleanId(value) {
  const text = String(value == null ? '' : value).trim();
  return /^[1-9]\d{0,9}$/.test(text) ? text : 'all';
}

module.exports = { matchesSearch, withinDates, nameParts, cleanDate, cleanId, normalise };
