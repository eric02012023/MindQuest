/**
 * File: scripts/backfill-focus-handouts.js
 * Purpose: Build the focus material for Pre-Assessments that were sat before the
 *          feature existed, so their tutors are not looking at an empty page.
 *
 * Run:  node scripts/backfill-focus-handouts.js --env .env.live --dry-run
 *       node scripts/backfill-focus-handouts.js --env .env.live
 *       node scripts/backfill-focus-handouts.js --env .env.live --quiet
 *
 * WHY THIS EXISTS
 * A finished Pre-Assessment is supposed to produce a focus handout for the
 * student's tutor: the topics they scored worst on, with a plan for teaching
 * them. That happens in the submit handler, so it only ever runs at the moment a
 * student presses submit.
 *
 * Students who sat the Pre-Assessment before focus_handouts existed therefore
 * have nothing, and never will — the one code path that could build it has been
 * and gone. Their tutor opens Focus Areas and sees an empty list, which reads as
 * "the feature is broken" rather than "this ran before the feature shipped".
 *
 * Nothing is missing from the data: the per-question grading, the module each
 * question came from, and the tutor assignment are all still there. This walks
 * the Pre-Assessment submissions that have no focus handout and runs the SAME
 * generator the submit handler runs, so a backfilled handout is identical to one
 * made at submit time.
 *
 * Re-running is safe: generateFocusHandout is keyed on submission_id and updates
 * rather than inserting, and this only picks up submissions that have none.
 *
 * --dry-run lists what it would build and writes nothing.
 * --quiet builds the handouts without sending each tutor a notification. Use it
 *   when backfilling a large backlog; the default notifies, which is what would
 *   have happened at the time.
 */

const envArgIndex = process.argv.indexOf('--env');
const envFile = envArgIndex > -1 ? process.argv[envArgIndex + 1] : '.env';
require('dotenv').config({ path: envFile });

const { query } = require('../config/db');
const { baseConfig } = require('../config/db');
const { generateFocusHandout, runPreAssessmentFollowUp } = require('../lib/focusHandouts');

const dryRun = process.argv.includes('--dry-run');
const quiet = process.argv.includes('--quiet');

async function main() {
  console.log(`env file : ${envFile}`);
  console.log(`server   : ${baseConfig.server}`);
  console.log(`database : ${baseConfig.database}`);
  console.log(`mode     : ${dryRun ? 'DRY RUN — nothing will be written' : quiet ? 'build, do not notify' : 'build and notify each tutor'}`);
  console.log('');

  const pending = await query(
    `SELECT sub.id AS submission_id, sub.student_id, sub.percentage, sub.submitted_at,
            ta.id AS assessment_id, ta.subject_id, s.name AS subject_name,
            u.user_id AS student_code,
            LTRIM(RTRIM(COALESCE(u.first_name,'') + ' ' + COALESCE(u.last_name,''))) AS student_name,
            (SELECT TOP 1 usa.tutor_id FROM user_subject_assignments usa
              WHERE usa.student_id = sub.student_id AND usa.subject_id = ta.subject_id
                AND usa.is_archived = 0 AND usa.tutor_id IS NOT NULL
              ORDER BY usa.assigned_at DESC, usa.id DESC) AS tutor_id
       FROM tutor_assessment_submissions sub
       JOIN tutor_assessments ta ON ta.id = sub.assessment_id
       JOIN subjects s ON s.id = ta.subject_id
       JOIN users u ON u.id = sub.student_id
      WHERE ta.assessment_kind = 'pre_assessment'
        AND NOT EXISTS (SELECT 1 FROM focus_handouts fh WHERE fh.submission_id = sub.id)
      ORDER BY sub.submitted_at ASC`
  );

  if (!pending.length) {
    console.log('Every Pre-Assessment already has its focus handout. Nothing to do.');
    return;
  }

  console.log(`${pending.length} Pre-Assessment(s) without focus material:`);
  for (const row of pending) {
    console.log(`  submission #${row.submission_id}  ${row.student_name} (${row.student_code})`);
    console.log(`    ${row.subject_name} · ${Number(row.percentage).toFixed(1)}% · sat ${new Date(row.submitted_at).toLocaleString()}`
      + `${row.tutor_id ? '' : ' · NO TUTOR ASSIGNED — the handout is still built, but nobody is notified'}`);
  }
  console.log('');

  if (dryRun) {
    console.log('Dry run. Nothing was written.');
    return;
  }

  let built = 0;
  let failed = 0;
  for (const row of pending) {
    const input = {
      submissionId: row.submission_id,
      studentId: row.student_id,
      subjectId: row.subject_id,
      assessmentId: row.assessment_id
    };
    try {
      // runPreAssessmentFollowUp swallows its own errors and returns null, so a
      // null here means "could not build", not "threw".
      const handout = quiet ? await generateFocusHandout(input) : await runPreAssessmentFollowUp(input);
      if (!handout) {
        failed++;
        console.log(`  FAILED  submission #${row.submission_id} — the generator returned nothing`);
        continue;
      }
      built++;
      const topics = (handout.weak_topics || []).length;
      console.log(`  built   submission #${row.submission_id} — "${handout.title}"`);
      console.log(`          ${topics} weak topic(s), written by ${handout.generated_by}`
        + `${handout.tutor_id ? `, flagged for tutor #${handout.tutor_id}` : ', no tutor to flag'}`);
    } catch (error) {
      failed++;
      console.log(`  FAILED  submission #${row.submission_id} — ${error.message}`);
    }
  }

  console.log('');
  console.log(`${built} built, ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((error) => {
    console.error('');
    console.error('Failed:', error.message);
    process.exit(1);
  });
