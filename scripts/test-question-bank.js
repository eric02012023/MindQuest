/**
 * File: scripts/test-question-bank.js
 * Purpose: Pin down the Question Bank (lib/questionBank.js): every question the
 *          system holds, one row per question, with where it is used and how
 *          students did on it.
 *
 * Run:  node scripts/test-question-bank.js       (needs no database, no keys)
 *
 * WHAT MUST HOLD
 *   1. The filter bar's values are checked: anything unknown is "all", a page
 *      is a whole number from 1, a search is trimmed and short.
 *   2. Each viewer sees their own: the main admin everything; an assistant the
 *      shared questions and their branch's students'; a tutor their subjects
 *      and their own students' — and a tutor with no subject sees nothing,
 *      without a query.
 *   3. Every filter becomes its own parameter, never text in the statement, and
 *      the statement and its parameters always agree in number. Copies group by
 *      the answer's words; a question is the AI's when a master — even a
 *      retired one — holds the same question and answer.
 *   4. Item analysis: Easy at 80% and above, Hard at 20% and below, Average
 *      between, nothing before anyone answered.
 *   5. A row says what it is: the answer in words, its types, who made it,
 *      where it is used; one student's draft links to its page to edit, and only
 *      someone who may edit it is offered Edit.
 *   6. The grouped list is worked out once and paged in memory: a page past the
 *      end is the last page; a page turned soon after asks nothing heavy; later,
 *      one light question says whether anything changed, and only a change
 *      works the list out again.
 *   7. The page itself renders: filters, the counts, every row, the pager.
 *
 * `config/db` is replaced in the require cache before anything loads it.
 */
const path = require('path');
const fs = require('fs');

let failures = 0;
const ok = (label, condition, extra = '') => {
  if (condition) console.log(`  PASS  ${label}${extra ? ' — ' + extra : ''}`);
  else { failures++; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
};

// --- the scripted database ------------------------------------------------
const db = { statements: [], version: { questions: 10 }, list: [], details: [], options: [] };

const VERSION_SQL = 'SELECT (SELECT COUNT(*) FROM tutor_assessment_questions) AS questions';
function answer(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  db.statements.push({ sql, params });
  if (sql.startsWith(VERSION_SQL)) return [db.version];
  if (sql.startsWith('WITH base') && sql.includes('SELECT l.* FROM listed l ORDER BY')) return db.list;
  if (sql.startsWith('SELECT q.id, q.question_text, q.question_type')) {
    return db.details.filter((row) => params.map(Number).includes(Number(row.id)));
  }
  if (sql.startsWith('SELECT question_id, option_label, option_text FROM tutor_question_options')) return db.options;
  return [];
}

const dbPath = require.resolve('../config/db');
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    sql: {},
    baseConfig: {},
    getPool: async () => { throw new Error('the test must never open a connection'); },
    query: async (text, params = []) => answer(text, params),
    withTransaction: async (work) => work({ query: async (text, params = []) => [answer(text, params)] })
  }
};

const bank = require('../lib/questionBank');

/** Placeholders outside string literals, the way config/db.js finds them. */
function placeholders(sqlText) {
  let count = 0;
  let inString = false;
  for (const ch of String(sqlText)) {
    if (ch === "'") inString = !inString;
    if (ch === '?' && !inString) count += 1;
  }
  return count;
}

function fresh(patch = {}) {
  Object.assign(db, { statements: [], version: { questions: 10 }, list: [], details: [], options: [] }, patch);
  bank.clearBankCache();
}

const ran = (part) => db.statements.filter((s) => s.sql.includes(part)).length;

