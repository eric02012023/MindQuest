/**
 * ANNOTATED COPY FOR DEFENSE REVIEW
 * File: scripts/drop-non-admin-users.js
 * Purpose: Source file for scripts/drop-non-admin-users.js. This annotated copy adds reviewer-friendly comments to explain the purpose of the code.
 * Notes: Comments were added to help explain the system during code defense without changing the original logic.
 */

/**
 * drop-non-admin-users.js
 *
 * Deletes ALL users except those with role = 'admin'.
 * Also cleans up all related data (attendance, assignments, billing, etc.)
 *
 * Usage:
 *   node scripts/drop-non-admin-users.js
 */

require('dotenv').config();
const { query } = require('../config/db');

// Function: dropNonAdminUsers

// Role: Handles a reusable server-side operation used by this module.

async function dropNonAdminUsers() {
  console.log('Starting cleanup — deleting all non-admin users and related data...\n');

  // Step 1: Delete all related data first (foreign key order)
  const steps = [
    ['Notifications',               `DELETE FROM notifications`],
    ['Payment history',             `DELETE FROM payment_history`],
    ['SOA posts',                   `DELETE FROM soa_posts`],
    ['Attendance',                  `DELETE FROM attendance`],
    ['Messages',                    `DELETE FROM messages`],
    ['Assessment results',          `DELETE FROM assessment_results`],
    ['Assessment questions',        `DELETE FROM assessment_questions`],
    ['Assessments',                 `DELETE FROM assessments`],
    ['User subject assignments',    `DELETE FROM user_subject_assignments`],
    ['Subject enrollment requests', `DELETE FROM subject_enrollment_requests`],
    ['Tutor schedule applications', `DELETE FROM tutor_schedule_applications`],
    ['Billing',                     `DELETE FROM billing`],
    ['Submissions',                 `DELETE FROM submissions`],
    ['Subject resources',           `DELETE FROM subject_resources`],
  ];

  for (const [label, sql] of steps) {
    try {
      await query(sql);
      console.log(`  ✓ Cleared: ${label}`);
    } catch (err) {
      // Table might not exist in all versions — skip gracefully
      console.log(`  - Skipped (not found): ${label}`);
    }
  }

  // Step 2: Count non-admin users before deletion
  const countRows = await query(`SELECT COUNT(*) AS total FROM users WHERE role <> 'admin'`);
  const total = countRows[0]?.total || 0;
  console.log(`\n  Found ${total} non-admin user(s) to delete.`);

  // Step 3: Delete all non-admin users
  await query(`DELETE FROM users WHERE role <> 'admin'`);
  console.log(`  ✓ Deleted all non-admin users.\n`);

  // Step 4: Show remaining admin users
  const adminRows = await query(`SELECT id, user_id, role, email, first_name, last_name FROM users WHERE role = 'admin'`);
  console.log(`Remaining admin account(s): ${adminRows.length}`);
  for (const admin of adminRows) {
    console.log(`  - [${admin.user_id}] ${admin.first_name} ${admin.last_name} <${admin.email}>`);
  }

  console.log('\nDone. All non-admin users have been removed.');
  process.exit(0);
}

dropNonAdminUsers().catch((err) => {
  console.error('\nError during cleanup:', err.message || err);
  process.exit(1);
});
