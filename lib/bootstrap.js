/**
 
 * File: lib/bootstrap.js
 * Purpose: Database bootstrap and seeding logic. This file creates the database if needed, applies schema updates, inserts default branches/subjects, and prepares the default admin account.
 logic.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sql = require('mssql');
const bcrypt = require('bcryptjs');
const { baseConfig } = require('../config/db');

const dbName = process.env.DB_NAME || 'mindquest1_db';
const defaultAdminEmail = String(process.env.DEFAULT_ADMIN_EMAIL || 'admin@mindquest.local').trim().toLowerCase();
const defaultAdminPassword = String(process.env.DEFAULT_ADMIN_PASSWORD || 'Admin@12345');

const defaultBranches = [
  'MAIN BRANCH',
  'MABUHAY BRANCH',
  'FATIMA BRANCH',
  'CALUMPANG BRANCH',
  'BAWING BRANCH'
];

const defaultSubjects = [
  'READING & WRITING',
  'MATHEMATICS (BASIC TO ADVANCE)',
  'ARALING PANLIPUNAN (AP)',
  'ENGLISH',
  'SCIENCE',
  'FILIPINO',
  'EXAM PREPARATION & REVIEWS',
  'HOMEWORK ASSISTANCE',
  'PROJECT GUIDANCE'
];

// Function: bootstrapDatabase

// Role: Handles a reusable server-side operation used by this module.

async function bootstrapDatabase() {
  /*
  const masterPool = await new sql.ConnectionPool({ ...baseConfig, database: 'master' }).connect();
  try {
    const createDbSql = `IF DB_ID(N'${dbName.replace(/'/g, "''")}') IS NULL BEGIN CREATE DATABASE [${dbName.replace(/]/g, ']]')}]; END`;
    await masterPool.request().query(createDbSql);
  } finally {
    await masterPool.close();
  }
  */

  const dbPool = await new sql.ConnectionPool({ ...baseConfig, database: dbName }).connect();
  try {
    const schemaPath = path.join(__dirname, '..', 'sql', 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await dbPool.request().batch(schemaSql);

    await dbPool.request().batch(`
      UPDATE subjects
      SET name = UPPER(LTRIM(RTRIM(name))), updated_at = DATEADD(hour, 8, GETUTCDATE())
      WHERE name <> UPPER(LTRIM(RTRIM(name)));
    `);

    /*
     * Re-price every account from the subjects it actually holds (Phase 4.1).
     *
     * WHAT THIS USED TO DO, AND WHY IT HAD TO CHANGE
     * It wrote a flat ₱1,800 over EVERY billing row on every single boot, and
     * clamped partial_payment down to that ceiling. Three things were wrong:
     *
     *   1. It contradicted the pricing rule. A two-subject student owes ₱3,600,
     *      and this reset them to ₱1,800 every time the server restarted — so
     *      the ₱1,800-per-subject rule could never survive a deploy.
     *   2. `partial_payment > 1800` was DESTROYED rather than preserved. A
     *      student who had paid ₱3,600 across two subjects had ₱1,800 of real,
     *      recorded money silently deleted from their summary.
     *   3. It ran unconditionally, so a boot was a write to every row.
     *
     * The version below derives full_bill from the live enrolment count and
     * never lowers it below what has been paid. Accounts with no active subject
     * are left alone — a student between terms still owes their arrears, and
     * zeroing the bill would write them off.
     */
    await dbPool.request().batch(`
      DECLARE @SubjectMonthlyFee DECIMAL(10,2) = 1800.00;
      IF COL_LENGTH('billing', 'full_bill') IS NOT NULL
         AND OBJECT_ID('dbo.user_subject_assignments', 'U') IS NOT NULL
      BEGIN
        WITH priced AS (
          SELECT b.id,
                 -- What the subjects come to, but never less than the money
                 -- already received against this account.
                 CASE WHEN counts.subject_count * @SubjectMonthlyFee < paid.total
                      THEN paid.total
                      ELSE counts.subject_count * @SubjectMonthlyFee
                 END AS new_full_bill,
                 paid.total AS paid_total
            FROM billing b
           CROSS APPLY (
              SELECT COUNT(*) AS subject_count
                FROM user_subject_assignments usa
               WHERE usa.student_id = b.student_id AND usa.is_archived = 0
           ) counts
           CROSS APPLY (
              SELECT CASE WHEN b.partial_payment > COALESCE(SUM(pe.amount), 0)
                          THEN b.partial_payment ELSE COALESCE(SUM(pe.amount), 0) END AS total
                FROM payment_entries pe
               WHERE pe.billing_id = b.id
           ) paid
           WHERE counts.subject_count > 0
        )
        UPDATE b
           SET full_bill = p.new_full_bill,
               partial_payment = p.paid_total,
               for_settlement = CASE WHEN p.new_full_bill - p.paid_total < 0 THEN 0
                                     ELSE p.new_full_bill - p.paid_total END,
               payment_status = CASE
                 WHEN p.paid_total >= p.new_full_bill THEN 'paid'
                 WHEN p.paid_total > 0 THEN 'partial'
                 ELSE 'unpaid'
               END,
               updated_at = DATEADD(hour, 8, GETUTCDATE())
          FROM billing b
          INNER JOIN priced p ON p.id = b.id
         WHERE b.full_bill <> p.new_full_bill
            OR b.partial_payment <> p.paid_total;
      END;
    `);

    await dbPool.request().batch(`
      IF EXISTS (SELECT 1 FROM branches WHERE UPPER(LTRIM(RTRIM(name))) = 'CONEL BRANCH')
         AND NOT EXISTS (SELECT 1 FROM branches WHERE UPPER(LTRIM(RTRIM(name))) = 'MAIN BRANCH')
      BEGIN
        UPDATE branches SET name = 'MAIN BRANCH' WHERE UPPER(LTRIM(RTRIM(name))) = 'CONEL BRANCH';
      END;
      IF EXISTS (SELECT 1 FROM branches WHERE UPPER(LTRIM(RTRIM(name))) = 'CONEL BRANCH')
         AND EXISTS (SELECT 1 FROM branches WHERE UPPER(LTRIM(RTRIM(name))) = 'MAIN BRANCH')
      BEGIN
        UPDATE users SET branch_id = (SELECT TOP 1 id FROM branches WHERE UPPER(LTRIM(RTRIM(name))) = 'MAIN BRANCH')
        WHERE branch_id IN (SELECT id FROM branches WHERE UPPER(LTRIM(RTRIM(name))) = 'CONEL BRANCH');
        UPDATE users SET assistant_scope_branch_id = (SELECT TOP 1 id FROM branches WHERE UPPER(LTRIM(RTRIM(name))) = 'MAIN BRANCH')
        WHERE assistant_scope_branch_id IN (SELECT id FROM branches WHERE UPPER(LTRIM(RTRIM(name))) = 'CONEL BRANCH');
        UPDATE submissions SET branch_id = (SELECT TOP 1 id FROM branches WHERE UPPER(LTRIM(RTRIM(name))) = 'MAIN BRANCH')
        WHERE branch_id IN (SELECT id FROM branches WHERE UPPER(LTRIM(RTRIM(name))) = 'CONEL BRANCH');
        UPDATE user_subject_assignments SET branch_id = (SELECT TOP 1 id FROM branches WHERE UPPER(LTRIM(RTRIM(name))) = 'MAIN BRANCH')
        WHERE branch_id IN (SELECT id FROM branches WHERE UPPER(LTRIM(RTRIM(name))) = 'CONEL BRANCH');
        DELETE FROM branches WHERE UPPER(LTRIM(RTRIM(name))) = 'CONEL BRANCH';
      END;
    `);

    for (const branch of defaultBranches) {
      await dbPool.request()
        .input('name', sql.NVarChar(120), branch)
        .query(`IF NOT EXISTS (SELECT 1 FROM branches WHERE UPPER(LTRIM(RTRIM(name))) = UPPER(LTRIM(RTRIM(@name)))) INSERT INTO branches (name, is_archived) VALUES (@name, 0);`);
    }

    for (const subject of defaultSubjects) {
      await dbPool.request()
        .input('name', sql.NVarChar(160), subject)
        .query(`IF NOT EXISTS (SELECT 1 FROM subjects WHERE name = @name) INSERT INTO subjects (name, is_archived) VALUES (@name, 0);`);
    }

    const adminRows = await dbPool.request().input('email', sql.NVarChar(150), defaultAdminEmail).query("SELECT TOP 1 id FROM users WHERE role = 'admin'");
    if (!adminRows.recordset.length) {
      const passwordHash = await bcrypt.hash(defaultAdminPassword, 10);
      await dbPool.request()
        .input('user_id', sql.NVarChar(50), 'ADM-0001')
        .input('password_hash', sql.NVarChar(255), passwordHash)
        .input('first_name', sql.NVarChar(100), 'System')
        .input('middle_name', sql.NVarChar(100), '')
        .input('last_name', sql.NVarChar(100), 'Administrator')
        .input('email', sql.NVarChar(150), defaultAdminEmail)
        .input('contact_number', sql.NVarChar(50), '+639099879424')
        .query(`INSERT INTO users (
          user_id, role, password_hash, first_name, middle_name, last_name,
          branch_id, assistant_scope_branch_id, email, contact_number, status, is_archived
        ) VALUES (
          @user_id, 'admin', @password_hash, @first_name, @middle_name, @last_name,
          NULL, NULL, @email, @contact_number, 'approved', 0
        )`);
    } else {
      const passwordHash = await bcrypt.hash(defaultAdminPassword, 10);
      await dbPool.request()
        .input('email', sql.NVarChar(150), defaultAdminEmail)
        .input('password_hash', sql.NVarChar(255), passwordHash)
        .query(`UPDATE users SET email = @email, password_hash = @password_hash, is_archived = 0, status = 'approved', updated_at = DATEADD(hour, 8, GETUTCDATE()) WHERE role = 'admin'`);
    }

    return { dbName, defaultAdminEmail, defaultAdminPassword };
  } finally {
    await dbPool.close();
  }
}

module.exports = { bootstrapDatabase, defaultBranches, defaultSubjects, dbName };
