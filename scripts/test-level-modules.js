/**
 * File: scripts/test-level-modules.js
 * Purpose: Pin down level modules (lib/levelModules.js) — each module written
 *          again for the level a student reached in the Pre-Assessment — and the
 *          Level filter of Learner performance.
 *
 * Run:  node scripts/test-level-modules.js       (needs no database, no keys)
 *
 * WHAT MUST HOLD
 *   1. A student meets only their own level's activities: an Advance activity is
 *      neither shown to nor owed by a Beginner, and an activity written before
 *      level modules is everyone's.
 *   2. The level is the Pre-Assessment's — of the student's own grade, the
 *      latest sitting — not whatever the last activity scored.
 *   3. Writing a level module never runs twice at once, records why it failed,
 *      gives up after MAX_ATTEMPTS until the admin asks again, and keeps the
 *      parts it did write when one handout fails.
 *   4. A student whose month is over gets no new level module.
 *   5. The lesson prompt carries the level and only the handout's text; the
 *      question prompt carries the level when one is given and nothing new when
 *      not; what comes back is cleaned of markdown.
 *   6. Learner performance filters by level with its parameters bound in the
 *      order the statement reads them.
 *
 * `config/db` is replaced in the require cache before anything loads it, and
 * `fetch` is replaced before services/aiService.js loads, so the real functions
 * run against a scripted database and a local stand-in for the AI. Nothing dials
 * out, and no credits are spent.
 */
process.env.AI_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key-0000000000000000';

