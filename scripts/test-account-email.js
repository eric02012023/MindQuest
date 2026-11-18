/**
 * File: scripts/test-account-email.js
 * Purpose: Pin down how the main admin and an Assistant Admin change their own
 *          password and login email.
 *
 * Run:  node scripts/test-account-email.js      (needs no database, no mail)
 *
 * WHAT MUST HOLD
 *   1. A password changes only with the right current password, to a strong new
 *      one, and only its hash is stored.
 *   2. A new email must be a registered Gmail address — the rule students and
 *      tutors register under — not the one they have, not anyone else's, and
 *      the current password must be right.
 *   3. Nothing changes until the 4-digit code sent to the NEW address is entered;
 *      a wrong code changes nothing.
 *   4. The main admin can no longer set an assistant's email to an address
 *      that is not a registered Gmail one; an old @….local one is kept as it is.
 *
 * `config/db` is replaced in the require cache before anything loads it.
 */
const bcrypt = require('bcryptjs');

let failures = 0;
const ok = (label, condition, extra = '') => {
  if (condition) console.log(`  PASS  ${label}${extra ? ' — ' + extra : ''}`);
  else { failures++; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
};

const db = {
  statements: [],
  user: null,          // getUserById's row
  taken: false,        // isEmailTaken's answer for users
  otp: null,           // the last code stored (otps row)
  insertId: 500
};

function answer(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  db.statements.push({ sql, params });
  if (sql.startsWith('INSERT INTO otps')) {
    db.otp = { id: ++db.insertId, user_id: params[0], purpose: params[1], otp_code: params[2], expires_at: params[3], failed_attempts: 0, is_used: 0 };
    return { insertId: db.otp.id };
  }
  if (sql.startsWith('INSERT')) return { insertId: ++db.insertId };
  if (sql.startsWith('SELECT TOP 1 u.*, b.name AS branch_name FROM users u')) return db.user ? [db.user] : [];
  if (sql.startsWith('SELECT TOP 1 id FROM users WHERE LOWER(email) = ?')) return db.taken ? [{ id: 99 }] : [];
  if (sql.startsWith('SELECT TOP 1 id FROM submissions')) return [];
  if (sql.startsWith('SELECT COUNT(*) AS n FROM otps')) return [{ n: 0 }];
  if (sql.startsWith('SELECT TOP 1 * FROM otps')) return db.otp && !db.otp.is_used ? [db.otp] : [];
  if (sql.startsWith('UPDATE otps SET is_used = 1, used_at')) { if (db.otp) db.otp.is_used = 1; return []; }
  if (sql.includes('FROM branches')) return [{ id: 15, name: 'NORTH BRANCH' }];
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
    query: async (text, params = []) => answer(text, params),
    withTransaction: async (work) => work({ query: async (text, params = []) => [answer(text, params)] })
  }
};

const data = require('../lib/data');
const accountEmail = require('../lib/accountEmail');

async function fails(work) {
  try { await work(); return ''; } catch (error) { return error.message; }
}