async function main() {
  console.log('\n== 1. the filter bar ==');
  const blank = bank.readBankFilters({});
  ok('nothing chosen: everything, page 1',
    blank.subjectId === 'all' && blank.grade === 'all' && blank.moduleId === 'all' && blank.type === 'all'
      && blank.madeBy === 'all' && blank.status === 'all' && blank.difficulty === 'all' && blank.page === 1 && blank.search === '');
  const odd = bank.readBankFilters({
    subject_id: '5; DROP TABLE users', grade: 'grade 3', module_id: '12', type: 'quiz', made_by: 'TUTOR',
    status: 'open', difficulty: 'impossible', page: '-4', search: `  ${'x'.repeat(150)}  `
  });
  ok('an id that is not a number is "all"', odd.subjectId === 'all' && odd.moduleId === '12');
  ok('a grade is read the way the modules read it', odd.grade === 'Grade 3', odd.grade);
  ok('an unknown type or difficulty is "all"; a known one in any case is kept',
    odd.type === 'all' && odd.difficulty === 'all' && odd.madeBy === 'tutor' && odd.status === 'open');
  ok('a page below 1 is page 1, a search is trimmed and at most 100 letters', odd.page === 1 && odd.search.length === 100);
  ok('a grade that is no grade is "all"', bank.readBankFilters({ grade: 'Grade 15' }).grade === 'all');
  ok('a learning objective is an id or "all"', bank.readBankFilters({ objective_id: '41' }).objectiveId === '41'
    && bank.readBankFilters({ objective_id: 'x' }).objectiveId === 'all' && blank.objectiveId === 'all');

  console.log('\n== 2. who sees what ==');
  ok('the main admin: no limit', bank.scopeFor({ role: 'admin' }).sql === '');
  const assistant = bank.scopeFor({ role: 'assistant', branchId: 3 });
  ok('an assistant: the shared questions and their branch\'s students',
    /ta\.for_student_id IS NULL OR stu\.branch_id = \?/.test(assistant.sql) && assistant.params[0] === 3);
  const tutor = bank.scopeFor({ role: 'tutor', tutorId: 9, subjectIds: [5, 6, 5] });
  ok('a tutor: their subjects, once each, and their own students',
    /ta\.subject_id IN \(\?, \?\)/.test(tutor.sql) && /usa\.tutor_id = \? AND usa\.student_id = ta\.for_student_id/.test(tutor.sql)
      && JSON.stringify(tutor.params) === '[5,6,9]', JSON.stringify(tutor.params));
  ok('a tutor with no subject, or an unknown viewer, sees nothing', bank.scopeFor({ role: 'tutor', tutorId: 9, subjectIds: [] }) === null
    && bank.scopeFor({ role: 'student' }) === null);
  fresh();
  const none = await bank.getQuestionBank({ role: 'tutor', tutorId: 9, subjectIds: [] }, blank);
  ok('…and nothing is asked of the database for them', none.rows.length === 0 && none.pager.total === 0 && db.statements.length === 0);

  console.log('\n== 3. the statement ==');
  const every = {
    ...blank, subjectId: '5', grade: 'Grade 3', moduleId: '12', objectiveId: '41', type: 'pre', madeBy: 'tutor',
    status: 'draft', difficulty: 'hard', search: "o'clock"
  };
  const built = bank.buildBankSql({ role: 'assistant', branchId: 3 }, every);
  ok('every filter is in the statement', ['k.subject_id = ?', 'k.grade_level = ?', 'k.module_id = ?', 'k.objective_id = ?', 'k.type_key = ?',
    'k.status_key = ?', 'k.norm_text LIKE ?', 'g.by_tutor = 1', 'r.difficulty = ?'].every((part) => built.sql.includes(part)));
  ok('…the learning objective as a number', built.params.includes(41));
  ok('…and what was typed is a parameter, not part of the statement', !built.sql.includes("o'clock") && built.params.includes("%o'clock%"));
  ok('the statement and its parameters agree in number, every filter set', placeholders(built.sql) === built.params.length,
    `${placeholders(built.sql)} vs ${built.params.length}`);
  ok('…the viewer\'s limit first, then the filters, in the order they appear',
    built.params[0] === 3 && built.params[built.params.length - 1] === 'hard');
  const plain = bank.buildBankSql({ role: 'admin' }, blank);
  ok('…and with no filter at all', placeholders(plain.sql) === 0 && plain.params.length === 0);
  const tutorBuilt = bank.buildBankSql({ role: 'tutor', tutorId: 9, subjectIds: [5, 6] }, { ...blank, difficulty: 'easy', subjectId: '5' });
  ok('…and for a tutor with a subject and a difficulty', placeholders(tutorBuilt.sql) === tutorBuilt.params.length
    && tutorBuilt.params[tutorBuilt.params.length - 1] === 'easy');
  ok('an archived assessment is never listed', plain.sql.includes('WHERE k.is_archived = 0'));
  ok('…though a retired master still says which copies are the AI\'s',
    plain.sql.includes("ta.is_archived = 0 OR (ta.assessment_kind = 'pre_assessment' AND ta.for_student_id IS NULL)")
      && plain.sql.includes('MAX(b.is_master) OVER (PARTITION BY b.subject_id, b.group_key)'));
  ok('copies are grouped by subject, question and the answer\'s words — never by the long words themselves',
    /GROUP BY b\.subject_id, b\.group_key/.test(plain.sql) && plain.sql.includes('COALESCE(ko.option_text, q.correct_answer)')
      && plain.sql.includes("HASHBYTES('SHA2_256'"));
  ok('answers from submissions and from module takes both count',
    plain.sql.includes('FROM tutor_student_answers') && plain.sql.includes('FROM tutor_assessment_attempt_answers'));
  ok('the list is read whole, to be paged in memory', !bank.LIST_SELECT.includes('OFFSET'));

  console.log('\n== 4. item analysis ==');
  ok('80% right is Easy, 79% Average', bank.difficultyOf(8, 10) === 'easy' && bank.difficultyOf(79, 100) === 'average');
  ok('20% right is Hard, 21% Average', bank.difficultyOf(2, 10) === 'hard' && bank.difficultyOf(21, 100) === 'average');
  ok('no answer yet: no difficulty', bank.difficultyOf(0, 0) === null);

  console.log('\n== 5. what a row says ==');
  ok('used in: the master and the students who have it', bank.usedInLabel({ masters: 1, shared_uses: 0, students: 25 }) === 'Master + 25 students');
  ok('…one student', bank.usedInLabel({ masters: 0, shared_uses: 0, students: 1 }) === '1 student');
  ok('…a shared activity', bank.usedInLabel({ masters: 0, shared_uses: 2, students: 0 }) === 'Shared');
  const mcDetail = {
    question_text: 'Which fraction is one half?', question_type: 'multiple_choice', correct_answer: 'B', assessment_id: 990,
    subject_name: 'MATHEMATICS', module_order: 1, module_title: 'Fractions', handout_name: 'Fractions.pdf', is_published: 0, has_check_page: 1,
    options: [{ option_label: 'A', option_text: '1/3' }, { option_label: 'B', option_text: '1/2' }]
  };
  const group = {
    sample_id: 1, subject_id: 5, uses: 1, students: 1, masters: 0, shared_uses: 0,
    in_pre: 1, in_post: 0, in_module: 0, in_activity: 0, by_ai: 0, by_tutor: 1, drafts: 1, answered: 0, correct: 0, difficulty: 'none'
  };
  const tutorRow = bank.shapeRow(group, mcDetail, { linkBase: '/tutor', canEdit: true });
  ok('the answer in words, the key marked among the choices',
    tutorRow.answer === 'B. 1/2' && tutorRow.choices.find((c) => c.label === 'B').isKey && !tutorRow.choices.find((c) => c.label === 'A').isKey);
  ok('its subject, module and handout', tutorRow.subjectName === 'MATHEMATICS' && tutorRow.moduleLabel === 'Module 1: Fractions'
    && tutorRow.handoutName === 'Fractions.pdf');
  ok('the learning objective it measures, when it has one', tutorRow.objective === ''
    && bank.shapeRow(group, { ...mcDetail, objective_text: 'Identify one half' }, {}).objective === 'Identify one half');
  ok('its type and who made it', tutorRow.types.join() === 'Pre-Assessment' && tutorRow.madeBy.join() === 'Tutor');
  ok('one student\'s draft: Edit, to its own page', !!tutorRow.link && tutorRow.link.label === 'Edit'
    && tutorRow.link.href === '/tutor/path-assessments/990/edit');
  const assistantRow = bank.shapeRow(group, mcDetail, { linkBase: '/assistant', canEdit: false });
  ok('…View for someone who may not edit it', assistantRow.link.label === 'View' && assistantRow.link.href.startsWith('/assistant/'));
  const openRow = bank.shapeRow(group, { ...mcDetail, is_published: 1 }, { linkBase: '/admin', canEdit: true });
  ok('…View once it is open', openRow.link.label === 'View');
  const shared = bank.shapeRow({ ...group, uses: 26, students: 25, masters: 1 }, mcDetail, { linkBase: '/admin', canEdit: true });
  ok('a question in many assessments has no single page to open', shared.link === null && shared.usedIn === 'Master + 25 students');
  const activity = bank.shapeRow(group, { ...mcDetail, has_check_page: 0 }, { linkBase: '/admin', canEdit: true });
  ok('…nor does one in an assessment without a check page', activity.link === null);
  ok('True or False reads as True / False', bank.answerText({ question_type: 'true_false', correct_answer: 'true' }) === 'True');
  const answeredRow = bank.shapeRow({ ...group, answered: 25, correct: 4 }, mcDetail, {});
  ok('% correct to one decimal, with its difficulty', answeredRow.percent === 16 && answeredRow.difficulty === 'hard'
    && answeredRow.difficultyLabel === 'Hard');

  console.log('\n== 6. the list, worked out once and paged in memory ==');
  const difficulties = [...Array(10).fill('easy'), ...Array(15).fill('average'), ...Array(5).fill('hard'), ...Array(30).fill('none')];
  const list = difficulties.map((difficulty, i) => ({ ...group, sample_id: 100 + i, difficulty, group_key: Buffer.from([i]) }));
  const details = list.map((row) => ({ ...mcDetail, id: row.sample_id, question_text: `Question ${row.sample_id}` }));
  fresh({ list, details, options: [] });
  const page = await bank.getQuestionBank({ role: 'admin' }, { ...blank, page: 9 }, { linkBase: '/admin', canEdit: true });
  ok('the counts for the strip above the list', page.summary.total === 60 && page.summary.answered === 30
    && page.summary.easy === 10 && page.summary.average === 15 && page.summary.hard === 5, JSON.stringify(page.summary));
  ok('a page past the end is the last page', page.pager.page === 3 && page.pager.pageCount === 3 && page.pager.total === 60);
  ok('…holding the last ten questions, each in full', page.rows.length === 10 && page.rows[0].text === 'Question 150'
    && page.rows[9].text === 'Question 159');
  const detailQuery = db.statements.find((s) => s.sql.startsWith('SELECT q.id, q.question_text'));
  ok('only the page\'s own questions are fetched in full', !!detailQuery && detailQuery.params.length === 10);
  ok('the list is worked out once', ran('SELECT l.* FROM listed l') === 1 && ran(VERSION_SQL) === 1);

  db.statements = [];
  const next = await bank.getQuestionBank({ role: 'admin' }, { ...blank, page: 2 }, { linkBase: '/admin', canEdit: true });
  ok('turning the page soon after asks nothing heavy, not even whether anything changed',
    next.rows[0].text === 'Question 125' && ran('SELECT l.* FROM listed l') === 0 && ran(VERSION_SQL) === 0);

  for (const entry of bank._listCache.values()) entry.usedAt -= bank.LIST_FRESH_MS + 1;
  db.statements = [];
  await bank.getQuestionBank({ role: 'admin' }, { ...blank, page: 1 }, {});
  ok('later: one light question, and nothing changed — the kept list is used', ran(VERSION_SQL) === 1 && ran('SELECT l.* FROM listed l') === 0);

  for (const entry of bank._listCache.values()) entry.usedAt -= bank.LIST_FRESH_MS + 1;
  db.version = { questions: 11 };
  db.statements = [];
  await bank.getQuestionBank({ role: 'admin' }, { ...blank, page: 1 }, {});
  ok('…and something changed — the list is worked out again', ran(VERSION_SQL) === 1 && ran('SELECT l.* FROM listed l') === 1);

  db.statements = [];
  await bank.getQuestionBank({ role: 'admin' }, { ...blank, type: 'pre' }, {});
  ok('other filters are another list of their own', ran('SELECT l.* FROM listed l') === 1);
  db.statements = [];
  await bank.getQuestionBank({ role: 'assistant', branchId: 3 }, blank, {});
  ok('…and so is another viewer\'s', ran('SELECT l.* FROM listed l') === 1);

  fresh({ list: [] });
  const emptyBank = await bank.getQuestionBank({ role: 'admin' }, blank);
  ok('an empty bank fetches no question', emptyBank.rows.length === 0 && emptyBank.pager.total === 0
    && !db.statements.some((s) => s.sql.startsWith('SELECT q.id')));

  console.log('\n== 7. the page renders ==');
  fresh({ list, details, options: [{ question_id: 150, option_label: 'A', option_text: '1/3' }, { question_id: 150, option_label: 'B', option_text: '1/2' }] });
  const shown = await bank.getQuestionBank({ role: 'admin' }, { ...blank, subjectId: '5', page: 3 }, { linkBase: '/admin', canEdit: true });
  const ejs = require('ejs');
  const { icon } = require('../lib/icons');
  const view = path.join(__dirname, '..', 'views', 'content', 'question-bank.ejs');
  const html = ejs.render(fs.readFileSync(view, 'utf8'), {
    ...shown,
    filters: { ...blank, subjectId: '5' },
    bankQuery: { subject_id: '5', page: '3' },
    subjectOptions: [{ id: 5, name: 'MATHEMATICS' }],
    moduleOptions: [{ id: 11, label: 'Module 1: Fractions' }],
    gradeOptions: ['Grade 3'],
    bankPath: '/admin/question-bank',
    icon
  }, { filename: view });
  const flat = html.replace(/\s+/g, ' ');
  ok('the filter bar, with the subject\'s modules', html.includes('name="module_id"') && html.includes('Module 1: Fractions')
    && html.includes('<option value="5" selected>MATHEMATICS</option>'));
  ok('the counts', flat.includes('<span>Questions</span><strong>60</strong>') && flat.includes('<span>Hard</span><strong>5</strong>'));
  ok('a row, its choices and its link', html.includes('Question 150') && html.includes('Choices') && html.includes('/admin/path-assessments/990/edit'));
  ok('the pager keeps the filters', html.includes('subject_id=5&amp;page=2') || html.includes('subject_id=5&page=2'));
  const noModules = ejs.render(fs.readFileSync(view, 'utf8'), {
    rows: [], pager: { page: 1, pageCount: 1, total: 0, pageSize: 25 }, summary: { total: 0, answered: 0, easy: 0, average: 0, hard: 0 },
    filters: blank, bankQuery: {}, subjectOptions: [], moduleOptions: [], gradeOptions: [], bankPath: '/tutor/question-bank', icon
  }, { filename: view });
  ok('no subject chosen: no module filter, and an empty list says so', !noModules.includes('name="module_id"') && noModules.includes('No questions yet'));

  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'The Question Bank holds: every viewer their own questions, one row per question, each filter a parameter, item analysis by the rule, the list worked out once.'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
