/**
 * File: lib/questionBank.js
 * Purpose: The Question Bank: every question the system holds, in one list.
 *
 * Nothing is stored for it. The questions are the ones every assessment already
 * keeps (tutor_assessment_questions): the AI-written Pre-Assessment masters and
 * each student's own copy of one (lib/studentPre.js), the Post-Assessments, the
 * module assessments written for each student, and the activities tutors write.
 * This only reads them.
 *
 * ONE ROW PER QUESTION, NOT PER COPY
 * A master's question is copied into every student's own Pre-Assessment, and
 * again into their Post-Assessment, so one question can sit in sixty
 * assessments. Listing every copy would bury the bank, so copies are grouped:
 * one row per subject, question and correct answer — the answer's words, not
 * its letter, since a Post-Assessment shuffles the choices — with how many
 * students have it (Used in). A question someone edited reads differently, so it
 * is a row of its own.
 *
 * WHO MADE IT
 *   AI     a master, or anything else the AI wrote (tutor_id empty), and a
 *          student's copy of a master's question as it was written
 *   Tutor  what a tutor wrote, and a question added or reworded in a student's
 *          own Pre- or Post-Assessment (no master, not even a retired one, holds
 *          the same question with the same answer)
 *
 * ITEM ANALYSIS
 * Every answer ever given to any copy of a question — in a submission
 * (tutor_student_answers) or in a take of a module assessment
 * (tutor_assessment_attempt_answers) — counts towards its % correct, and so its
 * difficulty: Easy at 80% and above, Hard at 20% and below, Average between.
 *
 * WHO SEES WHAT
 *   main admin   every question
 *   assistant    the masters and other shared questions, and what was written
 *                for the students of their own branch
 *   tutor        in the subjects they teach: the masters and other shared
 *                questions, and what was written for their own students
 */

const { query } = require('../config/db');
const { cleanId } = require('./listFilters');
const { GRADE_LEVELS, canonicalGrade } = require('./moduleGrades');

const PAGE_SIZE = 25;
const EASY_FROM = 80;
const HARD_UPTO = 20;

const TYPES = { pre: 'Pre-Assessment', post: 'Post-Assessment', module: 'Module Assessment', activity: 'Activity' };
const MADE_BY = { ai: 'AI', tutor: 'Tutor' };
const STATUSES = { draft: 'Draft', open: 'Open' };
const DIFFICULTIES = { easy: 'Easy', average: 'Average', hard: 'Hard', none: 'Not answered yet' };

function pick(value, allowed) {
  const key = String(value == null ? '' : value).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(allowed, key) ? key : 'all';
}

/** The filter bar's values from the query string, each one checked. */
function readBankFilters(input = {}) {
  const grade = canonicalGrade(input.grade);
  const page = Math.floor(Number(input.page));
  return {
    search: String(input.search || '').replace(/\s+/g, ' ').trim().slice(0, 100),
    subjectId: cleanId(input.subject_id),
    grade: grade && GRADE_LEVELS.includes(grade) ? grade : 'all',
    moduleId: cleanId(input.module_id),
    objectiveId: cleanId(input.objective_id),
    type: pick(input.type, TYPES),
    madeBy: pick(input.made_by, MADE_BY),
    status: pick(input.status, STATUSES),
    difficulty: pick(input.difficulty, DIFFICULTIES),
    page: Number.isFinite(page) && page > 0 ? page : 1
  };
}

/** A question's words, as they are grouped: the same text, any case, any outer spaces. */
const normText = (alias) => `LOWER(LTRIM(RTRIM(CAST(LEFT(${alias}.question_text, 1800) AS NVARCHAR(1800)))))`;

/**
 * Its fingerprint. Grouping or matching on the words themselves — up to 1,800
 * letters a row — cost seconds; a 32-byte hash of them costs nothing. At most
 * 3,600 bytes go in (and 1,000 more for an answer), inside HASHBYTES' limit on
 * every SQL Server version.
 */
const hashOf = (expression) => `HASHBYTES('SHA2_256', ${expression})`;

