/**
 * File: scripts/remove-stray-records.js
 * Purpose: Remove the records the old rules let in, and refresh what was built
 *          from them.
 *
 * Run:  node scripts/remove-stray-records.js            (dry run: prints the plan)
 *       node scripts/remove-stray-records.js --commit   (applies it)
 *
 * WHAT, AND WHY
 *
 * 1. Module assessments taken by a student of ANOTHER grade (submissions 1011,
 *    1012, 1013, 1016), and the module opens that came with them. Before
 *    modules had one grade, a Grade 3 module showed to every Primary student, so
 *    a Grade 6 student answered Grade 3 quizzes and a Grade 3 student a Grade 6
 *    one. Those scores are not a measure of anything the student was taught,
 *    and the Grade 3 student's level on record came from the Grade 6 quiz.
 *    Each is removed only while its module's grade still differs from the
 *    student's.
 *
 * 2. Tutor assessments #2 ("grgrdg", "gdrhdr") and #3 ("name mo?", "tama ka?",
 *    "ikaw ba si ano?"): test entries with no real question, inside the
 *    archived Reading & Writing module 1. Two students' levels on record were
 *    set by #2's two-question quiz, not by their 30-item Pre-Assessment.
 *
 * 3. Afterwards, the level on record of every student touched is re-derived
 *    from their latest remaining submission (the rule sql/schema.sql applies on
 *    boot), and student 46's Mathematics focus handout — written from the marks
 *    before scripts/repair-answer-keys.js corrected them — is written again.
 *
 * Every delete is guarded on the row still being exactly what was audited on
 * 2026-10-14, so a second run changes nothing.
 */

const envIndex = process.argv.indexOf('--env');
require('dotenv').config({ path: envIndex > -1 ? process.argv[envIndex + 1] : '.env' });

const { query, withTransaction, getPool } = require('../config/db');
const { moduleGradeOf, studentGradeOf } = require('../lib/moduleGrades');

const COMMIT = process.argv.includes('--commit');

/** Module-assessment attempts made across grades (audited 2026-10-14). */
const CROSS_GRADE = [
  { submissionId: 1011, studentId: 236, assessmentId: 1013 },
  { submissionId: 1012, studentId: 236, assessmentId: 1021 },
  { submissionId: 1013, studentId: 236, assessmentId: 1018 },
  { submissionId: 1016, studentId: 46, assessmentId: 1022 }
];

/** Test assessments with no real question. */
const JUNK = [
  { assessmentId: 2, title: 'module 1 assessment', questions: ['grgrdg', 'gdrhdr'] },
  { assessmentId: 3, title: 'quiz', questions: ['name mo?', 'tama ka?', 'ikaw ba si ano?'] }
];

/** The focus handout built from marks that have since been corrected. */
const FOCUS_REFRESH = [{ submissionId: 1007, studentId: 46, subjectId: 2, assessmentId: 1012 }];

const list = (ids) => ids.map(() => '?').join(',');

