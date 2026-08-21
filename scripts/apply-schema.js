/**
 * File: scripts/apply-schema.js
 * Purpose: Apply sql/schema.sql to a chosen database, without starting the app.
 *
 * Run:  node scripts/apply-schema.js                  (uses .env)
 *       node scripts/apply-schema.js --env .env.local (uses that file)
 *       node scripts/apply-schema.js --check          (parse only, no changes)
 *
 * WHY THIS EXISTS
 * The server applies schema.sql at boot (lib/bootstrap.js), which is convenient
 * and also means the first time you find out a statement is wrong is when the
 * app will not start. This runs the same file on demand, prints which database
 * it is about to touch, and can parse-check without executing — so a schema
 * change can be verified against a local copy before it is anywhere near live.
 *
 * schema.sql is written to be idempotent: every CREATE is guarded by an
 * OBJECT_ID check and every ALTER by a COL_LENGTH check, so running this twice
 * changes nothing the second time.
 */

const envArgIndex = process.argv.indexOf('--env');
const envFile = envArgIndex > -1 ? process.argv[envArgIndex + 1] : '.env';
require('dotenv').config({ path: envFile });

const fs = require('fs');
const path = require('path');
const sql = require('mssql');
const { baseConfig } = require('../config/db');

const checkOnly = process.argv.includes('--check');
const schemaPath = path.join(__dirname, '..', 'sql', 'schema.sql');

async function main() {
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  console.log(`env file : ${envFile}`);
  console.log(`server   : ${baseConfig.server}`);
  console.log(`database : ${baseConfig.database}`);
  console.log(`schema   : ${schemaPath} (${schemaSql.length.toLocaleString()} characters)`);
  console.log('');

  const pool = await new sql.ConnectionPool({ ...baseConfig }).connect();
  try {
    if (checkOnly) {
      // SET NOEXEC ON makes SQL Server parse and bind the whole batch without
      // running any of it — the cheapest way to prove the file is valid against
      // this database's actual shape.
      await pool.request().batch(`SET NOEXEC ON;\n${schemaSql}\nSET NOEXEC OFF;`);
      console.log('Parsed cleanly. Nothing was executed (--check).');
    } else {
      await pool.request().batch(schemaSql);
      console.log('Schema applied.');

      const tables = [
        'payment_requests', 'payment_entries', 'app_notifications',
        'assessment_violations', 'focus_handouts'
      ];
      const rows = await pool.request().query(
        `SELECT name FROM sys.tables WHERE name IN (${tables.map((t) => `'${t}'`).join(',')}) ORDER BY name`
      );
      const present = rows.recordset.map((r) => r.name);
      console.log('');
      console.log('Management-upgrade tables:');
      for (const table of tables) {
        console.log(`  ${present.includes(table) ? 'OK     ' : 'MISSING'} ${table}`);
      }

      // Report the migration honestly: how much of the old payment history made
      // it across, and how much could not because the student or billing record
      // it pointed at no longer exists. A silent "0 migrated" would look like
      // success on a database that had a decade of payments in it.
      const audit = await pool.request().query(`
        SELECT
          (SELECT COUNT(*) FROM dbo.payment_entries) AS entries,
          (SELECT COUNT(*) FROM dbo.payment_history WHERE amount > 0) AS legacy_payments,
          (SELECT COUNT(*) FROM dbo.payment_history ph
             WHERE ph.amount > 0
               AND (NOT EXISTS (SELECT 1 FROM dbo.users u WHERE u.id = ph.student_id)
                 OR NOT EXISTS (SELECT 1 FROM dbo.billing b WHERE b.id = ph.billing_id))) AS orphaned,
          (SELECT COUNT(*) FROM dbo.billing b
             WHERE b.partial_payment <> (SELECT COALESCE(SUM(pe.amount), 0)
                                           FROM dbo.payment_entries pe WHERE pe.billing_id = b.id)) AS out_of_sync
      `);
      const a = audit.recordset[0];
      console.log('');
      console.log(`payment_entries rows        : ${a.entries}`);
      console.log(`legacy payments (amount > 0): ${a.legacy_payments}`);
      console.log(`  of which orphaned         : ${a.orphaned} (student or billing record deleted — left in payment_history)`);
      console.log(`billing rows out of sync    : ${a.out_of_sync}`);
    }
  } finally {
    await pool.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('');
    console.error('Failed:', error.message);
    if (error.precedingErrors) {
      error.precedingErrors.forEach((e) => console.error('  -', e.message));
    }
    process.exit(1);
  });
