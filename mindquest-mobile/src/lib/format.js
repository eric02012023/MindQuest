/**
 * File: src/lib/format.js
 * Purpose: Dates and money written the way the website writes them.
 *
 * Dates are shown in Asia/Manila time ("Nov 07, 2026", "Nov 07, 2026 03:05 PM",
 * the website's 'MMM DD, YYYY' and 'MMM DD, YYYY hh:mm A'). Manila is UTC+8 all
 * year (no daylight saving), so the shift is done by hand: no dependence on
 * the phone's own timezone or on Intl support in the JavaScript engine.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, '0');

/** A value from the server as a Date in Manila wall time (read with getUTC*), or null. */
function manila(value) {
  if (value === null || value === undefined || value === '') return null;
  // A plain "2026-11-17" is that calendar day, not a moment.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() + MANILA_OFFSET_MS);
}

/** "Nov 07, 2026" (or '—' when there is no date). */
export function formatDate(value) {
  const d = manila(value);
  if (!d) return '—';
  return `${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())}, ${d.getUTCFullYear()}`;
}

/** "Nov 07, 2026 03:05 PM". */
export function formatDateTime(value) {
  const d = manila(value);
  if (!d) return '—';
  const hours = d.getUTCHours();
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return `${formatDate(value)} ${pad(twelve)}:${pad(d.getUTCMinutes())} ${hours < 12 ? 'AM' : 'PM'}`;
}

/** "₱1,234.50". */
export function money(value) {
  const number = Number(value || 0);
  const safe = Number.isFinite(number) ? number : 0;
  const [whole, cents] = Math.abs(safe).toFixed(2).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${safe < 0 ? '-' : ''}₱${grouped}.${cents}`;
}

/** "66.7%" — at most one decimal, as the website shows a percentage. */
export function percent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `${Math.round(number * 10) / 10}%`;
}

/** The level a percentage falls in (the website's bands). */
export function levelOf(percentage) {
  const p = Number(percentage || 0);
  if (p >= 81) return 'Advance';
  if (p >= 51) return 'Intermediate';
  return 'Beginner';
}
