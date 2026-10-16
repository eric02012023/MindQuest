/**
 * File: lib/analyticsFilters.js
 * Purpose: The filters of Analytics & Reports, tab by tab.
 *
 * The page has no shared filter bar. Each tab has its own, with only the fields
 * that tab needs (Weak topics: search, subject, branch; Payment collection:
 * search, dates, branch, method, purpose; …) and some tabs have none. A tab's
 * fields carry its own prefix in the address — weak_subject, att_from, reg_role —
 * so filtering one tab never changes another.
 *
 * Who is looking decides which fields a tab has (fieldsFor): the main admin
 * every one; an assistant admin and a tutor no branch (theirs is fixed); a
 * student only a few, on their own results. A field the viewer is not shown is
 * not read either, so the address cannot filter by something the page does not
 * offer.
 *
 * Every value is cleaned here, once, for the page and its CSV downloads alike: an
 * id must be a whole number, a date a real calendar day, a choice one of its
 * options; anything else falls back to "all".
 */

const { cleanDate, cleanId } = require('./listFilters');

/** The assessment kinds, in the order the picker lists them. */
const KIND_LABELS = {
  pre_assessment: 'Pre-Assessment',
  post_assessment: 'Post-Assessment',
  tutor_assessment: 'Module assessment'
};
const KINDS = Object.keys(KIND_LABELS);
const PROGRESS_STATUSES = ['Improved', 'No change', 'Declined', 'Awaiting Post-Assessment', 'Not yet assessed'];
const REGISTRY_ROLES = ['Assistant Admin', 'Tutor', 'Student'];
const REGISTRY_STATUSES = ['Approved', 'Pending', 'Rejected', 'Archived'];

/**
 * Each tab: the prefix of its fields in the address, the tab it is on the page
 * (#weak-topics), and the fields it has, in the order its bar shows them.
 */
const TABS = {
  trend: { prefix: 'trend', panel: 'score-trends', fields: ['subject', 'branch'] },
  levels: { prefix: 'level', panel: 'level-spread', fields: ['subject', 'branch'] },
  weak: { prefix: 'weak', panel: 'weak-topics', fields: ['search', 'subject', 'branch'] },
  perf: { prefix: 'perf', panel: 'learner-performance', fields: ['search', 'subject', 'branch'] },
  progress: { prefix: 'prog', panel: 'progress', fields: ['search', 'subject', 'status', 'branch'] },
  attempts: { prefix: 'att', panel: 'attempts', fields: ['search', 'subject', 'kind', 'from', 'to', 'branch'] },
  enrolment: { prefix: 'enrol', panel: 'enrollment', fields: ['branch'] },
  focus: { prefix: 'focus', panel: 'focus-areas', fields: ['search', 'subject', 'branch'] },
  payments: { prefix: 'pay', panel: 'payments', fields: ['search', 'from', 'to', 'branch', 'method', 'purpose'] },
  integrity: { prefix: 'int', panel: 'integrity', fields: ['search', 'from', 'to', 'branch'] },
  // From / To here: the day an account joined (the registry's Joined column).
  registry: { prefix: 'reg', panel: 'registry', fields: ['search', 'role', 'status', 'from', 'to', 'branch'] }
};

/** A student's own results: no learner to search for, no branch to pick. */
const STUDENT_FIELDS = {
  weak: ['subject'],
  progress: ['subject'],
  attempts: ['subject', 'kind', 'from', 'to']
};

/** The property a field becomes on the filters object. */
const PROPERTY = {
  search: 'search', subject: 'subjectId', branch: 'branchId', kind: 'kind', from: 'from', to: 'to',
  status: 'status', method: 'method', purpose: 'purpose', role: 'role'
};

/** The fields each tab shows this viewer. */
function fieldsFor(role) {
  const shown = {};
  for (const [tab, { fields }] of Object.entries(TABS)) {
    if (role === 'student') shown[tab] = STUDENT_FIELDS[tab] || [];
    else if (role === 'admin') shown[tab] = fields;
    else shown[tab] = fields.filter((field) => field !== 'branch');
  }
  return shown;
}

