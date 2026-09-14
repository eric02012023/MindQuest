/**
 * File: lib/pageStyles.js
 * Purpose: Decide which stylesheets a dashboard page loads.
 *
 * WHY THIS IS A MODULE AND NOT A FEW LINES IN THE TEMPLATE
 * -------------------------------------------------------
 * Each role's PAGE stylesheet carries the base layout — the sidebar, the topbar,
 * the content shell. `theme.css` is 82 bytes of variables; `billing.css` is 19KB
 * and holds the actual chrome. So a section with no sheet of its own does not
 * merely lose its own styling: the request 404s and the page renders with no
 * layout whatsoever, as raw document flow.
 *
 * That is a silent failure. Nothing throws, the route still answers 200, and the
 * only way to find out is to open the page and look at it. It is exactly what
 * happened when the POS section was added without an entry in the map below.
 *
 * Pulling the decision out of views/shells/dashboard.ejs means a test can
 * enumerate every section the app actually uses and assert that the file each
 * one resolves to is really on disk — see scripts/test-page-styles.js. The
 * template now asks this module rather than owning a map nothing could check.
 */

const path = require('path');
const fs = require('fs');

/** basePath -> the folder under public/css that holds that role's sheets. */
function roleFolderFor(basePath) {
  if (basePath === '/assistant') return 'assistant-admin';
  return String(basePath || '').replace(/^\//, '') || 'public';
}

/**
 * Sections that have no stylesheet of their own, mapped onto one that EXISTS.
 * The folders differ per role, so anything role-specific goes in ROLE_SECTION_MAP.
 */
const SECTION_MAP = {
  archive_notifications: 'notification-archives',
  notification_history: 'notification-history',
  payment_history: 'payment-history',
  income: 'dashboard'
};

const ROLE_SECTION_MAP = {
  admin: { notifications: 'notification-history' },
  'assistant-admin': { notifications: 'notification-history', students: 'users', tutors: 'users' },
  tutor: { focus: 'modules' },
  student: {}
};

/**
 * The stylesheets and body class for one page.
 *
 * @param {string} basePath  '/admin' | '/assistant' | '/student' | '/tutor'
 * @param {string} section   the route's `section` local
 */
function resolvePageStyles(basePath, section) {
  const roleFolder = roleFolderFor(basePath);
  const map = { ...SECTION_MAP, ...(ROLE_SECTION_MAP[roleFolder] || {}) };
  const sectionSlug = map[section] || String(section || 'dashboard').replace(/_/g, '-');

  const themeCss = `/css/${roleFolder}/theme.css`;
  const pageCss = `/css/${roleFolder}/${sectionSlug}.css`;

  return {
    roleFolder,
    sectionSlug,
    themeCss,
    pageCss,
    styles: [themeCss, pageCss],
    pageClass: `${roleFolder}-${sectionSlug}-page`
  };
}

/** Does a /css/... href actually exist under public/? Used by the test. */
function stylesheetExists(href) {
  const relative = String(href || '').replace(/^\//, '');
  return fs.existsSync(path.join(__dirname, '..', 'public', relative));
}

module.exports = {
  SECTION_MAP,
  ROLE_SECTION_MAP,
  roleFolderFor,
  resolvePageStyles,
  stylesheetExists
};
