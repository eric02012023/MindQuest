/**
 * File: scripts/renumber-forced-modules.js
 * Purpose: Give back the module numbers the old one-number-per-subject rule took.
 *
 * Run:  node scripts/renumber-forced-modules.js            (dry run: prints the plan)
 *       node scripts/renumber-forced-modules.js --commit   (applies it)
 *
 * WHY
 * Module numbers used to be unique across a whole subject, so once Grade 3
 * Mathematics had Modules 1 and 2, the first Grade 6 Mathematics module had to
 * be called Module 3 — although its own handout is "Grade6_Module1_Mathematics.pdf".
 * Numbers now count within a grade (lib/data.js, resolveModuleNumber), and this
 * moves such a module to the number its handouts carry.
 *
 * A module is renumbered only when every handout on it names the same module
 * number, that number differs from the module's, and no other live module of
 * the same subject and grade holds it. Anything less certain is left alone and
 * listed, for the admin to settle from Module Settings.
 */

const envIndex = process.argv.indexOf('--env');
require('dotenv').config({ path: envIndex > -1 ? process.argv[envIndex + 1] : '.env' });

const { query, getPool } = require('../config/db');
const { moduleGradeOf } = require('../lib/moduleGrades');

const COMMIT = process.argv.includes('--commit');

/** "Grade6_Module1_Mathematics.pdf" -> 1; null when the name carries no number. */
function moduleNumberIn(fileName) {
  const match = String(fileName || '').match(/module[\s_-]*(\d{1,2})(?!\d)/i);
  return match ? Number(match[1]) : null;
}

async function main() {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try { await query('SELECT 1 AS ok'); break; } catch (error) {
      console.log(`connect attempt ${attempt}: ${error.message}`);
      if (attempt === 6) throw error;
    }
  }
  console.log(COMMIT ? 'APPLYING.\n' : 'DRY RUN — nothing is written. Add --commit to apply.\n');

  const modules = await query(
    `SELECT m.id, m.subject_id, s.name AS subject_name, m.order_number, m.title, m.grade_level, m.target_year_levels_json
       FROM modules m JOIN subjects s ON s.id = m.subject_id WHERE m.is_archived = 0`
  );
  const handouts = await query(
    'SELECT module_id, file_original_name FROM module_handouts WHERE is_archived = 0'
  );

  let changed = 0;
  for (const mod of modules) {
    const grade = moduleGradeOf(mod);
    const numbers = [...new Set(handouts
      .filter((h) => Number(h.module_id) === Number(mod.id))
      .map((h) => moduleNumberIn(h.file_original_name)))];
    if (!grade || numbers.length !== 1 || numbers[0] === null) continue;
    const wanted = numbers[0];
    if (wanted === Number(mod.order_number)) continue;

    const holder = modules.find((other) => Number(other.id) !== Number(mod.id)
      && Number(other.subject_id) === Number(mod.subject_id)
      && moduleGradeOf(other) === grade
      && Number(other.order_number) === wanted);
    if (holder) {
      console.log(`  leave  ${mod.subject_name} ${grade} Module ${mod.order_number} "${mod.title}": its handout says Module ${wanted}, but "${holder.title}" holds it`);
      continue;
    }

    console.log(`  renumber  ${mod.subject_name} ${grade}: Module ${mod.order_number} -> Module ${wanted}  "${mod.title}" (handout says Module ${wanted})`);
    if (COMMIT) {
      await query(
        `UPDATE modules SET order_number = ?, updated_at = DATEADD(hour, 8, GETUTCDATE())
          WHERE id = ? AND order_number = ? AND is_archived = 0`,
        [wanted, mod.id, mod.order_number]
      );
    }
    changed++;
  }
  console.log(`\n${changed} module(s) ${COMMIT ? 'renumbered' : 'would be renumbered'}.`);
  (await getPool()).close();
}

main().catch((error) => { console.error('FAILED:', error.message); process.exit(1); });