/**
 * Who may see which questions, as SQL over `ta` (the assessment) — or null when
 * the viewer may see none.
 *
 * @param {object} viewer  { role: 'admin' } | { role: 'assistant', branchId }
 *                         | { role: 'tutor', tutorId, subjectIds }
 */
function scopeFor(viewer = {}) {
  if (viewer.role === 'admin') return { sql: '', params: [] };
  if (viewer.role === 'assistant') {
    return {
      sql: ' AND (ta.for_student_id IS NULL OR stu.branch_id = ?)',
      params: [Number(viewer.branchId) || 0]
    };
  }
  if (viewer.role === 'tutor') {
    const subjects = [...new Set((viewer.subjectIds || []).map(Number).filter(Boolean))];
    if (!subjects.length || !Number(viewer.tutorId)) return null;
    return {
      sql: ` AND ta.subject_id IN (${subjects.map(() => '?').join(', ')})
             AND (ta.for_student_id IS NULL OR EXISTS (
                   SELECT 1 FROM user_subject_assignments usa
                    WHERE usa.tutor_id = ? AND usa.student_id = ta.for_student_id
                      AND usa.subject_id = ta.subject_id AND usa.is_archived = 0))`,
      params: [...subjects, Number(viewer.tutorId)]
    };
  }
  return null;
}

/**
 * The grouped list as one statement's WITH part, and its parameters — shared by
 * the count and the page, so the pager can never describe a different list from
 * the one it pages through.
 */