async function main() {
  const hash = await bcrypt.hash('OldPass#2026', 10);
  const admin = { id: 1, role: 'admin', email: 'admin@mindquest.local', password_hash: hash, is_archived: 0, extra_json: '{}' };

  console.log('\n== changing a password ==');
  db.user = { ...admin };
  ok('the wrong current password changes nothing',
    /Current password is incorrect/.test(await fails(() => data.changeUserPassword(1, 'Wrong#2026x', 'NewPass#2026'))));
  ok('a weak new password is refused', /at least 8 characters/.test(await fails(() => data.changeUserPassword(1, 'OldPass#2026', 'short'))));
  db.statements = [];
  await data.changeUserPassword(1, 'OldPass#2026', 'NewPass#2026');
  const saved = db.statements.find((s) => s.sql.startsWith('UPDATE users SET password_hash = ?'));
  ok('the right current password and a strong new one: saved', !!saved);
  ok('…as a hash of the new password, never the password itself',
    !!saved && saved.params[0] !== 'NewPass#2026' && await bcrypt.compare('NewPass#2026', saved.params[0]));

  console.log('\n== changing the login email: step 1, a code to the new address ==');
  const sent = [];
  const send = async (mail) => { sent.push(mail); };
  const request = (newEmail, currentPassword = 'OldPass#2026') => accountEmail.requestEmailChange({ userId: 1, newEmail, currentPassword, send });
  db.user = { ...admin };
  ok('the current password is required', /Current password is incorrect/.test(await fails(() => request('mindquest.admin@gmail.com', 'nope'))));
  ok('not a Gmail address: refused, as for students and tutors', /Gmail address ending in @gmail.com/.test(await fails(() => request('office@mindquest.local'))));
  ok('a Gmail username Google would never give out: refused', /not a registered Gmail account/.test(await fails(() => request('abc@gmail.com'))));
  db.taken = true;
  ok('an email another account uses: refused', /already used by another account/.test(await fails(() => request('mindquest.admin@gmail.com'))));
  db.taken = false;
  db.user = { ...admin, email: 'mindquest.admin@gmail.com' };
  ok('the email they already have: refused', /already your email/.test(await fails(() => request('MindQuest.Admin@gmail.com'))));
  db.user = { ...admin, role: 'student' };
  ok('a student or tutor cannot use this', /Only the admin and an assistant admin/.test(await fails(() => request('mindquest.admin@gmail.com'))));
  db.user = { ...admin };
  db.statements = [];
  sent.length = 0;
  const started = await request('  MindQuest.Admin@Gmail.com ');
  ok('a registered Gmail address: a code is sent to it', started.email === 'mindquest.admin@gmail.com'
    && sent.length === 1 && sent[0].to === 'mindquest.admin@gmail.com' && sent[0].purpose === 'email_change' && /^\d{4}$/.test(sent[0].otp));
  ok('…and the code is stored for this account, hashed', !!db.otp && db.otp.purpose === 'email_change' && db.otp.user_id === 1 && db.otp.otp_code !== sent[0].otp);
  ok('…but the email is NOT changed yet', !db.statements.some((s) => s.sql.startsWith('UPDATE users SET email')));
  const noMail = await fails(() => accountEmail.requestEmailChange({
    userId: 1, newEmail: 'mindquest.admin@gmail.com', currentPassword: 'OldPass#2026', send: async () => { throw new Error('SMTP down'); }
  }));
  ok('a code that cannot be sent: said so, nothing changed', /could not be sent/.test(noMail) && !db.statements.some((s) => s.sql.startsWith('UPDATE users SET email')));

  console.log('\n== step 2: the code from the new inbox ==');
  sent.length = 0;
  await request('mindquest.admin@gmail.com');
  const code = sent[0].otp;
  const wrong = code === '1234' ? '4321' : '1234';
  db.statements = [];
  ok('a wrong code: refused, with the tries left', /Invalid OTP/.test(await fails(() => accountEmail.confirmEmailChange({ userId: 1, pendingEmail: 'mindquest.admin@gmail.com', code: wrong }))));
  ok('…and the email is unchanged', !db.statements.some((s) => s.sql.startsWith('UPDATE users SET email')));
  ok('not four digits: refused before anything is checked', /4-digit code/.test(await fails(() => accountEmail.confirmEmailChange({ userId: 1, pendingEmail: 'mindquest.admin@gmail.com', code: '12' }))));
  db.statements = [];
  const done = await accountEmail.confirmEmailChange({ userId: 1, pendingEmail: 'mindquest.admin@gmail.com', code });
  const changed = db.statements.find((s) => s.sql.startsWith('UPDATE users SET email = ?'));
  ok('the right code: the email changes to the new address', done.email === 'mindquest.admin@gmail.com' && !!changed && changed.params[0] === 'mindquest.admin@gmail.com' && changed.params[2] === 1);
  ok('…and is marked as checked', !!changed && /email_verified_at/.test(changed.params[1]));
  ok('a code is used once', /No active OTP/.test(await fails(() => accountEmail.confirmEmailChange({ userId: 1, pendingEmail: 'mindquest.admin@gmail.com', code }))));

  console.log('\n== an assistant changing their own email ==');
  const assistant = { id: 354, role: 'admin_assistant', email: 'lorna@north.local', password_hash: hash, is_archived: 0, extra_json: '{"assistant_name":"Lorna"}', extra: { assistant_name: 'Lorna' } };
  db.user = { ...assistant };
  sent.length = 0;
  await accountEmail.requestEmailChange({ userId: 354, newEmail: 'lorna.north@gmail.com', currentPassword: 'OldPass#2026', send });
  db.statements = [];
  await accountEmail.confirmEmailChange({ userId: 354, pendingEmail: 'lorna.north@gmail.com', code: sent[0].otp });
  const assistantSaved = db.statements.find((s) => s.sql.startsWith('UPDATE users SET email = ?'));
  ok('the same two steps change it', !!assistantSaved && assistantSaved.params[0] === 'lorna.north@gmail.com');
  ok('…and the account keeps its name, with the email beside it', !!assistantSaved
    && JSON.parse(assistantSaved.params[1]).assistant_name === 'Lorna' && JSON.parse(assistantSaved.params[1]).email === 'lorna.north@gmail.com');

  console.log('\n== the main admin setting an assistant\'s email ==');
  db.user = { ...assistant, assistant_scope_branch_id: 15, branch_id: 15 };
  ok('a new address that is not a registered Gmail one: refused',
    /Gmail address ending in @gmail.com/.test(await fails(() => data.updateAssistantAccount(354, { email: 'someone@north.local', branch_id: 15 }))));
  db.statements = [];
  await data.updateAssistantAccount(354, { email: 'lorna@north.local', branch_id: 15, assistant_name: 'Lorna' });
  ok('the old @….local address, unchanged, is kept as it is', db.statements.some((s) => s.sql.startsWith('UPDATE users SET assistant_scope_branch_id')));
  db.statements = [];
  await data.updateAssistantAccount(354, { email: 'lorna.north@gmail.com', branch_id: 15, assistant_name: 'Lorna' });
  const assistantEmail = db.statements.find((s) => s.sql.startsWith('UPDATE users SET assistant_scope_branch_id'));
  ok('a registered Gmail address: saved', !!assistantEmail && assistantEmail.params.includes('lorna.north@gmail.com'));
  ok('a new assistant account needs a registered Gmail address too',
    /Gmail address ending in @gmail.com/.test(await fails(() => data.createAssistantAccount(15, 'new@north.local', 'Strong#2026x', { id: 1 }, 'New One'))));

  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'Passwords change with the current one; an email changes only to a registered Gmail address, after its code.'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
