/**
 * File: scripts/test-anti-cheat-client.js
 * Purpose: Run public/js/anti-cheat.js against a hand-rolled DOM.
 *
 * Run:  node scripts/test-anti-cheat-client.js      (needs no database, no keys)
 *
 * WHY A SHIM AND NOT A BROWSER
 * No jsdom, no puppeteer — adding either to this project for one test would be a
 * heavier change than the thing being tested. The shim below is only as complete
 * as the script actually needs, which is the point: if the script starts using a
 * DOM API it does not have, this test fails loudly rather than silently passing.
 *
 * WHAT IT PROVES
 * The three-strike escalation, that one alt-tab costs one strike and not two,
 * that the third warning submits the form, and — the part most likely to break
 * silently — that `required` is stripped first, so the partial answers actually
 * reach the server instead of the browser refusing the submit.
 *
 * WHAT IT DOES NOT PROVE
 * That a real browser fires these events the way the shim does. Worth one manual
 * pass in a browser after changing the event wiring.
 */
const fs = require('fs');
const vm = require('vm');

let failures = 0;
const ok = (l, c, e = '') => {
  if (c) console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`);
  else { failures++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};

// --------------------------------------------------------------- the DOM shim

function makeEl(tag = 'div') {
  const classes = new Set();
  const attrs = {};
  const children = [];
  const el = {
    tagName: tag,
    children,
    dataset: {},
    style: {},
    _html: '',
    focused: false,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c))
    },
    get className() { return [...classes].join(' '); },
    set innerHTML(v) { el._html = v; },
    get innerHTML() { return el._html; },
    setAttribute: (k, v) => { attrs[k] = String(v); },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    removeAttribute: (k) => { delete attrs[k]; },
    appendChild: (child) => { children.push(child); return child; },
    focus: () => { el.focused = true; },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (type, fn) => { (el._listeners[type] ||= []).push(fn); },
    _listeners: {},
    _fire: (type, ev = {}) => (el._listeners[type] || []).forEach((fn) => fn(ev)),
    _attrs: attrs
  };

  // A browser reflects these three between property and attribute on an
  // <input>. The script sets them as properties (marker.name = 'auto_submitted'),
  // and the form serialises them from the attribute — so a shim that did not
  // reflect would report a bug the browser does not have.
  for (const prop of ['type', 'name', 'value']) {
    Object.defineProperty(el, prop, {
      get: () => (prop in attrs ? attrs[prop] : ''),
      set: (v) => { attrs[prop] = String(v); },
      enumerable: true,
      configurable: true
    });
  }

  return el;
}

// The three text nodes and the button the script pulls out of its own card.
const cardParts = {
  '.mq-ac-title': makeEl('h2'),
  '.mq-ac-body': makeEl('p'),
  '.mq-ac-count': makeEl('p'),
  '.mq-ac-btn': makeEl('button')
};
Object.values(cardParts).forEach((el) => { el.textContent = ''; });

const overlay = makeEl('div');
overlay.querySelector = (sel) => cardParts[sel] || null;

// The assessment form, with two required fields the auto-submit must free.
const requiredFields = [makeEl('input'), makeEl('input')];
requiredFields.forEach((f) => f.setAttribute('required', ''));

const form = makeEl('form');
form.setAttribute('data-confirm-message', 'Submit your Pre-Assessment?');
form.querySelectorAll = (sel) => (sel === '[required]' ? requiredFields.filter((f) => f.getAttribute('required') !== null) : []);
let submitted = 0;
form.requestSubmit = () => { submitted++; form._fire('submit', {}); };

const mount = makeEl('div');
mount.setAttribute('data-endpoint', '/student/assessments/42/violation');
mount.setAttribute('data-session', 'sitting-1');
mount.setAttribute('data-form', '#assessment-form');
mount.setAttribute('data-limit', '3');
mount.setAttribute('data-start-count', '0');

const created = [];
const documentShim = {
  hidden: false,
  hasFocus: () => false,
  getElementById: (id) => (id === 'mq-anti-cheat' ? mount : null),
  querySelector: (sel) => (sel === '#assessment-form' ? form : null),
  querySelectorAll: () => [],
  createElement: (tag) => { const el = tag === 'div' ? overlay : makeEl(tag); created.push(el); return el; },
  body: makeEl('body'),
  _listeners: {},
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
  fire(type, ev = {}) { (this._listeners[type] || []).forEach((fn) => fn(ev)); }
};

const windowShim = {
  _listeners: {},
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
  fire(type, ev = {}) { (this._listeners[type] || []).forEach((fn) => fn(ev)); },
  setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }
};
const timers = [];

// The server's replies, in order. This is what the real endpoint returns.
const posted = [];
let strike = 0;
const fetchShim = (url, options) => {
  posted.push({ url, body: JSON.parse(options.body) });
  strike += 1;
  return Promise.resolve({
    json: () => Promise.resolve({
      ok: true,
      count: strike,
      total: strike,
      limit: 3,
      autoSubmit: strike >= 3,
      label: ['Switched away from the assessment tab', 'Copied text out of the assessment', 'Tried to open developer tools'][strike - 1] || 'Suspicious activity'
    })
  });
};

const sandbox = {
  document: documentShim,
  window: windowShim,
  fetch: fetchShim,
  Date,
  JSON,
  Math,
  Number,
  String,
  console
};
sandbox.globalThis = sandbox;

// ------------------------------------------------------------------ the test

const source = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'js', 'anti-cheat.js'), 'utf8');
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'anti-cheat.js' });

const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));

async function main() {
  console.log('\n== wiring ==');
  ok('the warning dialog was built and mounted', documentShim.body.children.includes(overlay));
  ok('it listens for tab switches', !!documentShim._listeners.visibilitychange);
  ok('it listens for copy and paste', !!documentShim._listeners.copy && !!documentShim._listeners.paste);
  ok('it listens for right-click and key shortcuts', !!documentShim._listeners.contextmenu && !!documentShim._listeners.keydown);
  ok('it listens for the window losing focus', !!windowShim._listeners.blur);
  ok('it knows when the form is submitted normally', !!form._listeners.submit);

  console.log('\n== strike 1: switching tabs ==');
  documentShim.hidden = true;
  documentShim.fire('visibilitychange');
  await settle();
  ok('one report was sent', posted.length === 1, posted[0] && posted[0].url);
  ok('it names the event type', posted[0] && posted[0].body.type === 'tab_switch');
  ok('it carries the sitting key', posted[0] && posted[0].body.session_key === 'sitting-1');
  ok('the dialog is open', overlay.classList.contains('is-open'));
  ok('it is not the final warning', !overlay.classList.contains('is-final'));
  ok('the title warns', /warning|stay on this page/i.test(cardParts['.mq-ac-title'].textContent), cardParts['.mq-ac-title'].textContent);
  ok('the count says 1 of 3', cardParts['.mq-ac-count'].textContent === 'Violation 1 of 3', cardParts['.mq-ac-count'].textContent);
  ok('the button is focused so a keyboard can dismiss it', cardParts['.mq-ac-btn'].focused);

  console.log('\n== one action costs one strike ==');
  // A real alt-tab fires blur AND visibilitychange. Both inside the dedupe
  // window must still be a single strike.
  windowShim.fire('blur');
  documentShim.fire('visibilitychange');
  await settle();
  ok('a duplicate event within the window is ignored', posted.length === 1, `${posted.length} report(s)`);

  cardParts['.mq-ac-btn'].onclick();
  ok('acknowledging closes the dialog', !overlay.classList.contains('is-open'));

  console.log('\n== strike 2: copying the questions ==');
  await new Promise((r) => setTimeout(r, 1300));   // past the dedupe window
  documentShim.fire('copy');
  await settle();
  ok('a second report was sent', posted.length === 2, posted[1] && posted[1].body.type);
  ok('the dialog reopened', overlay.classList.contains('is-open'));
  ok('it says second warning', /second/i.test(cardParts['.mq-ac-title'].textContent), cardParts['.mq-ac-title'].textContent);
  ok('it warns that one more ends the assessment', /one more violation will end/i.test(cardParts['.mq-ac-body'].textContent));
  ok('the count says 2 of 3', cardParts['.mq-ac-count'].textContent === 'Violation 2 of 3');
  cardParts['.mq-ac-btn'].onclick();

  console.log('\n== strike 3: devtools ==');
  await new Promise((r) => setTimeout(r, 1300));
  let prevented = false;
  documentShim.fire('keydown', { key: 'F12', preventDefault: () => { prevented = true; } });
  await settle();
  ok('the shortcut was swallowed', prevented);
  ok('a third report was sent', posted.length === 3, posted[2] && posted[2].body.type);
  ok('the report says devtools', posted[2] && posted[2].body.type === 'devtools');
  ok('the dialog is the final one', overlay.classList.contains('is-final'));
  ok('it says the assessment ended', /assessment ended/i.test(cardParts['.mq-ac-title'].textContent), cardParts['.mq-ac-title'].textContent);
  ok('it says the answers so far are being submitted', /answers you have completed so far/i.test(cardParts['.mq-ac-body'].textContent));
  ok('the button offers to submit', /submit/i.test(cardParts['.mq-ac-btn'].textContent), cardParts['.mq-ac-btn'].textContent);
  ok('a fallback submit was scheduled in case nobody clicks', timers.length === 1 && timers[0].ms === 8000, `${timers.length} timer(s)`);
  ok('nothing has been submitted yet', submitted === 0);

  console.log('\n== auto-submit keeps the partial answers ==');
  cardParts['.mq-ac-btn'].onclick();
  ok('the form was submitted', submitted === 1);
  ok('every required field was freed first', requiredFields.every((f) => f.getAttribute('required') === null));
  const marker = form.children.find((c) => c.getAttribute && c.getAttribute('name') === 'auto_submitted');
  ok('an auto_submitted marker was added', !!marker, marker && marker.getAttribute('value'));
  ok('the marker names the reason', marker && marker.getAttribute('value') === 'anti_cheat_limit');
  ok('the confirm dialog was stood down', form.getAttribute('data-confirm-message') === null && form.dataset.confirmed === 'true');

  console.log('\n== the sitting is over ==');
  await new Promise((r) => setTimeout(r, 1300));
  documentShim.fire('copy');
  documentShim.fire('paste');
  await settle();
  ok('no further violations are reported', posted.length === 3, `${posted.length} total`);

  timers[0].fn();
  ok('the fallback timer does not submit twice', submitted === 1);

  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'All anti-cheat client checks passed.'}`);
  process.exit(failures ? 1 : 0);
}

main();