function buildBankSql(viewer, filters) {
  const scope = scopeFor(viewer);
  if (!scope) return null;
  const where = [];
  const params = [...scope.params];
  if (filters.subjectId !== 'all') { where.push('k.subject_id = ?'); params.push(Number(filters.subjectId)); }
  if (filters.grade !== 'all') { where.push('k.grade_level = ?'); params.push(filters.grade); }
  if (filters.moduleId !== 'all') { where.push('k.module_id = ?'); params.push(Number(filters.moduleId)); }
  if (filters.objectiveId && filters.objectiveId !== 'all') { where.push('k.objective_id = ?'); params.push(Number(filters.objectiveId)); }
  if (filters.type !== 'all') { where.push('k.type_key = ?'); params.push(filters.type); }
  if (filters.status !== 'all') { where.push('k.status_key = ?'); params.push(filters.status); }
  if (filters.search) { where.push('k.norm_text LIKE ?'); params.push(`%${filters.search.toLowerCase()}%`); }

  const rated = [];
  if (filters.madeBy === 'ai') rated.push('g.by_ai = 1');
  if (filters.madeBy === 'tutor') rated.push('g.by_tutor = 1');

  // base: every question the viewer may see, plus every Pre-Assessment master
  // ever written — retired ones too, only so that a copy of one is still known
  // for the AI's. The key's words come from joining the choices directly: a
  // question has one choice per letter (every writer of choices letters them A,
  // B, C… once each; the live data had no repeat on 2026-11-20). Looking each
  // key up, or grouping the choices first, read the 10,000 choices over and over.
  //
  // marked: a question is the AI's when a master holds the very same question
  // and answer — the same group. Worked out once over the group (a window), not
  // by matching every question's words against every master's, which took
  // seconds.
  const sql = `WITH base AS (
      SELECT q.id, ta.subject_id, ta.for_student_id, ta.id AS assessment_id, ta.is_archived, ta.tutor_id,
             ta.assessment_kind, x.norm_text, x.grade_level, x.module_id, x.type_key, x.status_key,
             m.order_number AS module_order, q.objective_id,
             ${hashOf("CONCAT(x.norm_text, N'|', x.norm_answer)")} AS group_key,
             CASE WHEN ta.assessment_kind = 'pre_assessment' AND ta.for_student_id IS NULL THEN 1 ELSE 0 END AS is_master
        FROM tutor_assessment_questions q
        JOIN tutor_assessments ta ON ta.id = q.assessment_id
        LEFT JOIN users stu ON stu.id = ta.for_student_id
        LEFT JOIN tutor_question_options ko ON ko.question_id = q.id AND ko.option_label = q.correct_answer
        LEFT JOIN modules m ON m.id = COALESCE(q.source_module_id, ta.module_id)
        CROSS APPLY (
          SELECT ${normText('q')} AS norm_text,
                 LOWER(LTRIM(RTRIM(COALESCE(ko.option_text, q.correct_answer)))) AS norm_answer,
                 COALESCE(ta.grade_level, m.grade_level) AS grade_level,
                 COALESCE(q.source_module_id, ta.module_id) AS module_id,
                 CASE WHEN ta.assessment_kind = 'pre_assessment' THEN 'pre'
                      WHEN ta.assessment_kind = 'post_assessment' THEN 'post'
                      WHEN ta.purpose = 'activity' THEN 'activity'
                      ELSE 'module' END AS type_key,
                 CASE WHEN ta.assessment_kind = 'pre_assessment' AND ta.for_student_id IS NULL THEN 'master'
                      WHEN ta.is_published = 0 THEN 'draft'
                      ELSE 'open' END AS status_key
        ) x
       WHERE (ta.is_archived = 0 OR (ta.assessment_kind = 'pre_assessment' AND ta.for_student_id IS NULL))${scope.sql}
    ),
    marked AS (
      SELECT b.*, MAX(b.is_master) OVER (PARTITION BY b.subject_id, b.group_key) AS from_master
        FROM base b
    ),
    bank AS (
      SELECT k.id, k.subject_id, k.for_student_id, k.assessment_id, k.group_key, k.type_key, k.status_key, k.module_order,
             CASE WHEN k.tutor_id IS NOT NULL THEN 'tutor'
                  WHEN k.assessment_kind IN ('pre_assessment', 'post_assessment') AND k.from_master = 0 THEN 'tutor'
                  ELSE 'ai' END AS made_by
        FROM marked k
       WHERE k.is_archived = 0${where.length ? ` AND ${where.join(' AND ')}` : ''}
    ),
    stats AS (
      SELECT a.question_id, COUNT(*) AS answered, SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END) AS correct
        FROM (
          SELECT question_id, is_correct FROM tutor_student_answers
          UNION ALL
          SELECT question_id, is_correct FROM tutor_assessment_attempt_answers
        ) a
       GROUP BY a.question_id
    ),
    grouped AS (
      SELECT b.subject_id, b.group_key,
             MIN(b.id) AS sample_id,
             COUNT(*) AS uses,
             COUNT(DISTINCT b.for_student_id) AS students,
             SUM(CASE WHEN b.status_key = 'master' THEN 1 ELSE 0 END) AS masters,
             SUM(CASE WHEN b.for_student_id IS NULL AND b.status_key <> 'master' THEN 1 ELSE 0 END) AS shared_uses,
             MAX(CASE WHEN b.type_key = 'pre' THEN 1 ELSE 0 END) AS in_pre,
             MAX(CASE WHEN b.type_key = 'post' THEN 1 ELSE 0 END) AS in_post,
             MAX(CASE WHEN b.type_key = 'module' THEN 1 ELSE 0 END) AS in_module,
             MAX(CASE WHEN b.type_key = 'activity' THEN 1 ELSE 0 END) AS in_activity,
             MAX(CASE WHEN b.made_by = 'ai' THEN 1 ELSE 0 END) AS by_ai,
             MAX(CASE WHEN b.made_by = 'tutor' THEN 1 ELSE 0 END) AS by_tutor,
             SUM(CASE WHEN b.status_key = 'draft' THEN 1 ELSE 0 END) AS drafts,
             MIN(COALESCE(b.module_order, 9999)) AS module_order,
             SUM(COALESCE(s.answered, 0)) AS answered,
             SUM(COALESCE(s.correct, 0)) AS correct
        FROM bank b
        LEFT JOIN stats s ON s.question_id = b.id
       GROUP BY b.subject_id, b.group_key
    ),
    rated AS (
      SELECT g.*,
             CASE WHEN g.answered = 0 THEN 'none'
                  WHEN g.correct * 100 >= g.answered * ${EASY_FROM} THEN 'easy'
                  WHEN g.correct * 100 <= g.answered * ${HARD_UPTO} THEN 'hard'
                  ELSE 'average' END AS difficulty
        FROM grouped g${rated.length ? ` WHERE ${rated.join(' AND ')}` : ''}
    ),
    listed AS (
      SELECT r.* FROM rated r${filters.difficulty !== 'all' ? ' WHERE r.difficulty = ?' : ''}
    )`;
  if (filters.difficulty !== 'all') params.push(filters.difficulty);
  return { sql, params };
}

