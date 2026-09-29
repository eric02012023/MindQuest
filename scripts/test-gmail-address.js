/**
 * File: scripts/test-gmail-address.js
 * Purpose: Pin down which email addresses registration accepts as a Gmail
 *          account — the server's validateGmailAddress and the browser's copy
 *          in public/js/registration.js must agree.
 *
 * Run:  node scripts/test-gmail-address.js      (needs no database, no keys)
 *
 * WHY THIS EXISTS
 * A student or tutor who registers with an address that cannot exist is
 * approved and then locked out: the login code is sent to that address and
 * never arrives. Gmail's own username rules decide what can exist, and the
 * trap is being stricter than Gmail — turning away a real person's address
 * (one with periods, or a "+" alias) is worse than letting a typo through.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { validateGmailAddress } = require('../lib/utils');

let failures = 0;
const ok = (l, c, e = '') => {
  if (c) console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`);
  else { failures++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};

// The browser's copy, loaded from the real file with no DOM to act on.
const browser = {};
vm.runInNewContext(
  `${fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'registration.js'), 'utf8')}\nout.gmailProblem = gmailProblem;`,
  { out: browser, document: { querySelectorAll: () => [] }, window: {} }
);

const accepted = [
  'juandelacruz@gmail.com',
  'Juan.DelaCruz@Gmail.com',       // case does not matter to Gmail
  'maria.santos.2008@gmail.com',   // periods between letters are allowed
  'abcdef@gmail.com',              // exactly six characters
  'rafaeleulalz+student1@gmail.com', // a "+" alias reaches the account
  `${'a'.repeat(30)}@gmail.com`,   // thirty characters
  `${'ab.'.repeat(14)}ab@gmail.com` // thirty letters, periods not counted
];

const refused = [
  ['juan@gmail.com', 'fewer than six characters'],
  ['juan_dela@gmail.com', 'an underscore'],
  ['juan-dela@gmail.com', 'a hyphen'],
  ['.juandela@gmail.com', 'starts with a period'],
  ['juandela.@gmail.com', 'ends with a period'],
  ['juan..dela@gmail.com', 'two periods in a row'],
  [`${'a'.repeat(31)}@gmail.com`, 'more than thirty characters'],
  ['juandelacruz@gmial.com', 'a misspelt domain'],
  ['juandelacruz@yahoo.com', 'not Gmail'],
  ['juandelacruz@gmail.com.ph', 'not gmail.com'],
  ['@gmail.com', 'no username']
];

console.log('== addresses Gmail could have given out are accepted ==');
for (const email of accepted) {
  const server = validateGmailAddress(email);
  ok(email, server.ok, server.message);
  ok(`  and the form agrees`, browser.gmailProblem(email) === '');
}

console.log('\n== addresses that cannot be a Gmail account are turned away ==');
for (const [email, why] of refused) {
  const server = validateGmailAddress(email);
  ok(`${email} (${why})`, !server.ok);
  ok(`  and the form agrees`, browser.gmailProblem(email) !== '');
}

console.log('\n== the message tells them what to do ==');
const fake = validateGmailAddress('juan@gmail.com');
ok('it says the account is not a registered Gmail', /not a registered Gmail account/.test(fake.message), fake.message);
ok('it sends them to create one first', /accounts\.google\.com/.test(fake.message));
ok('a wrong domain asks for @gmail.com', /@gmail\.com/.test(validateGmailAddress('juan@yahoo.com').message));

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'Registration only takes addresses that could be a Gmail account.'}`);
process.exit(failures ? 1 : 0);
