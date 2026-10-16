/**
 * File: lib/analytics.js
 * Purpose: The Analytics & Reports data layer, for all four roles.
 *
 * One module, four scopes. Every query below takes its WHERE fragment from
 * lib/rbac, so the restriction lives in the SQL that fetches the rows rather than
 * in the template that renders them:
 *
 *   student          only their own results
 *   tutor            only the learners assigned to them
 *   admin_assistant  only their branch
 *   admin            everything, optionally narrowed to one branch
 *
 * A student who opens /admin/analytics is stopped by the route's authorize(); a
 * tutor who guesses another tutor's student id gets no rows, because the id is
 * never read from the request — it comes from the session, through resolveScope.
 */

const { query } = require('../config/db');
const {
  resolveScope, studentScopeClause, subjectScopeClause, billingScopeClause, canViewFinancials
} = require('./rbac');
const {
  moduleGradeOf, studentGradeOf, groupOfGrade
} = require('./moduleGrades');
const {
  repairNameList, safeJsonArray, safeJsonObject, titleCaseName
} = require('./utils');
const { matchesSearch, withinDates } = require('./listFilters');
const { setOnly, tabForms } = require('./analyticsFilters');
// A learner's month in a subject: once over, only what was added before it ended counts.
const { monthOf, addedInMonth } = require('./postWindow');

/** Rows with fewer than this many answers are too thin to call a trend. */
const MIN_TOPIC_ITEMS = 2;

function round(value, places = 1) {
  const factor = 10 ** places;
  return Math.round((Number(value) || 0) * factor) / factor;
}