/** Easy / Average / Hard from right and total answers, or null before anyone answered. */
function difficultyOf(correct, answered) {
  if (!Number(answered)) return null;
  const pct = (Number(correct) / Number(answered)) * 100;
  if (pct >= EASY_FROM) return 'easy';
  if (pct <= HARD_UPTO) return 'hard';
  return 'average';
}

/** "Master + 25 students", "Shared", "1 student": where a question is used. */
function usedInLabel(row) {
  const parts = [];
  if (Number(row.masters)) parts.push('Master');
  if (Number(row.shared_uses)) parts.push('Shared');
  const students = Number(row.students) || 0;
  if (students) parts.push(`${students} student${students === 1 ? '' : 's'}`);
  return parts.join(' + ') || '—';
}

/**
 * One grouped row, with its sample question, as the page shows it. A question
 * used once, in an assessment written for one student, links to that
 * assessment's own page: Edit while it is a draft the viewer may change, View
 * otherwise.
 */
function shapeRow(row, detail, options = {}) {
  const d = detail || {};
  const types = Object.keys(TYPES).filter((key) => Number(row[`in_${key}`])).map((key) => TYPES[key]);
  const madeBy = [Number(row.by_ai) ? 'AI' : null, Number(row.by_tutor) ? 'Tutor' : null].filter(Boolean);
  const answered = Number(row.answered) || 0;
  const correct = Number(row.correct) || 0;
  const difficulty = difficultyOf(correct, answered);
  let link = null;
  if (Number(row.uses) === 1 && Number(d.has_check_page) && options.linkBase) {
    const draft = Number(d.is_published) === 0;
    link = {
      href: `${options.linkBase}/path-assessments/${Number(d.assessment_id)}/edit`,
      label: draft && options.canEdit ? 'Edit' : 'View'
    };
  }
  return {
    id: Number(row.sample_id),
    subjectName: row.subject_name || d.subject_name || '',
    text: d.question_text || '',
    type: d.question_type || '',
    choices: (d.options || []).map((o) => ({
      label: o.option_label,
      text: o.option_text,
      isKey: String(o.option_label).toUpperCase() === String(d.correct_answer || '').toUpperCase()
    })),
    answer: answerText(d),
    explanation: d.explanation || '',
    moduleLabel: d.module_title ? `Module ${d.module_order || '?'}: ${d.module_title}` : 'No module',
    handoutName: d.handout_name || '',
    // The learning objective it measures (lib/objectives.js), when it has one.
    objective: d.objective_text || '',
    types,
    madeBy,
    usedIn: usedInLabel(row),
    drafts: Number(row.drafts) || 0,
    answered,
    correct,
    percent: answered ? Math.round((correct / answered) * 1000) / 10 : null,
    difficulty,
    difficultyLabel: difficulty ? DIFFICULTIES[difficulty] : DIFFICULTIES.none,
    link
  };
}

/** The correct answer in words: the key choice's text, True / False, or what was typed. */
function answerText(d) {
  if (!d) return '';
  if (d.question_type === 'true_false') return /^t/i.test(String(d.correct_answer)) ? 'True' : 'False';
  const key = (d.options || []).find((o) => String(o.option_label).toUpperCase() === String(d.correct_answer || '').toUpperCase());
  return key ? `${key.option_label}. ${key.option_text}` : String(d.correct_answer || '');
}

/**
 * THE LIST, WORKED OUT ONCE
 * Grouping every question and counting every answer is the one heavy statement
 * here — a second or two on the centre's database server, and a server that busy
 * is slower for everyone using the site. So the grouped list for one viewer and
 * one set of filters is kept for a while and paged in memory: turning a page
 * asks nothing heavy of the database.
 *
 * Nothing is joined to the grouped list in that statement: joined to anything
 * (subjects, the questions), the server worked the whole list out again for each
 * match. The page's own questions are fetched after, by id (detailsFor).
 *
 * Kept, not frozen: within LIST_FRESH_MS it is reused as it is (paging through);
 * after that, one light statement (versionOf) asks whether any question, answer
 * or assessment changed, and the list is worked out again when one did — and
 * after LIST_MAX_AGE_MS in any case.
 */