let failures = 0;
const ok = (label, condition, extra = '') => {
  if (condition) console.log(`  PASS  ${label}${extra ? ' — ' + extra : ''}`);
  else { failures++; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
};

// --- the scripted database ------------------------------------------------
const db = {
  user: { id: 5, role: 'student', grade_level: 'Grade 4', year_level: 'Primary Level' },
  enrolment: null,
  pre: null,                      // hasCompletedPreAssessment's answer
  placements: [],                 // getPlacementLevels' rows
  modules: [],                    // getSubjectModules' rows
  live: new Map(),                // getModuleById: id -> module
  handoutTexts: new Map(),        // getModuleHandoutTexts: module id -> rows
  activities: [],                 // the completion query's rows
  levelModules: [],
  sections: [],
  logs: [],
  perf: null,                     // the Learner performance statement, as sent
  nextId: 100
};

function answer(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();

  // ---- level_modules ----
  if (sql.startsWith("UPDATE level_modules SET status = 'generating'")) {
    const row = db.levelModules.find((r) => r.id === Number(params[0]));
    if (!row) return [];
    const force = sql.includes("status IN ('pending', 'failed', 'ready')");
    const open = force
      ? ['pending', 'failed', 'ready'].includes(row.status)
      : row.status === 'pending' || (row.status === 'failed' && row.attempts < 3);
    if (!open && !(row.status === 'generating' && row.stale)) return [];
    row.status = 'generating';
    row.attempts += 1;
    return [{ id: row.id }];
  }
  if (sql.startsWith("UPDATE level_modules SET status = 'ready'")) {
    const row = db.levelModules.find((r) => r.id === Number(params[3]));
    Object.assign(row, { status: 'ready', title: params[0], source_fingerprint: params[1], error_message: params[2] });
    return [];
  }
  if (sql.startsWith("UPDATE level_modules SET status = 'failed'")) {
    const row = db.levelModules.find((r) => r.id === Number(params[1]));
    if (row) Object.assign(row, { status: 'failed', error_message: params[0] });
    return [];
  }
  if (sql.startsWith('SELECT * FROM level_modules WHERE id = ?')) {
    return db.levelModules.filter((r) => r.id === Number(params[0]));
  }
  if (sql.startsWith('SELECT * FROM level_modules WHERE source_module_id = ? AND level = ?')) {
    return db.levelModules.filter((r) => r.source_module_id === Number(params[0]) && r.level === params[1]);
  }
  if (sql.startsWith('INSERT INTO level_modules')) {
    const row = {
      id: db.nextId++, source_module_id: Number(params[0]), level: params[1], status: 'pending',
      attempts: 0, created_at: new Date(), updated_at: new Date()
    };
    db.levelModules.push(row);
    return { insertId: row.id };
  }
  if (sql.startsWith('SELECT lm.id, lm.source_module_id, lm.level')) {
    const ids = params.map(Number);
    return db.levelModules.filter((r) => ids.includes(r.source_module_id)).map((r) => ({ ...r, section_count: 0, assessment_count: 0 }));
  }
  if (sql.startsWith('DELETE FROM level_module_sections')) {
    db.sections = db.sections.filter((s) => s.level_module_id !== Number(params[0]));
    return [];
  }
  if (sql.startsWith('INSERT INTO level_module_sections')) {
    db.sections.push({ level_module_id: params[0], source_handout_id: params[1], order_number: params[2], title: params[3], content_text: params[4] });
    return { insertId: db.nextId++ };
  }
  if (sql.startsWith('SELECT id, level_module_id, source_handout_id, order_number, title, content_text FROM level_module_sections')) {
    return db.sections.filter((s) => s.level_module_id === Number(params[0]));
  }
  if (sql.startsWith('INSERT INTO ai_generation_logs')) {
    db.logs.push(params);
    return { insertId: db.logs.length };
  }

  // ---- what lib/data.js reads ----
  if (sql.startsWith('SELECT m.*, s.name AS subject_name, s.handout_version')) {
    const mod = db.live.get(Number(params[0]));
    return mod ? [mod] : [];
  }
  if (sql.startsWith('SELECT h.id AS handout_id, h.file_original_name, h.extracted_text')) {
    return db.handoutTexts.get(Number(params[0])) || [];
  }
  if (sql.startsWith('SELECT sub.student_id, sub.level, ta.grade_level, sub.submitted_at')) return db.placements;
  if (sql.startsWith('SELECT TOP 1 sub.id, sub.percentage, sub.level')) return db.pre ? [db.pre] : [];
  if (sql.startsWith('SELECT TOP 1 u.*, b.name AS branch_name')) return [db.user];
  if (sql.startsWith('SELECT TOP 1 id, CONVERT(varchar(10), start_date, 23)')) return db.enrolment ? [db.enrolment] : [];
  if (sql.startsWith('SELECT m.*, s.name AS subject_name,')) return db.modules;
  if (sql.startsWith('SELECT h.*, u.first_name, u.last_name FROM module_handouts h')) return [];
  if (sql.startsWith('SELECT COUNT(*) AS c FROM student_module_reads')) return [{ c: 0 }];
  if (sql.startsWith('SELECT ta.id, ta.title, ta.module_id, ta.created_at, ta.level_module_id')) return db.activities;
  if (sql.includes("ta.assessment_kind = 'post_assessment'")) return [];

  // ---- Learner performance ----
  if (sql.includes('FROM users u') && sql.includes('OUTER APPLY') && sql.includes('student_subject_levels ssl')) {
    db.perf = { sql, params };
    return [];
  }
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

// --- the AI, answered locally ----------------------------------------------
const sent = [];
let lessonReply = () => ({ title: 'Fractions, step by step', lesson: '## What a fraction is\n**A fraction** is part of a whole.\n\n* one\n* two\n\n'.padEnd(320, 'x') });
global.fetch = (url, options) => {
  const body = JSON.parse(options.body);
  const system = body.messages[0].content;
  sent.push({ url, system, user: body.messages[1].content });
  const isKeyCheck = /You check the answer key/.test(system);
  const payload = /one lesson of a learning module/.test(system) ? lessonReply(body) : isKeyCheck ? { no: 'verdicts' } : { questions: [] };
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(payload) } }], usage: { total_tokens: 50 } })
  });
};

const levels = require('../lib/levelModules');
const data = require('../lib/data');
const ai = require('../services/aiService');
const { readAnalyticsFilters, tabForms } = require('../lib/analyticsFilters');
const { getStudentPerformance } = require('../lib/analytics');

const handout = (id, text = 'A fraction has a numerator above the line and a denominator below it. '.repeat(3)) => ({
  handout_id: id, file_original_name: `part-${id}.pdf`, extracted_text: text,
  module_id: 7, order_number: 1, module_title: 'Fractions'
});
const sourceModule = { id: 7, subject_id: 3, subject_name: 'MATHEMATICS', order_number: 1, title: 'Fractions', grade_level: 'Grade 4', target_year_levels_json: '["Grade 4"]', is_archived: 0, created_at: new Date('2026-10-01T00:00:00Z') };

