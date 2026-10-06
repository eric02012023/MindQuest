/**
 * File: scripts/test-profile-save.js
 * Purpose: Pin two data-loss bugs shut.
 *
 * Run:  node scripts/test-profile-save.js      (needs no database, no keys)
 *
 *   1. Saving a profile from a form that does not carry every column must not
 *      blank the columns it did not send. The admin's student form has no
 *      `email` input, so Save used to erase the student's LOGIN email — they
 *      could not sign in, and PayMongo got no email and kept "Pay" disabled.
 *   2. Taking payment on a slip claims the slip first. If the ledger then
 *      refuses the entry, the slip must go back to the queue, not stay
 *      "completed" with no money recorded.
 *
 * config/db is replaced in the require cache before lib/data.js loads, so the
 * real functions run against a scripted database.
 */

let failures = 0;
const ok = (label, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`);
  else { failures++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
};

const statements = [];
const student = {
  id: 46, user_id: 'STD-0046', role: 'student', branch_id: 1,
  first_name: 'Kristine', middle_name: 'Nolasco', last_name: 'Soriano',
  birth_date: new Date('2016-05-06'), gender: 'Female',
  contact_number: '09172388055', email: 'kristine@example.com',
  facebook_account: 'https://facebook.com/kristine', address: 'Purok 1',
  year_level: 'Primary Level', grade_level: 'Grade 4',
  parent_guardian_name: 'Rhea Soriano', parent_contact_number: '09170000000',
  parent_email: '', parent_facebook: '', subjects_json: '["ENGLISH"]', support_json: '[]', extra_json: '{}'
};
let slip = { id: 6, student_id: 46, status: 'pending', amount: 1000, payment_method: 'cash', purpose: 'Tuition' };

function answer(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  statements.push({ sql, params });
  if (/FROM users u LEFT JOIN branches b ON b.id = u.branch_id WHERE u.id = \?/i.test(sql)) return [{ ...student }];
  if (/^SELECT id, name FROM subjects/i.test(sql)) return [{ id: 4, name: 'ENGLISH' }];
  if (/FROM payment_requests/i.test(sql) && /^SELECT/i.test(sql)) return [{ ...slip }];
  if (/^UPDATE payment_requests SET status = 'completed'/i.test(sql)) { slip = { ...slip, status: 'completed' }; return [{ claimed_id: 6 }]; }
  if (/^UPDATE payment_requests SET status = 'pending'/i.test(sql)) { slip = { ...slip, status: 'pending' }; return []; }
  if (/^SELECT TOP 1 id, full_bill(, partial_payment)? FROM billing/i.test(sql)) return []; // no account: the ledger refuses
  return [];
}

const dbPath = require.resolve('../config/db');
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    sql: {},
    baseConfig: {},
    getPool: async () => { throw new Error('the test must never open a connection'); },
    query: async (text, params) => answer(text, params),
    withTransaction: async (work) => work({ query: async (text, params) => [answer(text, params)] })
  }
};

const { updateUser } = require('../lib/data');
const { completePaymentRequest } = require('../lib/billing');

(async () => {
  console.log('\n== saving a student from the admin profile form ==');
  // Exactly the fields that form posts: "Parent/student email" is parent_email,
  // and there is no email or facebook_account input for a student.
  await updateUser(46, {
    branch_id: 1, first_name: 'Kristine', middle_name: 'Nolasco', last_name: 'Soriano',
    birth_date: '2016-05-06', age: 10, gender: 'Female', contact_number: '09172388055',
    parent_email: 'kristine@example.com', parent_facebook: '', parent_guardian_name: 'Rhea Soriano',
    parent_contact_number: '09170000000', year_level: 'Primary Level', grade_level: 'Grade 4',
    address: 'Purok 1', subjects: 'ENGLISH', supports: '', updated_by: 1
  });
  const write = statements.find((s) => /^UPDATE users SET branch_id = \?/i.test(s.sql));
  ok('the profile was written', !!write);
  const emailParam = write ? write.params[8] : undefined;
  const facebookParam = write ? write.params[9] : undefined;
  ok('the login email is kept', emailParam === 'kristine@example.com', String(emailParam));
  ok('a column the form does not carry is kept', facebookParam === 'https://facebook.com/kristine', String(facebookParam));

  console.log('\n== an empty email posted on purpose still never blanks the login ==');
  statements.length = 0;
  await updateUser(46, { first_name: 'Kristine', last_name: 'Soriano', email: '', subjects: 'ENGLISH' });
  const second = statements.find((s) => /^UPDATE users SET branch_id = \?/i.test(s.sql));
  ok('the login email survives an empty field', second && second.params[8] === 'kristine@example.com', String(second && second.params[8]));

  console.log('\n== a slip whose ledger entry is refused goes back to the queue ==');
  statements.length = 0;
  let refused = null;
  try {
    await completePaymentRequest(6, { id: 1, role: 'admin', first_name: 'System', last_name: 'Administrator' }, {});
  } catch (error) {
    refused = error.message;
  }
  ok('the payment is refused', !!refused, refused || 'it went through');
  ok('the slip was claimed first', statements.some((s) => /^UPDATE payment_requests SET status = 'completed'/i.test(s.sql)));
  ok('and handed back to pending', slip.status === 'pending', slip.status);

  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'Profile saves keep what they were not sent; refused slips return to the queue.'}`);
  process.exit(failures ? 1 : 0);
})().catch((error) => { console.error('ERROR', error.message, error.stack); process.exit(1); });