const LIST_SELECT = `
     SELECT l.* FROM listed l
      ORDER BY l.subject_id ASC, l.module_order ASC, l.sample_id ASC`;
const LIST_FRESH_MS = 15 * 1000;
const LIST_MAX_AGE_MS = 5 * 60 * 1000;
const LIST_CACHE_SIZE = 40;
const listCache = new Map();

/** What the list is made of, in one light statement: changed when a question, an answer or an assessment changes. */
async function versionOf() {
  const [row] = await query(
    `SELECT (SELECT COUNT(*) FROM tutor_assessment_questions) AS questions,
            (SELECT MAX(id) FROM tutor_assessment_questions) AS last_question,
            (SELECT COUNT(*) FROM tutor_student_answers) AS answers,
            (SELECT COUNT(*) FROM tutor_assessment_attempt_answers) AS take_answers,
            (SELECT COUNT(*) FROM tutor_assessments) AS assessments,
            (SELECT MAX(updated_at) FROM tutor_assessments) AS changed`
  );
  const r = row || {};
  const changed = r.changed instanceof Date ? r.changed.getTime() : String(r.changed || '');
  return [r.questions, r.last_question, r.answers, r.take_answers, r.assessments, changed].join('|');
}

/** The whole grouped list for a viewer and filters, worked out once and kept (see above). */
async function groupedList(viewer, filters) {
  const built = buildBankSql(viewer, filters);
  if (!built) return [];
  const { page: _page, ...listFilters } = filters;
  const key = JSON.stringify({
    role: viewer.role,
    branchId: viewer.branchId || null,
    tutorId: viewer.tutorId || null,
    subjectIds: [...new Set((viewer.subjectIds || []).map(Number))].sort((a, b) => a - b),
    filters: listFilters
  });
  const now = Date.now();
  const kept = listCache.get(key);
  if (kept && now - kept.usedAt < LIST_FRESH_MS) return kept.rows;
  const version = await versionOf();
  if (kept && kept.version === version && now - kept.madeAt < LIST_MAX_AGE_MS) {
    kept.usedAt = now;
    return kept.rows;
  }
  const rows = (await query(`${built.sql}${LIST_SELECT}`, built.params))
    .map(({ group_key: _key, ...row }) => row);
  listCache.delete(key);
  listCache.set(key, { rows, version, madeAt: now, usedAt: now });
  while (listCache.size > LIST_CACHE_SIZE) listCache.delete(listCache.keys().next().value);
  return rows;
}

/** Forget every kept list (tests; and nothing else needs it — the version check keeps them true). */
function clearBankCache() {
  listCache.clear();
}

/**
 * The sample question of each row on the page, in full — words, key, why,
 * module, handout, subject, its choices — and whether its assessment has a page
 * of its own to check (a student's own Pre-Assessment, or a module assessment
 * or Post-Assessment of a learning path). Two light statements side by side.
 */