async function main() {
  // ---------------------------------------------------------------------------
  console.log('\n== levels, placement and which activities are whose ==');
  ok('"Advanced" (old spelling) reads as Advance', levels.normalizeLevel('Advanced') === 'Advance');
  ok('an unknown level is null', levels.normalizeLevel('Expert') === null);
  ok('an activity outside any level module is every level\'s',
    levels.activityMatchesLevel({ level_module_id: null }, 'Beginner') && levels.activityMatchesLevel({ level_module_id: null }, null));
  ok('a Beginner activity is a Beginner\'s', levels.activityMatchesLevel({ level_module_id: 11, level_module_level: 'Beginner' }, 'Beginner'));
  ok('an Advance activity is not a Beginner\'s', !levels.activityMatchesLevel({ level_module_id: 12, level_module_level: 'Advance' }, 'Beginner'));
  ok('a level activity is nobody\'s without a placement', !levels.activityMatchesLevel({ level_module_id: 11, level_module_level: 'Beginner' }, null));

  db.placements = [
    { student_id: 5, level: 'Advance', grade_level: 'Grade 5', submitted_at: new Date('2026-10-20') },
    { student_id: 5, level: 'Beginner', grade_level: 'Grade 4', submitted_at: new Date('2026-10-10') },
    { student_id: 6, level: 'Intermediate', grade_level: null, submitted_at: new Date('2026-09-01') },
    { student_id: 7, level: 'Advanced', grade_level: 'Grade 4', submitted_at: new Date('2026-10-02') }
  ];
  const placed = await levels.getPlacementLevels(3, [
    { id: 5, grade_level: 'Grade 4' }, { id: 6, grade_level: 'Grade 4' }, { id: 7, grade_level: 'Grade 4' }, { id: 8, grade_level: 'Grade 4' }
  ]);
  ok('the Pre-Assessment of the student\'s own grade decides, not a later one of another grade', placed.get(5) === 'Beginner', placed.get(5));
  ok('a grade-less Pre-Assessment from before they were per grade still counts', placed.get(6) === 'Intermediate');
  ok('"Advanced" in a submission places the student at Advance', placed.get(7) === 'Advance');
  ok('a student who never sat it has no placement', !placed.has(8));

  // ---------------------------------------------------------------------------
  console.log('\n== a student owes only their own level\'s activities ==');
  db.enrolment = { id: 1, start_date: '2026-10-01', end_date: '2099-01-01', enrolled_at: new Date('2026-10-01'), created_at: new Date('2026-10-01') };
  db.modules = [sourceModule];
  db.pre = { id: 99, percentage: 40, level: 'Beginner', grade_level: 'Grade 4', submitted_at: new Date('2026-10-02') };
  db.activities = [
    { id: 1, title: 'Written before level modules', module_id: 7, created_at: new Date('2026-10-03'), level_module_id: null, level_module_level: null, submitted: 0 },
    { id: 2, title: 'Beginner activity', module_id: 7, created_at: new Date('2026-10-04'), level_module_id: 11, level_module_level: 'Beginner', submitted: 1 },
    { id: 3, title: 'Advance activity', module_id: 7, created_at: new Date('2026-10-05'), level_module_id: 12, level_module_level: 'Advance', submitted: 0 }
  ];
  const completion = await data.getStudentSubjectCompletion(5, 3);
  const titles = completion.pendingAssessments.map((a) => a.title);
  ok('the Beginner owes the activity every level has', titles.includes('Written before level modules'));
  ok('the Beginner\'s own activity counts (answered)', completion.assessmentsTotal === 2 && completion.assessmentsDone === 1,
    `${completion.assessmentsDone} of ${completion.assessmentsTotal}`);
  ok('the Advance activity is not owed by a Beginner', !titles.includes('Advance activity'));

  // ---------------------------------------------------------------------------
  console.log('\n== writing a level module ==');
  db.live.set(7, sourceModule);
  db.handoutTexts.set(7, [handout(31), handout(32)]);
  const made = await levels.ensureLevelModule(7, 'Beginner');
  ok('a missing level module is made, pending', made && made.status === 'pending' && made.level === 'Beginner');
  const again = await levels.ensureLevelModule(7, 'beginner');
  ok('asking again returns the same one', again.id === made.id && db.levelModules.length === 1);

  const first = levels.queueLevelModule(made.id);
  const second = levels.queueLevelModule(made.id);
  ok('two requests for the same level module share one job', first === second);
  const result = await first;
  const row = db.levelModules.find((r) => r.id === made.id);
  ok('it is written: ready, one part per handout', result.ok && row.status === 'ready' && db.sections.length === 2,
    `${row.status}, ${db.sections.length} parts`);
  ok('each part keeps the handout it was written from', db.sections.map((s) => s.source_handout_id).join(',') === '31,32');
  ok('the parts are cleaned of markdown', db.sections.every((s) => !s.content_text.includes('**') && s.content_text.includes('- one')));
  ok('the fingerprint of its handouts is stored', row.source_fingerprint === levels.sourceFingerprint([handout(31), handout(32)]));
  ok('the writing is logged', db.logs.length === 1 && db.logs[0][0] === 'level_module');
  const lessonCalls = sent.filter((s) => /one lesson of a learning module/.test(s.system));
  ok('one AI call per handout', lessonCalls.length === 2);
  ok('the lesson prompt is the Beginner one', lessonCalls.every((s) => /BEGINNER/.test(s.system) && /Level: Beginner/.test(s.user)));
  ok('the lesson prompt carries only that handout\'s text', lessonCalls[0].user.includes('part-31.pdf') && !lessonCalls[0].user.includes('part-32.pdf'));
  ok('a ready level module is not written again unasked', (await levels.generateLevelModule(made.id)).skipped === true);

  // A changed handout makes it stale; the admin's "Write Again" forces it.
  db.handoutTexts.set(7, [handout(31, 'A fraction is a part of a whole, written as one number over another. '.repeat(3)), handout(32)]);
  const detail = await levels.withStaleFlag({ ...row });
  ok('changed handouts flag it as stale', detail.is_stale === true);
  ok('"Write Again" (force) writes a ready one again', (await levels.generateLevelModule(made.id, { force: true })).ok === true);

  // One handout fails: the other part is kept, and the admin is told.
  let call = 0;
  lessonReply = () => (++call === 1 ? { title: 'Short', lesson: 'too short' } : { title: 'Fine', lesson: 'x'.repeat(300) });
  const partial = await levels.generateLevelModule(made.id, { force: true });
  const afterPartial = db.levelModules.find((r) => r.id === made.id);
  ok('a part that fails does not throw away the part that was written',
    partial.ok && db.sections.filter((s) => s.level_module_id === made.id).length === 1 && afterPartial.status === 'ready');
  ok('...and the admin is told which failed', /1 of 2 parts could not be written/.test(afterPartial.error_message || ''));

  // Nothing readable: failed, with the reason; retried, then left for the admin.
  const advance = await levels.ensureLevelModule(7, 'Advance');
  db.handoutTexts.set(7, []);
  await levels.generateLevelModule(advance.id);
  const failedRow = db.levelModules.find((r) => r.id === advance.id);
  ok('a module with no readable handout fails with the reason', failedRow.status === 'failed' && /no handout with readable text/.test(failedRow.error_message));
  ok('a failed one is tried again on the next visit', levels.wantsBuild(failedRow));
  await levels.generateLevelModule(advance.id);
  await levels.generateLevelModule(advance.id);
  ok(`after ${levels.MAX_ATTEMPTS} tries it waits for the admin`, failedRow.attempts === levels.MAX_ATTEMPTS && !levels.wantsBuild(failedRow)
    && (await levels.generateLevelModule(advance.id)).skipped === true);
  db.live.delete(7);
  const gone = await levels.generateLevelModule(advance.id, { force: true });
  ok('a removed module fails with that reason', !gone.ok && /has been removed/.test(failedRow.error_message));
  ok('a removed module takes its level module out of sight', (await levels.getLevelModuleDetail(made.id)) === null);
  db.live.set(7, sourceModule);
  db.handoutTexts.set(7, [handout(31)]);

  // ---------------------------------------------------------------------------
  console.log('\n== a student\'s level modules ==');
  db.levelModules = [];
  db.pre = { id: 99, level: 'Intermediate', grade_level: 'Grade 4' };
  const entries = await levels.prepareStudentLevelModules(5, 3, { queue: false });
  ok('their placement level\'s module is made for every module they see',
    entries.length === 1 && entries[0].levelModule && entries[0].levelModule.level === 'Intermediate');
  ok('no other level is made for them', db.levelModules.length === 1);

  // Their month ran 1 August to 1 September; the module was added inside it.
  db.levelModules = [];
  db.modules = [{ ...sourceModule, created_at: new Date('2026-08-05T00:00:00Z') }];
  db.enrolment = { id: 1, start_date: '2026-08-01', end_date: '2026-09-01', enrolled_at: new Date('2026-08-01'), created_at: new Date('2026-08-01') };
  const ended = await levels.prepareStudentLevelModules(5, 3, { queue: false });
  ok('a student whose month is over keeps the module, with no new level module made for it',
    ended.length === 1 && ended[0].levelModule === null && db.levelModules.length === 0);
  // A level module made after their month ended is not theirs either.
  db.levelModules = [{ id: 300, source_module_id: 7, level: 'Intermediate', status: 'ready', attempts: 1, created_at: new Date('2026-10-20T00:00:00Z') }];
  const late = await levels.prepareStudentLevelModules(5, 3, { queue: false });
  ok('a level module made after their month ended is not shown to them', late.length === 1 && late[0].levelModule === null);
  db.modules = [sourceModule];
  db.levelModules = [];
  db.enrolment = { id: 1, start_date: '2026-10-01', end_date: '2099-01-01', enrolled_at: new Date('2026-10-01'), created_at: new Date('2026-10-01') };

  db.pre = null;
  ok('before the Pre-Assessment nothing is made', (await levels.prepareStudentLevelModules(5, 3, { queue: false })).length === 0);

  // ---------------------------------------------------------------------------
  console.log('\n== the prompts ==');
  sent.length = 0;
  await ai.generateAssessmentFromHandouts({ handouts: [handout(31)], subject: 'MATHEMATICS', itemCount: 4, level: 'Advance' }).catch(() => {});
  const advanceAsk = sent.find((s) => /You write assessment questions/.test(s.system));
  ok('a level module\'s draft asks for that level\'s questions', advanceAsk && /ADVANCE level/.test(advanceAsk.system) && /Learner level: Advance/.test(advanceAsk.user));
  sent.length = 0;
  await ai.generateAssessmentFromHandouts({ handouts: [handout(31)], subject: 'MATHEMATICS', itemCount: 4 }).catch(() => {});
  const plainAsk = sent.find((s) => /You write assessment questions/.test(s.system));
  ok('without a level the question prompt is as it was', plainAsk && !/Pitch every question/.test(plainAsk.system) && !/Learner level/.test(plainAsk.user));
  ok('an unknown level is refused before any call', await ai.generateLevelLesson({ handout: handout(31), level: 'Expert' }).then(() => false, () => true));
  ok('cleaning turns markdown into the lesson\'s marks', ai.cleanLessonText('### Title\n**bold** and `code`\n* item') === '## Title\nbold and code\n- item');

  // ---------------------------------------------------------------------------
  console.log('\n== Learner performance: the Level filter ==');
  const asAdmin = readAnalyticsFilters({ perf_level: 'Beginner' }, { role: 'admin' });
  ok('an admin\'s Level is read', asAdmin.perf.level === 'Beginner');
  ok('a made-up level falls back to all', readAnalyticsFilters({ perf_level: 'Expert' }, { role: 'admin' }).perf.level === 'all');
  ok('a tutor has the Level field too', tabForms(readAnalyticsFilters({}, { role: 'tutor' }), 'tutor').perf.fields.includes('level'));
  ok('an assistant has the Level field too', tabForms(readAnalyticsFilters({}, { role: 'admin_assistant' }), 'admin_assistant').perf.fields.includes('level'));
  ok('a student has no Learner performance filter', !(tabForms(readAnalyticsFilters({}, { role: 'student' }), 'student').perf.fields || []).length);

  await getStudentPerformance({ isTutor: true, userId: 42, role: 'tutor' }, { subjectId: 3, level: 'Advance', search: 'ana' });
  const { sql, params } = db.perf;
  const marks = (sql.match(/\?/g) || []).length;
  ok('every placeholder has a value', marks === params.length, `${marks} marks, ${params.length} values`);
  const at = (needle) => sql.slice(0, sql.indexOf(needle)).split('?').length - 1;
  ok('the subject is bound where the level is looked up', params[at('ssl.subject_id = ?')] === 3);
  ok('the level is bound to the level condition', params[at("ELSE lvl.level END) = ?")] === 'Advance');
  ok('the tutor scope of the level lookup is the tutor', params[at('mq_scope_subject.subject_id = ssl.subject_id')] === 42
    || params.filter((p) => p === 42).length >= 2);

  console.log(failures ? `\n${failures} check(s) FAILED.` : '\nLevel modules and the Level filter hold.');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error('Test crashed:', error);
  process.exit(1);
});
