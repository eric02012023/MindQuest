/**
 * File: scripts/backup-billing.js
 * Purpose: Take a restorable snapshot of the billing tables before the upgrade
 *          migration rewrites them.
 *
 * Run:  node scripts/backup-billing.js --env .env.live
 *       node scripts/backup-billing.js --env .env.local --out backups/
 *
 * WHY THIS EXISTS
 * The management upgrade re-derives `billing.partial_payment`, `for_settlement`,
 * `payment_status` and `last_paid_at` for EVERY student from the new
 * payment_entries ledger. That is the intended behaviour, and it is also the one
 * change in the release that cannot be undone by redeploying the old code — the
 * old numbers are gone once they are overwritten.
 *
 * Somee's shared plans do not generally grant `BACKUP DATABASE`, so a scripted
 * export of the tables actually at risk is the practical safety net. This script
 * only ever READS: it opens a connection, selects, and writes a file. It cannot
 * modify anything, so it is safe to run against production at any time.
 *
 * WHAT IT WRITES
 * One timestamped .sql file containing, for each table:
 *   1. a full INSERT dump of every row as it stands right now
 *   2. for `billing`, ready-to-run UPDATE statements that put the four
 *      migrated columns back exactly as they were
 *
 * The UPDATEs are the realistic restore path. The rows still exist after the
 * migration with the same ids — only those four columns move — so putting them
 * back is an UPDATE, not a re-insert, and it needs no downtime.
 */

const envArgIndex = process.argv.indexOf('--env');
const envFile = envArgIndex > -1 ? process.argv[envArgIndex + 1] : '.env';
require('dotenv').config({ path: envFile });

const fs = require('fs');
const path = require('path');
const sql = require('mssql');
const { baseConfig } = require('../config/db');

const outArgIndex = process.argv.indexOf('--out');
const outDir = outArgIndex > -1
  ? process.argv[outArgIndex + 1]
  : path.join(__dirname, '..', 'backups');

/** Tables to capture. `billing` is the one the migration rewrites. */
const TABLES = ['billing', 'payment_history', 'soa_posts', 'payment_entries'];

/** The four columns the migration re-derives, and so the four to be able to undo. */
const MIGRATED_COLUMNS = ['partial_payment', 'for_settlement', 'payment_status', 'last_paid_at'];

/**
 * Render one JS value as a T-SQL literal.
 * Strings are N'' quoted with doubled apostrophes; dates go out in ISO so they
 * round-trip regardless of the server's language setting.
 */
function literal(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'NULL' : `'${value.toISOString().replace('T', ' ').replace('Z', '')}'`;
  }
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`;
  return `N'${String(value).replace(/'/g, "''")}'`;
}

async function main() {
  console.log(`env file : ${envFile}`);
  console.log(`server   : ${baseConfig.server}`);
  console.log(`database : ${baseConfig.database}`);
  console.log('mode     : READ ONLY — this script cannot modify anything');
  console.log('');

  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outFile = path.join(outDir, `billing-backup-${baseConfig.database}-${stamp}.sql`);

  const pool = await new sql.ConnectionPool({ ...baseConfig }).connect();
  const lines = [];
  const counts = {};

  lines.push('-- MindQuest billing snapshot');
  lines.push(`-- database : ${baseConfig.database} on ${baseConfig.server}`);
  lines.push(`-- taken    : ${new Date().toISOString()}`);
  lines.push('--');
  lines.push('-- Taken before the management upgrade re-derived every billing summary');
  lines.push('-- from the new payment_entries ledger.');
  lines.push('--');
  lines.push('-- TO UNDO THE MIGRATION: run only the "RESTORE" section at the end. It puts');
  lines.push('-- the four migrated columns back on rows that still exist, so it needs no');
  lines.push('-- downtime and touches nothing else.');
  lines.push('');

  try {
    for (const table of TABLES) {
      const exists = await pool.request().query(
        `SELECT CASE WHEN OBJECT_ID('dbo.${table}','U') IS NULL THEN 0 ELSE 1 END AS present`
      );
      if (!exists.recordset[0].present) {
        console.log(`  skip     ${table} (does not exist yet)`);
        lines.push(`-- ${table}: table does not exist in this database`);
        lines.push('');
        continue;
      }

      const result = await pool.request().query(`SELECT * FROM dbo.${table}`);
      const rows = result.recordset;
      const columns = rows.length ? Object.keys(rows[0]) : [];
      counts[table] = rows.length;
      console.log(`  captured ${table.padEnd(16)} ${rows.length} row(s)`);

      lines.push(`-- ============================================================`);
      lines.push(`-- ${table} — ${rows.length} row(s)`);
      lines.push(`-- ============================================================`);
      if (!rows.length) {
        lines.push(`-- (empty)`);
        lines.push('');
        continue;
      }

      // IDENTITY_INSERT so an id column round-trips if a full re-insert is ever
      // needed. Harmless when the table has no identity column beyond `id`.
      lines.push(`-- SET IDENTITY_INSERT dbo.${table} ON;`);
      for (const row of rows) {
        const values = columns.map((c) => literal(row[c])).join(', ');
        lines.push(`-- INSERT INTO dbo.${table} (${columns.join(', ')}) VALUES (${values});`);
      }
      lines.push(`-- SET IDENTITY_INSERT dbo.${table} OFF;`);
      lines.push('');
    }

    // ------------------------------------------------------------- restore
    const billing = await pool.request().query(
      `SELECT id, student_id, full_bill, ${MIGRATED_COLUMNS.join(', ')} FROM dbo.billing ORDER BY id`
    );

    lines.push('-- ============================================================');
    lines.push('-- RESTORE — put the migrated columns back exactly as they were');
    lines.push('-- ============================================================');
    lines.push('-- Uncomment this block and run it to undo the billing migration.');
    lines.push('-- Everything above is reference only.');
    lines.push('');
    lines.push('/*');
    lines.push('BEGIN TRANSACTION;');
    for (const row of billing.recordset) {
      const sets = MIGRATED_COLUMNS.map((c) => `${c} = ${literal(row[c])}`).join(', ');
      lines.push(`UPDATE dbo.billing SET ${sets} WHERE id = ${row.id};   -- student_id ${row.student_id}`);
    }
    lines.push('-- Check the numbers look right, then:');
    lines.push('COMMIT TRANSACTION;   -- or ROLLBACK TRANSACTION;');
    lines.push('*/');
    lines.push('');

    fs.writeFileSync(outFile, lines.join('\n'), 'utf8');

    const totalBilled = billing.recordset.reduce((s, r) => s + Number(r.full_bill || 0), 0);
    const totalPaid = billing.recordset.reduce((s, r) => s + Number(r.partial_payment || 0), 0);

    console.log('');
    console.log(`Written: ${outFile}`);
    console.log(`         ${(fs.statSync(outFile).size / 1024).toFixed(1)} KB`);
    console.log('');
    console.log('Figures at the moment of the snapshot — check these match after the migration:');
    console.log(`  billing accounts : ${billing.recordset.length}`);
    console.log(`  total billed     : ${totalBilled.toFixed(2)}`);
    console.log(`  total paid       : ${totalPaid.toFixed(2)}`);
    console.log('');
    console.log('Keep this file somewhere outside the repository before deploying.');
  } finally {
    await pool.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('');
    console.error('Failed:', error.message);
    process.exit(1);
  });