async function detailsFor(ids) {
  const list = [...new Set(ids.map(Number).filter(Boolean))];
  if (!list.length) return new Map();
  const marks = list.map(() => '?').join(', ');
  const [rows, options] = await Promise.all([
    query(
      `SELECT q.id, q.question_text, q.question_type, q.correct_answer, q.explanation, q.assessment_id,
              s.name AS subject_name, m.order_number AS module_order, m.title AS module_title,
              h.file_original_name AS handout_name, ta.is_published, o.objective_text,
              CASE WHEN EXISTS (SELECT 1 FROM student_pre_assessments spa WHERE spa.assessment_id = ta.id)
                     OR EXISTS (SELECT 1 FROM learning_path_modules lpm WHERE lpm.assessment_id = ta.id)
                     OR EXISTS (SELECT 1 FROM learning_paths lp WHERE lp.post_assessment_id = ta.id)
                   THEN 1 ELSE 0 END AS has_check_page
         FROM tutor_assessment_questions q
         JOIN tutor_assessments ta ON ta.id = q.assessment_id
         JOIN subjects s ON s.id = ta.subject_id
         LEFT JOIN modules m ON m.id = COALESCE(q.source_module_id, ta.module_id)
         LEFT JOIN module_handouts h ON h.id = q.source_handout_id
         LEFT JOIN module_objectives o ON o.id = q.objective_id
        WHERE q.id IN (${marks})`,
      list
    ),
    query(
      `SELECT question_id, option_label, option_text FROM tutor_question_options
        WHERE question_id IN (${marks})
        ORDER BY question_id ASC, option_label ASC`,
      list
    )
  ]);
  const byQuestion = new Map(rows.map((row) => [Number(row.id), { ...row, options: [] }]));
  for (const option of options) {
    const owner = byQuestion.get(Number(option.question_id));
    if (owner) owner.options.push(option);
  }
  return byQuestion;
}

/** The counts for the strip above the list. */
function summaryOf(groups) {
  const count = (difficulty) => groups.filter((row) => row.difficulty === difficulty).length;
  return {
    total: groups.length,
    answered: groups.filter((row) => row.difficulty && row.difficulty !== 'none').length,
    easy: count('easy'),
    average: count('average'),
    hard: count('hard')
  };
}

/**
 * One page of the bank, with the pager and the counts for the strip above it.
 * A page past the end — an old link, or fewer questions since — is the last.
 *
 * @param {object} viewer   see scopeFor
 * @param {object} filters  readBankFilters(...)
 * @param {object} [options] { linkBase, canEdit, pageSize }
 */
async function getQuestionBank(viewer, filters, options = {}) {
  const pageSize = Number(options.pageSize) || PAGE_SIZE;
  const groups = await groupedList(viewer, filters);
  const summary = summaryOf(groups);
  const pageCount = Math.max(1, Math.ceil(groups.length / pageSize));
  const page = Math.min(pageCount, Math.max(1, Number(filters.page) || 1));
  const slice = groups.slice((page - 1) * pageSize, page * pageSize);
  const details = slice.length ? await detailsFor(slice.map((row) => row.sample_id)) : new Map();
  return {
    rows: slice.map((row) => shapeRow(row, details.get(Number(row.sample_id)), options)),
    pager: { page, pageCount, total: groups.length, pageSize },
    summary
  };
}

/** The learning objectives the Objective filter offers: the chosen subject's approved ones, in the chosen grade or module. */
async function objectiveOptionsFor(filters) {
  if (!filters || filters.subjectId === 'all') return [];
  const { objectiveOptions } = require('./objectives');
  return objectiveOptions({
    subjectId: Number(filters.subjectId),
    gradeLevel: filters.grade !== 'all' ? filters.grade : null,
    moduleId: filters.moduleId !== 'all' ? Number(filters.moduleId) : null
  });
}

/** The modules the Module filter offers: the chosen subject's, in the chosen grade when there is one. */
async function moduleOptionsFor(filters) {
  if (!filters || filters.subjectId === 'all') return [];
  const { getSubjectModules } = require('./data');
  const modules = await getSubjectModules(Number(filters.subjectId), filters.grade !== 'all' ? { gradeLevel: filters.grade } : {});
  return modules.map((mod) => ({
    id: Number(mod.id),
    label: `Module ${mod.order_number || '?'}: ${mod.title}${filters.grade === 'all' && mod.grade_level ? ` (${mod.grade_level})` : ''}`
  }));
}

module.exports = {
  LIST_SELECT,
  LIST_FRESH_MS,
  clearBankCache,
  _listCache: listCache,
  PAGE_SIZE,
  EASY_FROM,
  HARD_UPTO,
  TYPES,
  MADE_BY,
  STATUSES,
  DIFFICULTIES,
  readBankFilters,
  scopeFor,
  buildBankSql,
  difficultyOf,
  usedInLabel,
  shapeRow,
  answerText,
  getQuestionBank,
  moduleOptionsFor,
  objectiveOptionsFor
};
