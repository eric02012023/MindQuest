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

/** Module completion: how far through each subject the students in scope are. */
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

  const rows = await query(
    `SELECT s.id AS subject_id, s.name AS subject_name,
            COUNT(DISTINCT u.id) AS student_count,
            COUNT(DISTINCT smr.id) AS opens,
            (SELECT COUNT(*) FROM modules m WHERE m.subject_id = s.id AND m.is_archived = 0) AS module_count
     FROM user_subject_assignments usa
     JOIN subjects s ON s.id = usa.subject_id
     JOIN users u ON u.id = usa.student_id
     LEFT JOIN student_module_reads smr ON smr.student_id = u.id AND smr.subject_id = s.id
     WHERE usa.is_archived = 0 AND u.role = 'student' AND u.is_archived = 0${student.sql}${extra}
     GROUP BY s.id, s.name
     ORDER BY s.name ASC`,
    params
  );

  return rows.map((row) => {
    const students = Number(row.student_count || 0);
    const modules = Number(row.module_count || 0);
    const opens = Number(row.opens || 0);
    const possible = students * modules;
    return {
      subject_id: row.subject_id,
      subject_name: row.subject_name,
      student_count: students,
      module_count: modules,
      opens,
      completion: possible ? round((opens / possible) * 100) : 0
    };
  });
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

/** Income by month, for the staff trend chart. */
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

// ---------------------------------------------------------------------------
// The one call a route makes
// ---------------------------------------------------------------------------

/**
 * Everything the Analytics & Reports page shows, already scoped to the viewer.
 *
 * @param {object} user     req.session.user
 * @param {object} filters  { search, subjectId, kind, from, to, branchId }
 */
async function getAnalyticsDashboard(user, filters = {}) {
  const scope = resolveScope(user, { requestedBranchId: filters.branchId });
  const showMoney = canViewFinancials(scope.role);

  const [
    submissions, weakTopics, performance, completion, levels, violations, subjects
  ] = await Promise.all([
    getScopedSubmissions(scope, filters),
    getWeakTopics(scope, filters),
    scope.isStudent ? Promise.resolve([]) : getStudentPerformance(scope, filters),
    getModuleCompletion(scope, filters),
    getLevelSpread(scope, filters),
    scope.isStudent ? Promise.resolve([]) : getViolationSummary(scope, filters),
    getScopedSubjects(scope)
  ]);

  const [financials, incomeTrend, enrolment] = showMoney
    ? await Promise.all([
      getFinancialSummary(scope, filters),
      getIncomeTrend(scope, filters),
      getEnrolmentBreakdown(scope)
    ])
    : [null, [], []];

  const graded = submissions.filter((row) => row.total_points > 0);
  const averageScore = graded.length
    ? round(graded.reduce((sum, row) => sum + Number(row.percentage || 0), 0) / graded.length)
    : 0;

  const learnerCount = scope.isStudent
    ? subjects.length
    : new Set(performance.filter((row) => row.attempts > 0 || !scope.isTutor).map((row) => String(row.student_id))).size;

  return {
    scope,
    filters,
    subjects,
    submissions,
    weakTopics,
    performance,
    completion,
    levels,
    violations,
    trend: buildTrend(submissions),
    financials,
    incomeTrend,
    enrolment,
    kpis: {
      learners: learnerCount,
      attempts: submissions.length,
      averageScore,
      weakTopics: weakTopics.filter((topic) => topic.percentage < 60).length,
      flagged: violations.length,
      autoSubmitted: submissions.filter((row) => Number(row.is_auto_submitted) === 1).length,
      collected: financials ? financials.collected : null,
      outstanding: financials ? financials.outstanding : null
    }
  };
}

module.exports = {
  getAnalyticsDashboard,
  getScopedSubmissions,
  getWeakTopics,
  getStudentPerformance,
  getModuleCompletion,
  getLevelSpread,
  getViolationSummary,
  getFinancialSummary,
  getIncomeTrend,
  getEnrolmentBreakdown,
  getScopedSubjects,
  buildTrend
};
