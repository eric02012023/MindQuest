/**
 * File: scripts/repair-answer-keys.js
 * Purpose: Correct the answer keys the AI got wrong in questions written before
 *          the answer-key check existed, and re-mark the answers given to them.
 *
 * Run:  node scripts/repair-answer-keys.js                 (dry run: prints the plan)
 *       node scripts/repair-answer-keys.js --commit        (applies it)
 *       node scripts/repair-answer-keys.js --env .env.live --commit
 *
 * WHY
 * Grading was exact — it compares the letter a student picked with the stored
 * key — but some stored keys were wrong. The AI that wrote the questions often
 * explained the right answer and then put the wrong letter down: "What is the
 * result of 9 x 9?" was stored with the key D (100) beside the explanation
 * "9 x 9 equals 81". A student who answered 81 was marked wrong, and one who
 * answered 5 for "18 divided by 6" was marked right.
 *
 * New questions cannot come out like that any more (services/aiService.js:
 * verifyAnswerKeys, the written-out answer, the worked sum). This repairs the
 * ones already stored. Every correction below was found by that same check run
 * over every live question on 2026-10-13, and each was confirmed by hand
 * against its handout and its own stored explanation.
 *
 * WHAT IT CHANGES
 *   tutor_assessment_questions.correct_answer   for the questions listed
 *   tutor_question_options.option_text          one choice, where a question had
 *                                               two right answers (see OPTION_FIXES)
 *   tutor_student_answers                        is_correct / points / key of every
 *                                               answer to those questions
 *   tutor_assessment_submissions                 score, percentage and level
 *   student_subject_levels                       the classification on record,
 *                                               from the latest submission
 *
 * Every change is guarded on the row still holding exactly what was audited
 * (question text and the old key), so running it twice changes nothing the
 * second time, and it never touches a question that has since been edited.
 */

const envIndex = process.argv.indexOf('--env');
require('dotenv').config({ path: envIndex > -1 ? process.argv[envIndex + 1] : '.env' });

const { query, withTransaction, getPool } = require('../config/db');
const { determineLevel } = require('../config/levelThresholds');

const COMMIT = process.argv.includes('--commit');

/** Wrong keys: the audited question, its wrong key, and the right one. */
const KEY_FIXES = [
  // Pre-Assessment #1 (Reading & Writing, Kinder 2) — archived
  { id: 1, text: /first sound of the letter 'C'/, from: 'C', to: 'B', why: "the handout: Cc /k/ - Cat" },
  // Pre-Assessment #6 (Reading & Writing, Grade 1) — archived
  { id: 110, text: /example of a word family/, from: 'D', to: 'B', why: 'cat, bat, mat share the -at family' },
  { id: 120, text: /How many vowels are there/, from: 'D', to: 'C', why: 'five vowels: a, e, i, o, u' },
  { id: 122, text: /first sound in the word 'sun'/, from: 'C', to: 'A', why: "'sun' begins with /s/" },
  // Pre-Assessment #1011 (Araling Panlipunan) — subject-wide, retired
  { id: 1241, text: /dapat iwasan upang mapangalagaan/, from: 'B', to: 'D', why: 'pagsasayang ng koryente is what to avoid' },
  { id: 1250, text: /hindi bahagi ng yamang tubig/, from: 'C', to: 'B', why: 'ilaw is not a water resource; lawa is' },
  // Pre-Assessment #1012 (Mathematics) — archived, and its Post-Assessment copy #1014
  { id: 1258, text: /What does multiplication help to solve/, from: 'C', to: 'A', why: 'the handout: multiplication helps solve word problems' },
  { id: 1259, text: /result of 9 x 9/, from: 'D', to: 'B', why: '9 x 9 = 81' },
  { id: 1263, text: /12 divided by 3/, from: 'D', to: 'B', why: '12 / 3 = 4' },
  { id: 1267, text: /18 divided by 6/, from: 'D', to: 'B', why: '18 / 6 = 3' },
  { id: 1269, text: /make learning multiplication fun/, from: 'B', to: 'A', why: 'the handout: games' },
  { id: 1296, text: /What does multiplication help to solve/, from: 'C', to: 'A', why: 'the same item in the Post-Assessment' },
  { id: 1297, text: /result of 9 x 9/, from: 'D', to: 'B', why: '9 x 9 = 81' },
  { id: 1301, text: /12 divided by 3/, from: 'D', to: 'B', why: '12 / 3 = 4' },
  { id: 1305, text: /18 divided by 6/, from: 'D', to: 'B', why: '18 / 6 = 3' },
  { id: 1307, text: /make learning multiplication fun/, from: 'B', to: 'A', why: 'the handout: games' },
  // Pre-Assessment #1019 (Mathematics) — subject-wide, retired
  { id: 1433, text: /subtracting integers be understood/, from: 'D', to: 'C', why: 'subtracting is adding the opposite' },
  // Pre-Assessment #1020 (Reading & Writing) — subject-wide, retired
  { id: 1480, text: /layunin na nagbibigay ng kasiyahan/, from: 'C', to: 'D', why: 'magbigay ng aliw is the entertaining purpose' }
];

