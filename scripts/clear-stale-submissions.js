/**
 * ANNOTATED COPY FOR DEFENSE REVIEW
 * File: scripts/clear-stale-submissions.js
 * Purpose: Source file for scripts/clear-stale-submissions.js. This annotated copy adds reviewer-friendly comments to explain the purpose of the code.
 * Notes: Comments were added to help explain the system during code defense without changing the original logic.
 */

/**
 * clear-stale-submissions.js
 *
 * Cleans up old accepted/archived submissions so they no longer
 * block new registrations with the same name.
 *
 * Usage:
 *   node scripts/clear-stale-submissions.js
 */
require('dotenv').config();
const { query } = require('../config/db');

// Function: run

// Role: Handles a reusable server-side operation used by this module.

async function run() {
  console.log('Cleaning up stale submissions...\n');

  // Mark all accepted submissions as archived (they already became users)
  await query(
    `UPDATE submissions SET status = 'cancelled', archived = 1, updated_at = SYSDATETIME()
     WHERE status = 'accepted'`
  );
  console.log('  ✓ Archived accepted submissions.');

  // Archive any cancelled submissions too
  await query(
    `UPDATE submissions SET archived = 1, updated_at = SYSDATETIME()
     WHERE archived = 0 AND status = 'cancelled'`
  );
  console.log('  ✓ Archived cancelled submissions.');

  // Show remaining active submissions
  const rows = await query(
    `SELECT status, archived, COUNT(*) AS total FROM submissions GROUP BY status, archived`
  );
  console.log('\nCurrent submissions summary:');
  for (const r of rows) {
    console.log(`  status=${r.status}, archived=${r.archived}, total=${r.total}`);
  }

  console.log('\nDone. Stale submissions cleaned up.');
  process.exit(0);
}

run().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