function oneOf(value, options) {
  const text = String(value == null ? '' : value).trim();
  return options.includes(text) ? text : 'all';
}

/**
 * @param {object} source   req.query
 * @param {object} options  { role: the viewer's, methods, purposes: the payment choices }
 * @returns {object} { trend: { subjectId, branchId }, weak: { search, subjectId, branchId }, … }
 *   — every tab and field, a field this viewer is not shown left at "all" / ''
 */
function readAnalyticsFilters(source = {}, options = {}) {
  const shown = fieldsFor(options.role);
  const methods = options.methods || [];
  const purposes = options.purposes || [];
  const read = (tab, field) => {
    const raw = shown[tab].includes(field) ? source[`${TABS[tab].prefix}_${field}`] : undefined;
    switch (field) {
      case 'search': return String(raw == null ? '' : raw).trim().slice(0, 100);
      case 'subject':
      case 'branch': return cleanId(raw);
      case 'from':
      case 'to': return cleanDate(raw);
      case 'kind': return oneOf(raw, KINDS);
      case 'method': return oneOf(raw, methods);
      case 'purpose': return oneOf(raw, purposes);
      case 'role': return oneOf(raw, REGISTRY_ROLES);
      case 'status': return oneOf(raw, tab === 'registry' ? REGISTRY_STATUSES : PROGRESS_STATUSES);
      default: return '';
    }
  };
  const filters = {};
  for (const [tab, { fields }] of Object.entries(TABS)) {
    filters[tab] = {};
    for (const field of fields) filters[tab][PROPERTY[field]] = read(tab, field);
  }
  return filters;
}

/** Is this value a filter at all (not empty, not "all")? */
function isSet(value) {
  return value !== undefined && value !== null && value !== '' && value !== 'all';
}

/**
 * The fields of one tab that are set, as [address name, value] pairs — what a
 * CSV link of that tab carries, and what the other tabs' forms carry along.
 */
function paramsOfTab(filters, tab) {
  const { prefix, fields } = TABS[tab];
  return fields
    .map((field) => [`${prefix}_${field}`, (filters[tab] || {})[PROPERTY[field]]])
    .filter((pair) => isSet(pair[1]));
}

/** Every tab's fields that are set, except `exceptTab`'s. */
function paramsExcept(filters, exceptTab) {
  return Object.keys(TABS).filter((tab) => tab !== exceptTab).flatMap((tab) => paramsOfTab(filters, tab));
}

/** Drop the empty and "all" values: two filters that ask the same thing compare equal. */
function setOnly(filters = {}) {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => isSet(value)));
}

/**
 * Everything one tab's filter bar needs (views/partials/analytics-filters.ejs):
 * its fields for this viewer, their values and choices, the tab it comes back
 * to, its own filters (for its CSV link) and every other tab's (kept as hidden
 * fields, so filtering this tab leaves the others as they were).
 */
function tabForms(filters, role) {
  const shown = fieldsFor(role);
  const forms = {};
  for (const [tab, { prefix, panel }] of Object.entries(TABS)) {
    forms[tab] = {
      tab,
      prefix,
      panel,
      fields: shown[tab],
      values: filters[tab] || {},
      own: paramsOfTab(filters, tab),
      others: paramsExcept(filters, tab),
      choices: {
        kind: KINDS.map((value) => [value, KIND_LABELS[value]]),
        status: tab === 'registry' ? REGISTRY_STATUSES : PROGRESS_STATUSES,
        role: REGISTRY_ROLES
      }
    };
  }
  return forms;
}

module.exports = {
  TABS,
  KINDS,
  KIND_LABELS,
  PROGRESS_STATUSES,
  REGISTRY_ROLES,
  REGISTRY_STATUSES,
  fieldsFor,
  readAnalyticsFilters,
  paramsOfTab,
  paramsExcept,
  setOnly,
  isSet,
  tabForms
};