/**
 * A question with TWO right answers is fixed by making one of them wrong, not by
 * guessing which one the writer meant. "Which of the following is a negative
 * integer?" offered -2 and -3 (both negative, by its own handout) and accepted
 * only -3. Choice B becomes 2, so -3 is the one negative integer. Nobody had
 * picked B, so no answer's mark changes.
 */
const OPTION_FIXES = [
  { questionId: 1488, text: /Which of the following is a negative integer/, label: 'B', from: '-2', to: '2', key: 'C' }
];

function graded(question, studentAnswer) {
  const raw = String(studentAnswer ?? '').trim();
  if (question.question_type === 'true_false') {
    const answer = raw.toLowerCase();
    const normalized = ['true', 't', 'yes'].includes(answer) ? 'true' : ['false', 'f', 'no'].includes(answer) ? 'false' : '';
    return !!normalized && normalized === String(question.correct_answer).trim().toLowerCase();
  }
  const letter = /^[A-E]$/i.test(raw) ? raw.toUpperCase() : '';
  return !!letter && letter === String(question.correct_answer).trim().toUpperCase();
}

async function main() {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try { await query('SELECT 1 AS ok'); break; } catch (error) {
      console.log(`connect attempt ${attempt}: ${error.message}`);
      if (attempt === 6) throw error;
    }
  }
  console.log(COMMIT ? 'APPLYING the corrections.\n' : 'DRY RUN — nothing is written. Add --commit to apply.\n');

  const ids = KEY_FIXES.map((f) => f.id);
  const questions = await query(
    `SELECT id, assessment_id, question_text, question_type, correct_answer, points
       FROM tutor_assessment_questions WHERE id IN (${ids.map(() => '?').join(',')})`, ids
  );
  const plan = [];
  for (const fix of KEY_FIXES) {
    const q = questions.find((row) => Number(row.id) === fix.id);
    if (!q) { console.log(`  skip  Q${fix.id}: not found`); continue; }
    if (!fix.text.test(q.question_text)) { console.log(`  skip  Q${fix.id}: text changed since the audit`); continue; }
    const key = String(q.correct_answer).trim().toUpperCase();
    if (key === fix.to) { console.log(`  done  Q${fix.id}: already ${fix.to}`); continue; }
    if (key !== fix.from) { console.log(`  skip  Q${fix.id}: key is ${key}, not the audited ${fix.from}`); continue; }
    plan.push({ ...fix, question: q });
    console.log(`  fix   Q${fix.id} (#${q.assessment_id}) ${fix.from} -> ${fix.to}  "${q.question_text.slice(0, 60)}" — ${fix.why}`);
  }

  const optionPlan = [];
  for (const fix of OPTION_FIXES) {
    const rows = await query(
      `SELECT o.id, o.option_text, q.question_text, q.correct_answer FROM tutor_question_options o
         JOIN tutor_assessment_questions q ON q.id = o.question_id
        WHERE o.question_id = ? AND o.option_label = ?`, [fix.questionId, fix.label]
    );
    const row = rows[0];
    if (!row || !fix.text.test(row.question_text)) { console.log(`  skip  Q${fix.questionId} choice ${fix.label}: not as audited`); continue; }
    if (String(row.option_text).trim() === fix.to) { console.log(`  done  Q${fix.questionId} choice ${fix.label}: already "${fix.to}"`); continue; }
    if (String(row.option_text).trim() !== fix.from) { console.log(`  skip  Q${fix.questionId} choice ${fix.label}: reads "${row.option_text}"`); continue; }
    optionPlan.push({ ...fix, optionId: row.id });
    console.log(`  fix   Q${fix.questionId} choice ${fix.label} "${fix.from}" -> "${fix.to}" (one right answer: ${fix.key})`);
  }

  // Every answer given to a question whose key changes, re-marked.
  const fixedIds = plan.map((p) => p.id);
  const answers = fixedIds.length
    ? await query(
      `SELECT a.id, a.submission_id, a.question_id, a.student_answer, a.is_correct, a.points_earned
         FROM tutor_student_answers a WHERE a.question_id IN (${fixedIds.map(() => '?').join(',')})`, fixedIds)
    : [];
  const remark = answers.map((a) => {
    const fix = plan.find((p) => p.id === Number(a.question_id));
    const question = { ...fix.question, correct_answer: fix.to };
    const right = graded(question, a.student_answer);
    return { ...a, right, points: right ? Number(fix.question.points || 1) : 0, key: fix.to };
  });
  const changedMarks = remark.filter((a) => !!a.right !== !!Number(a.is_correct));
  console.log(`\n${remark.length} answer(s) to those questions; ${changedMarks.length} change their mark:`);
  for (const a of changedMarks) {
    console.log(`  answer #${a.id} (submission ${a.submission_id}, Q${a.question_id}): "${a.student_answer}" was ${Number(a.is_correct) ? 'right' : 'wrong'}, is ${a.right ? 'right' : 'wrong'}`);
  }

  // Only a submission where a mark actually changed is re-scored; the others
  // keep the score they have (their answers still get the corrected key, so the
  // result page shows the right answer).
  const submissionIds = [...new Set(changedMarks.map((a) => Number(a.submission_id)))];
  if (!COMMIT) {
    console.log(`\n${submissionIds.length} submission(s) would be re-scored: ${submissionIds.join(', ') || 'none'}.`);
    (await getPool()).close();
    return;
  }

  const outcome = await withTransaction(async (connection) => {
    for (const p of plan) {
      await connection.query(
        'UPDATE tutor_assessment_questions SET correct_answer = ? WHERE id = ? AND UPPER(LTRIM(RTRIM(correct_answer))) = ?',
        [p.to, p.id, p.from]
      );
    }
    for (const o of optionPlan) {
      await connection.query('UPDATE tutor_question_options SET option_text = ? WHERE id = ? AND LTRIM(RTRIM(option_text)) = ?', [o.to, o.optionId, o.from]);
    }
    for (const a of remark) {
      await connection.query(
        'UPDATE tutor_student_answers SET is_correct = ?, points_earned = ?, correct_answer = ? WHERE id = ?',
        [a.right ? 1 : 0, a.points, a.key, a.id]
      );
    }
    const rescored = [];
    for (const submissionId of submissionIds) {
      const [totals] = await connection.query(
        `SELECT sub.total_points, COALESCE(SUM(a.points_earned), 0) AS score
           FROM tutor_assessment_submissions sub
           LEFT JOIN tutor_student_answers a ON a.submission_id = sub.id
          WHERE sub.id = ? GROUP BY sub.total_points`, [submissionId]
      );
      const total = Number(totals[0]?.total_points || 0);
      const score = Number(totals[0]?.score || 0);
      const percentage = total ? Number(((score / total) * 100).toFixed(2)) : 0;
      const level = determineLevel(percentage);
      await connection.query(
        'UPDATE tutor_assessment_submissions SET score = ?, percentage = ?, level = ? WHERE id = ?',
        [score, percentage, level, submissionId]
      );
      rescored.push({ submissionId, score, total, percentage, level });
    }
    // The classification on record follows each student's latest submission
    // (the same re-derive sql/schema.sql runs on every boot).
    if (submissionIds.length) {
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
          WHERE ssl.student_id IN (SELECT student_id FROM tutor_assessment_submissions WHERE id IN (${submissionIds.map(() => '?').join(',')}))
            AND (ssl.level <> latest.level OR ISNULL(ssl.percentage, -1) <> ISNULL(latest.percentage, -1))`,
        submissionIds
      );
    }
    return rescored;
  });

  console.log('\nRe-scored:');
  for (const r of outcome) console.log(`  submission ${r.submissionId}: ${r.score}/${r.total} = ${r.percentage}% (${r.level})`);
  console.log(`\nApplied: ${plan.length} key(s), ${optionPlan.length} choice(s), ${remark.length} answer(s) re-marked.`);
  (await getPool()).close();
}

main().catch((error) => { console.error('FAILED:', error.message); process.exit(1); });