/** Date-range clause shared by every time-bounded query. */
function periodClause(column, filters = {}) {
  const parts = [];
  const params = [];
  if (filters.from) {
    parts.push(`${column} >= ?`);
    params.push(new Date(`${filters.from}T00:00:00`));
  }
  if (filters.to) {
    parts.push(`${column} < DATEADD(day, 1, ?)`);
    params.push(new Date(`${filters.to}T00:00:00`));
  }
  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params };
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** Every assessment attempt in scope, newest first. */
async function getScopedSubmissions(scope, filters = {}) {
  const student = studentScopeClause(scope, 'u');
  const subject = subjectScopeClause(scope, 'ta');
  const period = periodClause('sub.submitted_at', filters);
  const params = [...student.params, ...subject.params, ...period.params];

  let extra = '';
  if (filters.subjectId && String(filters.subjectId) !== 'all') {
    extra += ' AND ta.subject_id = ?';
    params.push(Number(filters.subjectId));
  }
  if (filters.kind && String(filters.kind) !== 'all') {
    extra += ' AND ta.assessment_kind = ?';
    params.push(String(filters.kind));
  }
  const search = String(filters.search || '').trim().toLowerCase();
  if (search) {
    extra += ` AND (LOWER(CONCAT(COALESCE(u.first_name,''), ' ', COALESCE(u.last_name,''))) LIKE ?
                    OR LOWER(u.user_id) LIKE ? OR LOWER(s.name) LIKE ? OR LOWER(ta.title) LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }

  return query(
    `SELECT sub.id, sub.student_id, sub.assessment_id, sub.score, sub.total_points,
            sub.percentage, sub.level, sub.submitted_at, sub.time_spent_seconds,
            sub.is_auto_submitted, sub.violation_count,
            ta.title, ta.assessment_kind, ta.purpose, ta.subject_id,
            s.name AS subject_name,
            u.user_id AS student_code, u.first_name, u.middle_name, u.last_name,
            u.year_level, u.grade_level, u.branch_id, br.name AS branch_name
     FROM tutor_assessment_submissions sub
     JOIN tutor_assessments ta ON ta.id = sub.assessment_id
     JOIN subjects s ON s.id = ta.subject_id
     JOIN users u ON u.id = sub.student_id
     LEFT JOIN branches br ON br.id = u.branch_id
     WHERE u.role = 'student'${student.sql}${subject.sql}${period.sql}${extra}
     ORDER BY sub.submitted_at DESC, sub.id DESC`,
    params
  );
}

/**
 * Weak topics across everyone in scope.
 *
 * Grouped by the module + handout a question was generated from, which is the
 * same attribution the per-student weak-area view uses — so a tutor sees the same
 * topic names here and on a single result page.
 */
async function getWeakTopics(scope, filters = {}) {
  const student = studentScopeClause(scope, 'u');
  const subject = subjectScopeClause(scope, 'ta');
  const period = periodClause('sub.submitted_at', filters);
  const params = [...student.params, ...subject.params, ...period.params];

  let extra = '';
  if (filters.subjectId && String(filters.subjectId) !== 'all') {
    extra += ' AND ta.subject_id = ?';
    params.push(Number(filters.subjectId));
  }

  const rows = await query(
    `SELECT ta.subject_id, s.name AS subject_name,
            q.source_module_id, m.title AS module_title, m.order_number,
            h.file_original_name AS handout_name,
            COUNT(*) AS total,
            SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END) AS correct,
            COUNT(DISTINCT sub.student_id) AS student_count
     FROM tutor_student_answers a
     JOIN tutor_assessment_submissions sub ON sub.id = a.submission_id
     JOIN tutor_assessments ta ON ta.id = sub.assessment_id
     JOIN subjects s ON s.id = ta.subject_id
     JOIN users u ON u.id = sub.student_id
     JOIN tutor_assessment_questions q ON q.id = a.question_id
     LEFT JOIN modules m ON m.id = q.source_module_id
     LEFT JOIN module_handouts h ON h.id = q.source_handout_id
     WHERE u.role = 'student'${student.sql}${subject.sql}${period.sql}${extra}
     GROUP BY ta.subject_id, s.name, q.source_module_id, m.title, m.order_number, h.file_original_name`,
    params
  );

  return rows
    .map((row) => {
      const total = Number(row.total || 0);
      const correct = Number(row.correct || 0);
      return {
        key: weakTopicKey(row),
        subject_id: row.subject_id,
        subject_name: row.subject_name,
        module_id: row.source_module_id,
        module_title: row.module_title || 'Unattributed',
        handout_name: row.handout_name || null,
        topic: row.handout_name
          ? `${row.module_title || 'Unattributed'} — ${row.handout_name}`
          : (row.module_title || 'Unattributed'),
        total,
        correct,
        wrong: total - correct,
        student_count: Number(row.student_count || 0),
        percentage: total ? round((correct / total) * 100) : 0
      };
    })
    .filter((row) => row.total >= MIN_TOPIC_ITEMS)
    .sort((a, b) => a.percentage - b.percentage || b.wrong - a.wrong);
}

/** Below this a topic is weak — for the whole group (the KPI) and for one learner. */
const WEAK_BELOW = 60;

/** One topic's identity: its subject, module and handout (what getWeakTopics groups by). */
function weakTopicKey(row) {
  return `${row.subject_id}|${row.source_module_id || ''}|${row.handout_name || ''}`;
}

/**
 * Who is weak in each topic: every learner's own score on it, from the same
 * answers getWeakTopics adds up — weak below WEAK_BELOW, the line a single
 * result page draws too (getWeakAreasForSubmission).
 *
 * @returns {Promise<Map<string, { answered: number, weak: Array }>>} topic key ->
 *   how many learners answered it, and the weak ones, weakest first
 */
async function getWeakTopicLearners(scope, filters = {}) {
  const student = studentScopeClause(scope, 'u');
  const subject = subjectScopeClause(scope, 'ta');
  const params = [...student.params, ...subject.params];
  let extra = '';
  if (filters.subjectId && String(filters.subjectId) !== 'all') {
    extra += ' AND ta.subject_id = ?';
    params.push(Number(filters.subjectId));
  }

  const rows = await query(
    `SELECT ta.subject_id, q.source_module_id, h.file_original_name AS handout_name,
            sub.student_id, u.user_id AS student_code, u.first_name, u.middle_name, u.last_name,
            br.name AS branch_name,
            COUNT(*) AS total,
            SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END) AS correct
     FROM tutor_student_answers a
     JOIN tutor_assessment_submissions sub ON sub.id = a.submission_id
     JOIN tutor_assessments ta ON ta.id = sub.assessment_id
     JOIN users u ON u.id = sub.student_id
     LEFT JOIN branches br ON br.id = u.branch_id
     JOIN tutor_assessment_questions q ON q.id = a.question_id
     LEFT JOIN module_handouts h ON h.id = q.source_handout_id
     WHERE u.role = 'student'${student.sql}${subject.sql}${extra}
     GROUP BY ta.subject_id, q.source_module_id, h.file_original_name,
              sub.student_id, u.user_id, u.first_name, u.middle_name, u.last_name, br.name`,
    params
  );

  const byTopic = new Map();
  for (const row of rows) {
    const total = Number(row.total || 0);
    const correct = Number(row.correct || 0);
    const percentage = total ? round((correct / total) * 100) : 0;
    const key = weakTopicKey(row);
    if (!byTopic.has(key)) byTopic.set(key, { answered: 0, weak: [] });
    const entry = byTopic.get(key);
    entry.answered += 1;
    if (percentage >= WEAK_BELOW) continue;
    entry.weak.push({
      student_id: row.student_id,
      student_code: row.student_code,
      name: titleCaseName([row.first_name, row.middle_name, row.last_name].filter(Boolean).join(' ')),
      branch_name: row.branch_name || '—',
      correct,
      total,
      percentage
    });
  }
  for (const entry of byTopic.values()) {
    entry.weak.sort((a, b) => a.percentage - b.percentage || String(a.name).localeCompare(String(b.name)));
  }
  return byTopic;
}

/**
 * Per-student roll-up: attempts, average, best/worst, last activity.
 *
 * Every condition about the SUBMISSION sits in the LEFT JOIN's ON clause, not in
 * the WHERE. In the WHERE it would silently turn the outer join into an inner one
 * and drop exactly the students a tutor most needs to see — the ones who have not
 * sat anything yet.
 */
async function getStudentPerformance(scope, filters = {}) {
  const student = studentScopeClause(scope, 'u');
  const subject = subjectScopeClause(scope, 'ta');
  const period = periodClause('sub.submitted_at', filters);

  // Params are pushed in the order the fragments appear in the statement —
  // subject clause, then the subject filter, then the period — because the driver
  // binds them positionally.
  const joinParams = [...subject.params];
  let joinExtra = '';
  if (filters.subjectId && String(filters.subjectId) !== 'all') {
    joinExtra += ' AND ta.subject_id = ?';
    joinParams.push(Number(filters.subjectId));
  }
  joinParams.push(...period.params);

  const whereParams = [...student.params];
  let whereExtra = '';
  const search = String(filters.search || '').trim().toLowerCase();
  if (search) {
    whereExtra += ` AND (LOWER(CONCAT(COALESCE(u.first_name,''), ' ', COALESCE(u.last_name,''))) LIKE ?
                    OR LOWER(u.user_id) LIKE ?)`;
    whereParams.push(`%${search}%`, `%${search}%`);
  }

  const rows = await query(
    `SELECT u.id AS student_id, u.user_id AS student_code,
            u.first_name, u.middle_name, u.last_name, u.year_level, u.grade_level,
            br.name AS branch_name,
            COALESCE(agg.attempts, 0) AS attempts,
            agg.average_percentage, agg.best_percentage, agg.worst_percentage,
            agg.last_attempt_at,
            COALESCE(agg.auto_submits, 0) AS auto_submits,
            COALESCE(agg.violations, 0) AS violations
     FROM users u
     LEFT JOIN branches br ON br.id = u.branch_id
     LEFT JOIN (
       SELECT sub.student_id,
              COUNT(*) AS attempts,
              AVG(CAST(sub.percentage AS FLOAT)) AS average_percentage,
              MAX(CAST(sub.percentage AS FLOAT)) AS best_percentage,
              MIN(CAST(sub.percentage AS FLOAT)) AS worst_percentage,
              MAX(sub.submitted_at) AS last_attempt_at,
              SUM(CASE WHEN sub.is_auto_submitted = 1 THEN 1 ELSE 0 END) AS auto_submits,
              SUM(COALESCE(sub.violation_count, 0)) AS violations
       FROM tutor_assessment_submissions sub
       JOIN tutor_assessments ta ON ta.id = sub.assessment_id
       WHERE 1 = 1${subject.sql}${joinExtra}${period.sql}
       GROUP BY sub.student_id
     ) agg ON agg.student_id = u.id
     WHERE u.role = 'student' AND u.is_archived = 0${student.sql}${whereExtra}
     ORDER BY CASE WHEN agg.average_percentage IS NULL THEN 1 ELSE 0 END,
              agg.average_percentage ASC`,
    [...joinParams, ...whereParams]
  );

  return rows.map((row) => ({
    ...row,
    attempts: Number(row.attempts || 0),
    average_percentage: row.average_percentage === null ? null : round(row.average_percentage),
    best_percentage: row.best_percentage === null ? null : round(row.best_percentage),
    worst_percentage: row.worst_percentage === null ? null : round(row.worst_percentage),
    auto_submits: Number(row.auto_submits || 0),
    violations: Number(row.violations || 0)
  }));
}

/**
 * Module completion: how far through each subject the students in scope are.
 *
 * Counted against each student's OWN grade's modules — a module is for one
 * grade (lib/moduleGrades.js), so a Grade 3 learner has Grade 3's modules to
 * open and nothing else. It used to multiply every learner by every module in
 * the subject, so a subject with Grade 3 and Grade 6 modules could never read
 * more than about half done.
 */
async function getModuleCompletion(scope, filters = {}) {
  const student = studentScopeClause(scope, 'u');
  const params = [...student.params];

  let extra = '';
  if (filters.subjectId && String(filters.subjectId) !== 'all') {
    extra += ' AND s.id = ?';
    params.push(Number(filters.subjectId));
  }
  if (scope.isTutor) {
    extra += ` AND EXISTS (
      SELECT 1 FROM user_subject_assignments usa3
      WHERE usa3.subject_id = s.id AND usa3.tutor_id = ? AND usa3.is_archived = 0
    )`;
    params.push(scope.userId);
  }

  const enrolled = await query(
    `SELECT DISTINCT s.id AS subject_id, s.name AS subject_name, u.id AS student_id,
            u.year_level, u.grade_level,
            CONVERT(varchar(10), usa.start_date, 23) AS start_date, CONVERT(varchar(10), usa.end_date, 23) AS end_date
     FROM user_subject_assignments usa
     JOIN subjects s ON s.id = usa.subject_id
     JOIN users u ON u.id = usa.student_id
     WHERE usa.is_archived = 0 AND u.role = 'student' AND u.is_archived = 0${student.sql}${extra}`,
    params
  );
  if (!enrolled.length) return [];

  const subjectIds = [...new Set(enrolled.map((row) => Number(row.subject_id)))];
  const inList = subjectIds.map(() => '?').join(',');
  const [modules, reads] = await Promise.all([
    query(
      `SELECT id, subject_id, grade_level, target_year_levels_json, created_at
         FROM modules WHERE is_archived = 0 AND subject_id IN (${inList})`,
      subjectIds
    ),
    query(
      `SELECT DISTINCT student_id, module_id FROM student_module_reads WHERE subject_id IN (${inList})`,
      subjectIds
    )
  ]);
  const opened = new Set(reads.map((row) => `${row.student_id}|${row.module_id}`));

  const bySubject = new Map();
  for (const row of enrolled) {
    const key = Number(row.subject_id);
    if (!bySubject.has(key)) {
      bySubject.set(key, {
        subject_id: row.subject_id, subject_name: row.subject_name,
        students: new Set(), modules: new Set(), possible: 0, opens: 0
      });
    }
    const entry = bySubject.get(key);
    if (entry.students.has(Number(row.student_id))) continue;
    entry.students.add(Number(row.student_id));
    const grade = studentGradeOf(row);
    // Once a learner's month is over, a module added later is not theirs.
    const month = monthOf(row);
    const mine = grade
      ? modules.filter((m) => Number(m.subject_id) === key && moduleGradeOf(m) === grade && addedInMonth(m.created_at, month))
      : [];
    mine.forEach((m) => entry.modules.add(Number(m.id)));
    entry.possible += mine.length;
    entry.opens += mine.filter((m) => opened.has(`${row.student_id}|${m.id}`)).length;
  }

  return [...bySubject.values()]
    .sort((a, b) => String(a.subject_name).localeCompare(String(b.subject_name)))
    .map((entry) => ({
      subject_id: entry.subject_id,
      subject_name: entry.subject_name,
      student_count: entry.students.size,
      // The modules the learners in scope actually have, across their grades.
      module_count: entry.modules.size,
      opens: entry.opens,
      completion: entry.possible ? round((entry.opens / entry.possible) * 100) : 0
    }));
}

/** Average score per calendar month, for the trend chart. */
function buildTrend(submissions = [], months = 12) {
  const buckets = new Map();
  for (const row of submissions) {
    const date = new Date(row.submitted_at);
    if (Number.isNaN(date.getTime())) continue;
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    if (!buckets.has(key)) buckets.set(key, { total: 0, count: 0 });
    const bucket = buckets.get(key);
    bucket.total += Number(row.percentage || 0);
    bucket.count += 1;
  }
  const keys = [...buckets.keys()].sort().slice(-months);
  return keys.map((key) => {
    const [year, month] = key.split('-');
    const bucket = buckets.get(key);
    return {
      key,
      label: new Date(Number(year), Number(month) - 1).toLocaleString('en-US', { month: 'short', year: '2-digit' }),
      average: round(bucket.total / bucket.count),
      attempts: bucket.count
    };
  });
}

/**
 * How the students in scope are spread across Beginner / Intermediate / Advance.
 *
 * Counted per STUDENT, not per classification row. student_subject_levels holds
 * one row per student per SUBJECT, so counting rows counted a student taking
 * three subjects three times: the chart added up to more people than the branch
 * has, and disagreed with the Learners figure directly above it.
 *
 * Each student is counted once, on their most recent classification — the same
 * "latest measurement wins" rule gradeAndSubmitAssessment applies when it writes
 * one.
 *
 * Students nobody has classified yet get their own slice instead of being left
 * out. Dropped, they were invisible: a branch of thirty learners with two
 * assessed showed a confident two-slice chart and no hint that the other
 * twenty-eight had never sat anything. That absence is the most actionable thing
 * on the chart.
 *
 * The tutor case needs no special handling here — studentScopeClause already
 * narrows `u` to the learners that tutor personally handles.
 */
const UNASSESSED = 'Not yet assessed';

async function getLevelSpread(scope, filters = {}) {
  const student = studentScopeClause(scope, 'u');

  const filterBySubject = filters.subjectId && String(filters.subjectId) !== 'all';
  const subjectFilter = filterBySubject ? ' AND ssl.subject_id = ?' : '';

  // The subject parameter sits inside the OUTER APPLY, which the driver binds
  // before the WHERE clause that follows it.
  const params = filterBySubject
    ? [Number(filters.subjectId), ...student.params]
    : [...student.params];

  // OUTER APPLY, not JOIN: an unclassified student must still produce a row.
  const rows = await query(
    `SELECT COALESCE(latest.level, '${UNASSESSED}') AS level, COUNT(*) AS total
     FROM users u
     OUTER APPLY (
       SELECT TOP 1 ssl.level
       FROM student_subject_levels ssl
       WHERE ssl.student_id = u.id${subjectFilter}
       ORDER BY ssl.assigned_at DESC, ssl.id DESC
     ) latest
     WHERE u.role = 'student' AND u.is_archived = 0${student.sql}
     GROUP BY COALESCE(latest.level, '${UNASSESSED}')`,
    params
  );

  // Seeded so the slices keep a fixed order and a missing band reads as zero
  // rather than vanishing from the chart.
  const spread = { Beginner: 0, Intermediate: 0, Advance: 0, [UNASSESSED]: 0 };
  for (const row of rows) {
    // 'Advanced' and 'Advance' both exist in older data; report them as one.
    const key = row.level === 'Advanced' ? 'Advance' : row.level;
    spread[key] = (spread[key] || 0) + Number(row.total || 0);
  }
  return spread;
}

/** Anti-cheat activity, for the tutor / admin view. */
async function getViolationSummary(scope, filters = {}) {
  const student = studentScopeClause(scope, 'u');
  const subject = subjectScopeClause(scope, 'ta');
  const period = periodClause('v.occurred_at', filters);
  const params = [...student.params, ...subject.params, ...period.params];

  return query(
    `SELECT v.id, v.violation_type, v.violation_detail, v.violation_number, v.occurred_at,
            v.submission_id, ta.title, ta.assessment_kind, s.name AS subject_name,
            u.id AS student_id, u.user_id AS student_code, u.first_name, u.last_name,
            br.name AS branch_name
     FROM assessment_violations v
     JOIN tutor_assessments ta ON ta.id = v.assessment_id
     JOIN subjects s ON s.id = ta.subject_id
     JOIN users u ON u.id = v.student_id
     LEFT JOIN branches br ON br.id = u.branch_id
     WHERE 1 = 1${student.sql}${subject.sql}${period.sql}
     ORDER BY v.occurred_at DESC`,
    params
  );
}

/** Enrolment counts per subject — an operational number, staff only. */
async function getEnrolmentBreakdown(scope) {
  const student = studentScopeClause(scope, 'u');
  return query(
    // Learners only: this dashboard reports on students, and a tutor headcount
    // beside a learner count read as a performance figure about staff.
    `SELECT s.id AS subject_id, s.name AS subject_name,
            COUNT(DISTINCT usa.student_id) AS students
     FROM user_subject_assignments usa
     JOIN subjects s ON s.id = usa.subject_id
     JOIN users u ON u.id = usa.student_id
     WHERE usa.is_archived = 0 AND u.role = 'student' AND u.is_archived = 0${student.sql}
     GROUP BY s.id, s.name
     ORDER BY COUNT(DISTINCT usa.student_id) DESC`,
    student.params
  );
}

/** Money in and money owed, inside the viewer's scope. Staff only. */
async function getFinancialSummary(scope, filters = {}) {
  const scoped = billingScopeClause(scope, 'u');
  const period = periodClause('pe.paid_at', filters);

  const [collected, outstanding] = await Promise.all([
    query(
      `SELECT COALESCE(SUM(pe.amount), 0) AS total, COUNT(*) AS transactions,
              COUNT(DISTINCT pe.student_id) AS students
       FROM payment_entries pe
       JOIN users u ON u.id = pe.student_id
       WHERE 1 = 1${scoped.sql}${period.sql}`,
      [...scoped.params, ...period.params]
    ),
    query(
      `SELECT COALESCE(SUM(b.for_settlement), 0) AS total,
              SUM(CASE WHEN b.payment_status = 'paid' THEN 1 ELSE 0 END) AS settled,
              SUM(CASE WHEN b.payment_status <> 'paid' THEN 1 ELSE 0 END) AS unsettled
       FROM billing b
       JOIN users u ON u.id = b.student_id
       WHERE u.role = 'student' AND u.is_archived = 0${scoped.sql}`,
      scoped.params
    )
  ]);

  return {
    collected: round(collected[0]?.total || 0, 2),
    transactions: Number(collected[0]?.transactions || 0),
    payingStudents: Number(collected[0]?.students || 0),
    outstanding: round(outstanding[0]?.total || 0, 2),
    settledAccounts: Number(outstanding[0]?.settled || 0),
    unsettledAccounts: Number(outstanding[0]?.unsettled || 0)
  };
}

/**
 * Income by month.
 *
 * The Analytics page no longer draws this (Phase 6 removed the Income Trend
 * chart), and getAnalyticsDashboard no longer calls it — running a query for a
 * chart nobody renders is just a slower page. It stays exported because it is a
 * correct, scoped aggregate and the Payment Collection report is the natural
 * place for it if the office ever wants a month-by-month figure back.
 */
async function getIncomeTrend(scope, filters = {}) {
  const scoped = billingScopeClause(scope, 'u');
  const period = periodClause('pe.paid_at', filters);
  const rows = await query(
    `SELECT YEAR(pe.paid_at) AS y, MONTH(pe.paid_at) AS m,
            SUM(pe.amount) AS total, COUNT(*) AS transactions
     FROM payment_entries pe
     JOIN users u ON u.id = pe.student_id
     WHERE 1 = 1${scoped.sql}${period.sql}
     GROUP BY YEAR(pe.paid_at), MONTH(pe.paid_at)
     ORDER BY YEAR(pe.paid_at) ASC, MONTH(pe.paid_at) ASC`,
    [...scoped.params, ...period.params]
  );
  return rows.slice(-12).map((row) => ({
    label: new Date(Number(row.y), Number(row.m) - 1).toLocaleString('en-US', { month: 'short', year: '2-digit' }),
    total: round(row.total || 0, 2),
    transactions: Number(row.transactions || 0)
  }));
}

/** The subjects this viewer may filter by. */
async function getScopedSubjects(scope) {
  if (scope.isTutor) {
    return query(
      `SELECT DISTINCT s.id, s.name
       FROM user_subject_assignments usa
       JOIN subjects s ON s.id = usa.subject_id
       WHERE usa.tutor_id = ? AND usa.is_archived = 0
       ORDER BY s.name ASC`,
      [scope.userId]
    );
  }
  if (scope.isStudent) {
    return query(
      `SELECT DISTINCT s.id, s.name
       FROM user_subject_assignments usa
       JOIN subjects s ON s.id = usa.subject_id
       WHERE usa.student_id = ? AND usa.is_archived = 0
       ORDER BY s.name ASC`,
      [scope.userId]
    );
  }
  return query('SELECT id, name FROM subjects WHERE is_archived = 0 ORDER BY name ASC');
}

function sumOf(list) {
  return list.reduce((total, value) => total + Number(value || 0), 0);
}

// ---------------------------------------------------------------------------
// User registry
// ---------------------------------------------------------------------------

const ROLE_LABELS = { admin: 'Admin', admin_assistant: 'Assistant Admin', tutor: 'Tutor', student: 'Student' };

/** The group a student's grade sits in ('Primary Level'), or what the record says. */
function levelGroupOf(row) {
  return groupOfGrade(studentGradeOf(row)) || String(row.year_level || '').trim() || 'Not set';
}

/**
 * The subjects a tutor teaches, counted the way tutorTeachesSubject counts them
 * (lib/data.js — not required here, it requires this file): their list, minus
 * any subject the office archived for them.
 */
function tutorSubjectsOf(row) {
  const keyOf = (name) => String(name || '').trim().replace(/\s+/g, ' ').toUpperCase();
  const extra = safeJsonObject(row.extra_json);
  const archived = new Set(repairNameList(safeJsonArray(extra.archived_subjects || [])).map(keyOf));
  return repairNameList(safeJsonArray(row.subjects_json)).filter((name) => !archived.has(keyOf(name)));
}

/**
 * Everyone with an account, as one table — students, tutors and assistant admins
 * of every branch (the main admin sees them all; an assistant, their own branch).
 * Staff only: a tutor or a student gets nothing here.
 *
 * The tab's search (name, ID, email, contact, branch, level, subject), its From
 * and To (the day an account joined — the Joined column, both days included)
 * and its branch narrow what is returned. `registryRole` and `registryStatus`
 * narrow `rows` — the summary table and the list; `everyone` is the same list
 * without them, for the headline counts at the top.
 *
 * @param {object} filters  { search, from, to, registryRole, registryStatus }
 * @returns {Promise<{rows:Array, everyone:Array}>}
 */
async function getUserRegistry(scope, filters = {}) {
  if (!scope.isAdmin && !scope.isAssistant) return { rows: [], everyone: [] };

  const params = [];
  let where = '';
  if (scope.branchId) {
    // An assistant's branch is the one they run (assistant_scope_branch_id).
    where = " AND u.role <> 'admin' AND COALESCE(u.assistant_scope_branch_id, u.branch_id) = ?";
    params.push(scope.branchId);
  }

  const [users, enrolments] = await Promise.all([
    query(
      `SELECT u.id, u.user_id, u.role, u.status, u.is_archived, u.first_name, u.middle_name, u.last_name,
              u.email, u.contact_number, u.gender, u.year_level, u.grade_level, u.subjects_json, u.extra_json,
              u.created_at, u.accepted_at,
              COALESCE(u.assistant_scope_branch_id, u.branch_id) AS branch_id, br.name AS branch_name
       FROM users u
       LEFT JOIN branches br ON br.id = COALESCE(u.assistant_scope_branch_id, u.branch_id)
       WHERE 1 = 1${where}
       ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'admin_assistant' THEN 1 WHEN 'tutor' THEN 2 ELSE 3 END,
                br.name ASC, u.last_name ASC, u.first_name ASC`,
      params
    ),
    query(
      `SELECT usa.student_id, s.name AS subject_name
       FROM user_subject_assignments usa
       JOIN subjects s ON s.id = usa.subject_id
       WHERE usa.is_archived = 0
       ORDER BY s.name ASC`
    )
  ]);

  const enrolledIn = new Map();
  for (const row of enrolments) {
    const key = Number(row.student_id);
    if (!enrolledIn.has(key)) enrolledIn.set(key, []);
    enrolledIn.get(key).push(row.subject_name);
  }

  const everyone = users
    .map((row) => {
      const status = Number(row.is_archived)
        ? 'Archived'
        : (String(row.status || 'approved').charAt(0).toUpperCase() + String(row.status || 'approved').slice(1));
      const isStudent = row.role === 'student';
      return {
        id: row.id,
        user_id: row.user_id,
        role: row.role,
        role_label: ROLE_LABELS[row.role] || row.role,
        name: titleCaseName([row.first_name, row.middle_name, row.last_name].filter(Boolean).join(' ')),
        email: row.email || '',
        contact_number: row.contact_number || '',
        gender: row.gender || '',
        branch_id: row.branch_id,
        branch_name: row.branch_name || (row.role === 'admin' ? 'All branches' : '—'),
        // A student's grade; a tutor's levels are the ones they teach.
        level: isStudent ? (row.grade_level || row.year_level || '') : (row.role === 'tutor' ? (row.year_level || '') : ''),
        level_group: isStudent ? levelGroupOf(row) : '',
        subjects: isStudent
          ? (enrolledIn.get(Number(row.id)) || [])
          : (row.role === 'tutor' ? tutorSubjectsOf(row) : []),
        status,
        joined_at: row.accepted_at || row.created_at
      };
    })
    .filter((row) => matchesSearch(
      [row.name, row.user_id, row.email, row.contact_number, row.branch_name, row.level, row.role_label, row.subjects.join(' ')],
      filters.search
    ))
    .filter((row) => withinDates(row.joined_at, filters.from, filters.to));

  const rows = everyone
    .filter((row) => !filters.registryRole || filters.registryRole === 'all' || row.role_label === filters.registryRole)
    .filter((row) => !filters.registryStatus || filters.registryStatus === 'all' || row.status === filters.registryStatus);

  return { rows, everyone };
}

// ---------------------------------------------------------------------------
// Student progress — Pre-Assessment, module activities and Post-Assessment, side by side
// ---------------------------------------------------------------------------

const PROGRESS_STATUS = {
  improved: 'Improved',
  same: 'No change',
  declined: 'Declined',
  awaiting: 'Awaiting Post-Assessment',
  none: 'Not yet assessed'
};

/**
 * One row for each learner and subject they are enrolled in, with how they did at
 * each stage: the Pre-Assessment (the latest one in the period), the average of
 * their module activities, and the Post-Assessment — and the change between the
 * first and the last.
 *
 * Read from the tables the system writes today (tutor_assessment_submissions,
 * student_module_reads), the same ones the learner's own Analytics page reads, so
 * the two never disagree. A tutor sees only the subjects they teach the learner;
 * a student, only their own.
 */
async function getProgressComparison(scope, filters = {}) {
  const student = studentScopeClause(scope, 'u');
  const period = periodClause('sub.submitted_at', filters);

  // The same period clause sits in all three OUTER APPLYs, so its parameters go in
  // three times, before the WHERE's — the driver binds them in the order they appear.
  const params = [...period.params, ...period.params, ...period.params, ...student.params];
  let extra = '';
  if (scope.isTutor) {
    // Only the subjects THIS tutor teaches the learner, not their other subjects.
    extra += ' AND usa.tutor_id = ?';
    params.push(scope.userId);
  }
  if (filters.subjectId && String(filters.subjectId) !== 'all') {
    extra += ' AND usa.subject_id = ?';
    params.push(Number(filters.subjectId));
  }

  const rows = await query(
    `SELECT u.id AS student_id, u.user_id AS student_code, u.first_name, u.middle_name, u.last_name,
            u.year_level, u.grade_level, u.branch_id, br.name AS branch_name,
            s.id AS subject_id, s.name AS subject_name,
            CONVERT(varchar(10), usa.start_date, 23) AS start_date, CONVERT(varchar(10), usa.end_date, 23) AS end_date,
            usa.enrolled_at, usa.created_at,
            pre.percentage AS pre_percentage, pre.level AS pre_level, pre.submitted_at AS pre_at,
            post.percentage AS post_percentage, post.level AS post_level, post.submitted_at AS post_at,
            mods.average_percentage AS module_average, COALESCE(mods.attempts, 0) AS module_attempts
     FROM user_subject_assignments usa
     JOIN users u ON u.id = usa.student_id
     JOIN subjects s ON s.id = usa.subject_id
     LEFT JOIN branches br ON br.id = u.branch_id
     OUTER APPLY (
       SELECT TOP 1 sub.percentage, sub.level, sub.submitted_at
       FROM tutor_assessment_submissions sub
       JOIN tutor_assessments ta ON ta.id = sub.assessment_id
       WHERE sub.student_id = u.id AND ta.subject_id = s.id AND ta.assessment_kind = 'pre_assessment'${period.sql}
       ORDER BY sub.submitted_at DESC, sub.id DESC
     ) pre
     OUTER APPLY (
       SELECT TOP 1 sub.percentage, sub.level, sub.submitted_at
       FROM tutor_assessment_submissions sub
       JOIN tutor_assessments ta ON ta.id = sub.assessment_id
       WHERE sub.student_id = u.id AND ta.subject_id = s.id AND ta.assessment_kind = 'post_assessment'${period.sql}
       ORDER BY sub.submitted_at DESC, sub.id DESC
     ) post
     OUTER APPLY (
       SELECT AVG(CAST(sub.percentage AS FLOAT)) AS average_percentage, COUNT(*) AS attempts
       FROM tutor_assessment_submissions sub
       JOIN tutor_assessments ta ON ta.id = sub.assessment_id
       WHERE sub.student_id = u.id AND ta.subject_id = s.id AND ta.assessment_kind = 'tutor_assessment'${period.sql}
     ) mods
     WHERE usa.is_archived = 0 AND u.role = 'student' AND u.is_archived = 0${student.sql}${extra}
     ORDER BY u.last_name ASC, u.first_name ASC, s.name ASC`,
    params
  );
  // The filter bar's search (learner, ID, subject, branch) narrows this table as
  // it narrows the rest of the page.
  const found = rows.filter((row) => matchesSearch(
    [row.first_name, row.middle_name, row.last_name, row.student_code, row.subject_name, row.branch_name],
    filters.search
  ));
  if (!found.length) return [];

  // Modules opened out of the modules the learner's own grade has in that subject.
  const subjectIds = [...new Set(found.map((row) => Number(row.subject_id)))];
  const inList = subjectIds.map(() => '?').join(',');
  const [modules, reads] = await Promise.all([
    query(
      `SELECT id, subject_id, grade_level, target_year_levels_json, created_at
         FROM modules WHERE is_archived = 0 AND subject_id IN (${inList})`,
      subjectIds
    ),
    query(
      `SELECT DISTINCT student_id, module_id FROM student_module_reads WHERE subject_id IN (${inList})`,
      subjectIds
    )
  ]);
  const opened = new Set(reads.map((row) => `${row.student_id}|${row.module_id}`));

  const percent = (value) => (value === null || value === undefined ? null : round(value));
  return found.map((row) => {
    const pre = percent(row.pre_percentage);
    const post = percent(row.post_percentage);
    const moduleAverage = Number(row.module_attempts) ? round(row.module_average) : null;
    const grade = studentGradeOf(row);
    // Their grade's modules — once their month is over, those of that month.
    const month = monthOf(row);
    const mine = grade
      ? modules.filter((mod) => Number(mod.subject_id) === Number(row.subject_id) && moduleGradeOf(mod) === grade
        && addedInMonth(mod.created_at, month))
      : [];
    const change = pre !== null && post !== null ? round(post - pre) : null;
    // No Post-Assessment yet: it stays open until they take it.
    const status = pre === null ? PROGRESS_STATUS.none
      : post === null ? PROGRESS_STATUS.awaiting
        : change > 0 ? PROGRESS_STATUS.improved
          : change < 0 ? PROGRESS_STATUS.declined : PROGRESS_STATUS.same;
    return {
      student_id: row.student_id,
      student_code: row.student_code,
      first_name: row.first_name,
      middle_name: row.middle_name,
      last_name: row.last_name,
      grade_level: row.grade_level,
      year_level: row.year_level,
      branch_id: row.branch_id,
      branch_name: row.branch_name || '—',
      subject_id: row.subject_id,
      subject_name: row.subject_name,
      pre,
      pre_level: row.pre_level || null,
      module_average: moduleAverage,
      module_attempts: Number(row.module_attempts || 0),
      post,
      post_level: row.post_level || null,
      change,
      status,
      modules_total: mine.length,
      modules_opened: mine.filter((mod) => opened.has(`${row.student_id}|${mod.id}`)).length
    };
  })
    // The status picked in the tab's own filter (Improved, Declined, …).
    .filter((row) => !filters.status || filters.status === 'all' || row.status === filters.status);
}

/** The average of the numbers that exist, or null when none do. */
function averageOf(values) {
  const present = values.filter((value) => value !== null && value !== undefined);
  return present.length ? round(sumOf(present) / present.length) : null;
}

/**
 * A pivot of AVERAGES. A cell with nothing behind it is null — not 0, because an
 * average change of exactly 0 is a real result ("no change") — and a row's or a
 * column's total is the average of everything in it, not the sum or the average
 * of the cell averages.
 */
function buildAveragePivot(items, { rowOf, colOf, measureOf }) {
  const alphabetical = (a, b) => String(a).localeCompare(String(b));
  const columns = [...new Set(items.map(colOf))].sort(alphabetical);
  const labels = [...new Set(items.map(rowOf))].sort(alphabetical);
  const valuesAt = (row, column) => items
    .filter((item) => (row === undefined || rowOf(item) === row) && (column === undefined || colOf(item) === column))
    .map(measureOf);
  return {
    columns,
    rows: labels.map((label) => ({
      label,
      counts: columns.map((column) => averageOf(valuesAt(label, column))),
      total: averageOf(valuesAt(label, undefined))
    })),
    totals: columns.map((column) => averageOf(valuesAt(undefined, column))),
    grand: averageOf(items.map(measureOf))
  };
}

/**
 * What the progress rows add up to: the headline figures, the stage averages by
 * subject (the comparison the grouped chart draws), the same by branch, and two
 * pivots — Subject by stage, and Branch by Subject (the average change).
 */
function buildProgressSummary(rows = []) {
  const learners = new Set(rows.map((row) => Number(row.student_id)));
  const comparable = rows.filter((row) => row.change !== null);
  const count = (status) => rows.filter((row) => row.status === status).length;

  const group = (keyOf, labelOf) => {
    const groups = new Map();
    for (const row of rows) {
      const key = keyOf(row);
      if (!groups.has(key)) groups.set(key, { key, label: labelOf(row), rows: [] });
      groups.get(key).rows.push(row);
    }
    return [...groups.values()]
      .sort((a, b) => String(a.label).localeCompare(String(b.label)))
      .map((entry) => ({
        key: entry.key,
        label: entry.label,
        learners: new Set(entry.rows.map((row) => Number(row.student_id))).size,
        compared: entry.rows.filter((row) => row.change !== null).length,
        pre: averageOf(entry.rows.map((row) => row.pre)),
        module: averageOf(entry.rows.map((row) => row.module_average)),
        post: averageOf(entry.rows.map((row) => row.post)),
        change: averageOf(entry.rows.map((row) => row.change))
      }));
  };

  const bySubject = group((row) => Number(row.subject_id), (row) => row.subject_name);
  const byBranch = group((row) => String(row.branch_id || 0), (row) => row.branch_name);

  return {
    learners: learners.size,
    enrolments: rows.length,
    compared: comparable.length,
    improved: count(PROGRESS_STATUS.improved),
    same: count(PROGRESS_STATUS.same),
    declined: count(PROGRESS_STATUS.declined),
    awaiting: count(PROGRESS_STATUS.awaiting),
    notAssessed: count(PROGRESS_STATUS.none),
    averagePre: averageOf(rows.map((row) => row.pre)),
    averageModule: averageOf(rows.map((row) => row.module_average)),
    averagePost: averageOf(rows.map((row) => row.post)),
    averageChange: averageOf(comparable.map((row) => row.change)),
    bySubject,
    byBranch,
    // Branch (rows) by Subject (columns): the average change where both exams were sat.
    branchSubjectChange: buildAveragePivot(comparable, {
      rowOf: (row) => row.branch_name,
      colOf: (row) => row.subject_name,
      measureOf: (row) => row.change
    })
  };
}

// ---------------------------------------------------------------------------
// The one call a route makes
// ---------------------------------------------------------------------------

/**
 * Everything the Analytics & Reports page shows, already scoped to the viewer.
 *
 * Every tab has its own filters (lib/analyticsFilters.js): `tabFilters.weak`
 * narrows Weak topics and nothing else, and a tab's branch (the main admin's
 * pick — an assistant is held to their own by resolveScope) is that tab's alone.
 * The headline figures at the top are the viewer's whole scope, whatever a tab
 * is filtered to.
 *
 * A question asked twice in one page — a tab with no filter asks what its
 * headline figure asks — goes to the database once: the database is remote, and
 * each round trip is the cost.
 *
 * @param {object} user        req.session.user
 * @param {object} tabFilters  from readAnalyticsFilters (lib/analyticsFilters.js)
 */
async function getAnalyticsDashboard(user, tabFilters = {}) {
  const base = resolveScope(user);
  const showMoney = canViewFinancials(base.role);
  const isStaff = base.isAdmin || base.isAssistant;
  const tab = (name) => tabFilters[name] || {};
  const scopeOf = (name) => resolveScope(user, { requestedBranchId: tab(name).branchId });
  const pick = (filters, names) => Object.fromEntries(names.map((name) => [name, filters[name]]));

  const asked = new Map();
  const once = (fn, scope, filters = {}) => {
    const wanted = setOnly(filters);
    const key = JSON.stringify([fn.name, scope.branchId || 0, wanted]);
    if (!asked.has(key)) asked.set(key, fn(scope, wanted));
    return asked.get(key);
  };

  const [
    allSubmissions, trendSubmissions, attemptRows,
    allWeak, weakRows, weakLearners,
    allPerformance, performanceRows,
    completion, enrolment, levels,
    allViolations, violationRows,
    subjects, progressRows, registry, financials
  ] = await Promise.all([
    once(getScopedSubmissions, base),
    once(getScopedSubmissions, scopeOf('trend'), pick(tab('trend'), ['subjectId'])),
    once(getScopedSubmissions, scopeOf('attempts'), pick(tab('attempts'), ['search', 'subjectId', 'kind', 'from', 'to'])),
    once(getWeakTopics, base),
    once(getWeakTopics, scopeOf('weak'), pick(tab('weak'), ['subjectId'])),
    // Who is weak in each topic: for staff and tutors (a student's are their own).
    base.isStudent ? Promise.resolve(new Map()) : once(getWeakTopicLearners, scopeOf('weak'), pick(tab('weak'), ['subjectId'])),
    base.isStudent ? Promise.resolve([]) : once(getStudentPerformance, base),
    base.isStudent ? Promise.resolve([]) : once(getStudentPerformance, scopeOf('perf'), pick(tab('perf'), ['search', 'subjectId'])),
    once(getModuleCompletion, scopeOf('enrolment')),
    showMoney ? getEnrolmentBreakdown(scopeOf('enrolment')) : Promise.resolve([]),
    once(getLevelSpread, scopeOf('levels'), pick(tab('levels'), ['subjectId'])),
    base.isStudent ? Promise.resolve([]) : once(getViolationSummary, base),
    base.isStudent ? Promise.resolve([]) : once(getViolationSummary, scopeOf('integrity'), pick(tab('integrity'), ['from', 'to'])),
    getScopedSubjects(base),
    // Student progress: every role, each within its own scope.
    getProgressComparison(scopeOf('progress'), pick(tab('progress'), ['search', 'subjectId', 'status'])),
    // The user registry: staff only.
    isStaff
      ? getUserRegistry(scopeOf('registry'), {
        search: tab('registry').search,
        from: tab('registry').from,
        to: tab('registry').to,
        registryRole: tab('registry').role,
        registryStatus: tab('registry').status
      })
      : Promise.resolve({ rows: [], everyone: [] }),
    // getIncomeTrend is deliberately NOT called: the Income Trend chart was
    // removed in Phase 6, and a monthly GROUP BY on every page load for a chart
    // nobody draws is just a slower page.
    showMoney ? getFinancialSummary(base) : Promise.resolve(null)
  ]);

  // Weak topics: the tab's search reads the topic and the subject; each topic
  // carries the learners weak in it, for the list a click opens.
  const weakTopics = weakRows
    .filter((topic) => matchesSearch([topic.topic, topic.subject_name], tab('weak').search))
    .map((topic) => {
      const who = weakLearners.get(topic.key);
      return { ...topic, weak_learners: who ? who.weak : [], weak_count: who ? who.weak.length : 0 };
    });

  // Assessment integrity: the tab's search reads the learner, the assessment and the event.
  const violations = violationRows.filter((row) => matchesSearch(
    [row.first_name, row.last_name, row.student_code, row.title, row.subject_name, row.branch_name, row.violation_type],
    tab('integrity').search
  ));

  const graded = allSubmissions.filter((row) => row.total_points > 0);
  const averageScore = graded.length
    ? round(graded.reduce((sum, row) => sum + Number(row.percentage || 0), 0) / graded.length)
    : 0;

  const learnerCount = base.isStudent
    ? subjects.length
    : new Set(allPerformance.filter((row) => row.attempts > 0 || !base.isTutor).map((row) => String(row.student_id))).size;

  return {
    scope: base,
    filters: tabFilters,
    // Each tab's filter bar: its fields for this viewer, their values, and the
    // other tabs' filters it keeps.
    forms: tabForms(tabFilters, base.role),
    subjects,
    // Recent attempts (My assessment history), after that tab's filters.
    submissions: attemptRows,
    // The attempts the Score trend tab draws — for a student, a chart per subject.
    trendSubmissions,
    weakTopics,
    weakBelow: WEAK_BELOW,
    performance: performanceRows,
    completion,
    levels,
    violations,
    trend: buildTrend(trendSubmissions),
    financials,
    enrolment,
    progress: { rows: progressRows, summary: buildProgressSummary(progressRows) },
    registry: isStaff ? { rows: registry.rows, everyone: registry.everyone } : null,
    kpis: {
      learners: learnerCount,
      attempts: allSubmissions.length,
      averageScore,
      weakTopics: allWeak.filter((topic) => topic.percentage < WEAK_BELOW).length,
      flagged: allViolations.length,
      autoSubmitted: allSubmissions.filter((row) => Number(row.is_auto_submitted) === 1).length,
      collected: financials ? financials.collected : null,
      outstanding: financials ? financials.outstanding : null
    }
  };
}

module.exports = {
  getAnalyticsDashboard,
  getScopedSubmissions,
  getWeakTopics,
  getWeakTopicLearners,
  WEAK_BELOW,
  getStudentPerformance,
  getModuleCompletion,
  getLevelSpread,
  getViolationSummary,
  getFinancialSummary,
  getIncomeTrend,
  getEnrolmentBreakdown,
  getScopedSubjects,
  buildTrend,
  // User registry, and student progress with the pivot of averages it uses.
  getUserRegistry,
  getProgressComparison,
  buildProgressSummary,
  buildAveragePivot,
  PROGRESS_STATUS
};
