/**
 * remove-seeded-branch-accounts.js
 *
 * Undoes scripts/seed-branch-accounts.js.
 *
 * The seeded accounts carry no marker in their names — deliberately, so they
 * read as an ordinary roster during a demonstration. What identifies them is
 * their address: every one is a "+" alias of the inbox the seed script was
 * given. So that alias pattern is what this matches on, and nothing else.
 *
 * Two guards keep this away from real records: the address must contain a "+"
 * alias of the given inbox (the bare inbox itself never matches), and the role
 * must be student or tutor, so an admin account can never be caught.
 *
 * Usage:
 *   node scripts/remove-seeded-branch-accounts.js --email=you@gmail.com            (preview)
 *   node scripts/remove-seeded-branch-accounts.js --email=you@gmail.com --commit   (deletes)
 *
 * Without --commit nothing is deleted: it lists what it would remove.
 */

require('dotenv').config();
const { query } = require('../config/db');

function parseArgs(argv) {
  const args = { commit: false, email: process.env.SEED_BASE_EMAIL || '' };
  for (const raw of argv) {
    if (raw === '--commit') args.commit = true;
    else if (raw.startsWith('--email=')) args.email = raw.slice('--email='.length).trim();
  }
  return args;
}

/**
 * Every table holding a row that points at a user. Read from the catalog rather
 * than listed here, because roughly forty tables reference dbo.users and a
 * hand-written list would be wrong the first time the schema grew.
 */
async function findReferencingColumns() {
  return query(`
    SELECT OBJECT_NAME(fk.parent_object_id) AS table_name,
           COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS column_name
      FROM sys.foreign_keys fk
      JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
     WHERE fk.referenced_object_id = OBJECT_ID('dbo.users')
  `);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.email || !args.email.includes('@')) {
    console.error('Pass the inbox the accounts were seeded against, e.g. --email=you@gmail.com');
    process.exit(1);
  }

  const [local, domain] = args.email.toLowerCase().split('@');
  const pattern = `${local}+%@${domain}`;

  const targets = await query(
    `SELECT id, user_id, role, email FROM users
      WHERE LOWER(email) LIKE ? AND role IN ('student','tutor')
      ORDER BY id`,
    [pattern]
  );

  console.log(`Database : ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(`Matching : ${pattern}`);
  console.log(`Found    : ${targets.length} seeded accounts`);
  console.log(`Mode     : ${args.commit ? 'COMMIT — rows will be deleted' : 'DRY RUN — nothing will be deleted'}\n`);

  if (!targets.length) {
    console.log('Nothing to remove.');
    return;
  }

  const tutors = targets.filter((row) => row.role === 'tutor').length;
  console.log(`  tutors  : ${tutors}`);
  console.log(`  students: ${targets.length - tutors}`);
  console.log(`  first   : ${targets[0].user_id} <${targets[0].email}>`);
  console.log(`  last    : ${targets[targets.length - 1].user_id} <${targets[targets.length - 1].email}>\n`);

  if (!args.commit) {
    console.log('Re-run with --commit to delete these accounts and everything attached to them.');
    return;
  }

  const idList = targets.map((row) => Number(row.id)).join(',');
  let remaining = await findReferencingColumns();

  // Some of those tables point at each other as well as at users (a payment
  // entry belongs to a billing row), so one pass can fail on a parent whose
  // children are not gone yet. Repeat until a pass clears nothing new.
  for (let pass = 1; pass <= 5 && remaining.length; pass++) {
    const blocked = [];
    for (const { table_name: table, column_name: column } of remaining) {
      try {
        await query(`DELETE FROM [${table}] WHERE [${column}] IN (${idList})`);
      } catch (_error) {
        blocked.push({ table_name: table, column_name: column });
      }
    }
    if (blocked.length === remaining.length) break;
    remaining = blocked;
  }

  if (remaining.length) {
    console.error('Could not clear rows in:', remaining.map((r) => `${r.table_name}.${r.column_name}`).join(', '));
    console.error('The accounts were left in place. Clear those rows first, then run this again.');
    process.exit(1);
  }

  const result = await query(`DELETE FROM users WHERE id IN (${idList})`);
  console.log(`Deleted ${targets.length} accounts and every row attached to them.`);
  console.log(`Rows affected on users: ${result.rowsAffected || 'n/a'}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Cleanup failed:', error.message);
    process.exit(1);
  });