async function main() {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try { await query('SELECT 1 AS ok'); break; } catch (error) {
      console.log(`connect attempt ${attempt}: ${error.message}`);
      if (attempt === 6) throw error;
    }
  }
  console.log(COMMIT ? 'APPLYING.\n' : 'DRY RUN — nothing is written. Add --commit to apply.\n');

  // ---- 1. attempts across grades ------------------------------------------
  const crossRows = await query(
    `SELECT sub.id, sub.student_id, sub.assessment_id, ta.module_id,
            m.grade_level, m.target_year_levels_json, u.grade_level AS student_grade, u.year_level
       FROM tutor_assessment_submissions sub
       JOIN tutor_assessments ta ON ta.id = sub.assessment_id
       JOIN modules m ON m.id = ta.module_id
       JOIN users u ON u.id = sub.student_id
      WHERE sub.id IN (${list(CROSS_GRADE.map((c) => c.submissionId))})`,
    CROSS_GRADE.map((c) => c.submissionId)
  );
  const crossIds = [];
  for (const audited of CROSS_GRADE) {
    const row = crossRows.find((r) => Number(r.id) === audited.submissionId);
    if (!row) { console.log(`  done  submission ${audited.submissionId}: already gone`); continue; }
    const moduleGrade = moduleGradeOf(row);
    const studentGrade = studentGradeOf({ grade_level: row.student_grade, year_level: row.year_level });
    if (Number(row.student_id) !== audited.studentId || Number(row.assessment_id) !== audited.assessmentId) {
      console.log(`  skip  submission ${audited.submissionId}: not the audited attempt`); continue;
    }
    if (!moduleGrade || moduleGrade === studentGrade) {
      console.log(`  skip  submission ${audited.submissionId}: the module and the student are the same grade now`); continue;
    }
    crossIds.push(audited.submissionId);
    console.log(`  remove submission ${audited.submissionId}: student ${audited.studentId} (${studentGrade}) on assessment #${audited.assessmentId}, a ${moduleGrade} module`);
  }

  const reads = await query(
    `SELECT r.id, r.student_id, r.module_id, m.grade_level, m.target_year_levels_json,
            u.grade_level AS student_grade, u.year_level
       FROM student_module_reads r
       JOIN modules m ON m.id = r.module_id
       JOIN users u ON u.id = r.student_id
      WHERE r.student_id IN (${list([...new Set(CROSS_GRADE.map((c) => c.studentId))])})`,
    [...new Set(CROSS_GRADE.map((c) => c.studentId))]
  );
  const readIds = reads
    .filter((r) => {
      const moduleGrade = moduleGradeOf(r);
      return moduleGrade && moduleGrade !== studentGradeOf({ grade_level: r.student_grade, year_level: r.year_level });
    })
    .map((r) => {
      console.log(`  remove module open: student ${r.student_id} on module ${r.module_id} (${moduleGradeOf(r)})`);
      return Number(r.id);
    });

  // ---- 2. test assessments --------------------------------------------------
  const junkIds = [];
  for (const audited of JUNK) {
    const [assessment] = await query('SELECT id, title, module_id FROM tutor_assessments WHERE id = ?', [audited.assessmentId]);
    if (!assessment) { console.log(`  done  assessment #${audited.assessmentId}: already gone`); continue; }
    const questions = await query('SELECT question_text FROM tutor_assessment_questions WHERE assessment_id = ?', [audited.assessmentId]);
    const texts = questions.map((q) => String(q.question_text).trim()).sort();
    const same = assessment.title === audited.title
      && JSON.stringify(texts) === JSON.stringify([...audited.questions].sort());
    if (!same) { console.log(`  skip  assessment #${audited.assessmentId}: not as audited`); continue; }
    junkIds.push(audited.assessmentId);
    console.log(`  remove assessment #${audited.assessmentId} "${assessment.title}": ${texts.map((t) => `"${t}"`).join(', ')}`);
  }
  const junkSubmissions = junkIds.length
    ? (await query(`SELECT id, student_id FROM tutor_assessment_submissions WHERE assessment_id IN (${list(junkIds)})`, junkIds))
    : [];
  for (const s of junkSubmissions) console.log(`         with its submission ${s.id} (student ${s.student_id})`);

  const submissionIds = [...crossIds, ...junkSubmissions.map((s) => Number(s.id))];
  const students = [...new Set([
    ...CROSS_GRADE.filter((c) => crossIds.includes(c.submissionId)).map((c) => c.studentId),
    ...junkSubmissions.map((s) => Number(s.student_id))
  ])];

  if (!COMMIT) {
    console.log(`\n${submissionIds.length} submission(s), ${junkIds.length} assessment(s) and ${readIds.length} module open(s) would be removed;`
      + ` levels re-derived for students ${students.join(', ') || 'none'}; ${FOCUS_REFRESH.length} focus handout(s) rewritten.`);
    (await getPool()).close();
    return;
  }

  await withTransaction(async (connection) => {
    if (submissionIds.length || junkIds.length) {
      // Anti-cheat records point at the submission (no cascade) and at the
      // assessment; both go with what they describe.
      const clauses = [];
      const params = [];
      if (submissionIds.length) { clauses.push(`submission_id IN (${list(submissionIds)})`); params.push(...submissionIds); }
      if (junkIds.length) { clauses.push(`assessment_id IN (${list(junkIds)})`); params.push(...junkIds); }
      await connection.query(`DELETE FROM assessment_violations WHERE ${clauses.join(' OR ')}`, params);
    }
    if (submissionIds.length) {
      await connection.query(`DELETE FROM focus_handouts WHERE submission_id IN (${list(submissionIds)})`, submissionIds);
      await connection.query(`DELETE FROM tutor_student_answers WHERE submission_id IN (${list(submissionIds)})`, submissionIds);
      await connection.query(`DELETE FROM tutor_assessment_submissions WHERE id IN (${list(submissionIds)})`, submissionIds);
    }
    if (junkIds.length) {
      await connection.query(
        `DELETE FROM tutor_question_options WHERE question_id IN (SELECT id FROM tutor_assessment_questions WHERE assessment_id IN (${list(junkIds)}))`,
        junkIds
      );
      await connection.query(`DELETE FROM tutor_assessment_questions WHERE assessment_id IN (${list(junkIds)})`, junkIds);
      await connection.query(`DELETE FROM tutor_assessments WHERE id IN (${list(junkIds)})`, junkIds);
    }
    if (readIds.length) {
      await connection.query(`DELETE FROM student_module_reads WHERE id IN (${list(readIds)})`, readIds);
    }
    if (students.length) {
      // The level on record follows each student's latest remaining submission.
      await connection.query(
        `UPDATE ssl
            SET level = latest.level, score = CAST(ROUND(latest.score, 0) AS INT), total_points = latest.total_points,
                percentage = latest.percentage, pre_assessment_id = latest.assessment_id,
                assigned_at = DATEADD(hour, 8, GETUTCDATE())
           FROM student_subject_levels ssl
           CROSS APPLY (
             SELECT TOP 1 sub.level, sub.score, sub.total_points, sub.percentage, sub.assessment_id
               FROM tutor_assessment_submissions sub
               JOIN tutor_assessments ta ON ta.id = sub.assessment_id
              WHERE sub.student_id = ssl.student_id AND ta.subject_id = ssl.subject_id AND sub.level IS NOT NULL
              ORDER BY sub.submitted_at DESC, sub.id DESC
           ) latest
          WHERE ssl.student_id IN (${list(students)})`,
        students
      );
    }
  });
  console.log(`\nRemoved ${submissionIds.length} submission(s), ${junkIds.length} assessment(s), ${readIds.length} module open(s).`);

  const levels = students.length
    ? await query(`SELECT student_id, subject_id, level, score, total_points, pre_assessment_id FROM student_subject_levels WHERE student_id IN (${list(students)})`, students)
    : [];
  for (const l of levels) {
    console.log(`  level now: student ${l.student_id}, subject ${l.subject_id}: ${l.level} (${l.score}/${l.total_points}, from assessment #${l.pre_assessment_id})`);
  }

  // ---- 3. the focus handout written from corrected marks --------------------
  const { generateFocusHandout } = require('../lib/focusHandouts');
  for (const item of FOCUS_REFRESH) {
    const handout = await generateFocusHandout(item);
    console.log(handout
      ? `  focus handout #${handout.id} rewritten (${Number(handout.overall_percentage).toFixed(2)}%, by ${handout.generated_by}): ${handout.summary}`
      : `  focus handout for submission ${item.submissionId}: could not be written`);
  }
  (await getPool()).close();
}

main().catch((error) => { console.error('FAILED:', error.message); process.exit(1); });
