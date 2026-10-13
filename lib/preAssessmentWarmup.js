/**
 * File: lib/preAssessmentWarmup.js
 * Purpose: Build a grade's Pre-Assessment as soon as its handouts change, so the
 *          first student to open the subject finds it already waiting.
 *
 * Before this, generation was triggered by the student's click and took ~18s for
 * three handouts. It was cached afterwards, so exactly one student per handout
 * version paid the wait — but that student was a child sitting in front of a
 * spinner. The work is the same; this moves it to the moment the admin uploads,
 * when nobody is waiting on it.
 *
 * A Pre-Assessment belongs to one subject AND one grade (Grade 3 Mathematics is
 * written from Grade 3's handouts only), so everything here is keyed by both:
 * a handout uploaded to a Grade 6 module rebuilds Grade 6's assessment and
 * leaves Grade 3's alone.
 *
 * Two things make this safe to fire and forget:
 *
 *   - It is debounced per subject and grade. Uploading five handouts one at a
 *     time would otherwise pay for five generations; the timer restarts on each
 *     change and only the last one runs.
 *   - getOrCreatePreAssessment is already single-flight in process and guarded by
 *     a unique index per subject and grade in the database. If a student arrives
 *     mid-generation they join the same work rather than starting a second copy.
 *
 * Nothing here throws into a request. A failed warm-up costs nothing: the student
 * path still generates on demand exactly as it did before.
 */

const { canonicalGrade } = require('./moduleGrades');

const DEFAULT_DELAY_MS = 12000;

// "subjectId|grade" -> { timer, state, reason, error, at }
const warmups = new Map();

function keyOf(subjectId, gradeLevel) {
  return `${Number(subjectId)}|${canonicalGrade(gradeLevel)}`;
}

function setState(key, patch) {
  const current = warmups.get(key) || {};
  warmups.set(key, { ...current, ...patch, at: new Date() });
}

/**
 * What the admin UI should say about one grade's build right now.
 *
 * Only the transient part lives in memory — whether a build is queued or running,
 * and why the last one stopped. Whether an assessment actually exists for the
 * current handouts is a database question, and the caller asks it there.
 */
function getWarmupState(subjectId, gradeLevel) {
  const entry = warmups.get(keyOf(subjectId, gradeLevel));
  if (!entry) return { status: 'idle' };
  return {
    status: entry.state || 'idle',
    reason: entry.reason || null,
    error: entry.error || null,
    at: entry.at || null
  };
}

/**
 * Queue a Pre-Assessment build for one grade of a subject whose handouts just
 * changed.
 *
 * @param {number} subjectId
 * @param {string} gradeLevel  the grade of the module that changed
 * @param {string} reason      short label for the log — "handouts uploaded", etc.
 * @param {object} [options]
 * @param {number} [options.delayMs]  debounce window; 0 runs on the next tick
 * @returns {Promise|null} the work, for tests that need to await it
 */
function schedulePreAssessmentWarmup(subjectId, gradeLevel, reason = 'handouts changed', options = {}) {
  const grade = canonicalGrade(gradeLevel);
  if (!Number(subjectId) || !grade) return null;
  const key = keyOf(subjectId, grade);

  const delayMs = options.delayMs === undefined ? DEFAULT_DELAY_MS : Number(options.delayMs);
  const existing = warmups.get(key);
  if (existing && existing.timer) clearTimeout(existing.timer);

  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });

  const timer = setTimeout(() => { run(key, Number(subjectId), grade, reason).then(resolveDone); }, delayMs);
  // A pending warm-up must never hold the process open — this matters for the
  // test suites and for any script that requires lib/data.
  if (typeof timer.unref === 'function') timer.unref();

  setState(key, { timer, state: 'queued', reason, error: null });
  return done;
}

async function run(key, subjectId, grade, reason) {
  setState(key, { timer: null, state: 'generating', reason, error: null });
  const started = Date.now();
  try {
    // Required lazily: lib/data pulls in the whole data layer, and requiring it at
    // module load would make this file and data.js a require cycle.
    const { getOrCreatePreAssessment } = require('./data');
    const result = await getOrCreatePreAssessment(subjectId, grade);
    const items = (result.assessment.questions || []).length;
    setState(key, { state: 'ready', error: null });
    console.log(
      `[pre-assessment warmup] subject ${subjectId} ${grade}: ${result.generated ? 'generated' : 'reused'} `
      + `${items} item(s) in ${Date.now() - started}ms (${reason})`
    );
    return { ok: true, generated: result.generated, items };
  } catch (error) {
    // "No readable handout yet" is the normal state right after a scanned PDF is
    // uploaded, or when a grade's last module is removed — not a failure worth
    // alarming anyone about. It is reported as "waiting" so the UI can explain.
    const waiting = /no .*module with a readable handout|no handouts with readable text/i.test(error.message || '');
    setState(key, {
      state: waiting ? 'waiting' : 'error',
      error: error.message || String(error)
    });
    console.log(
      `[pre-assessment warmup] subject ${subjectId} ${grade}: ${waiting ? 'waiting' : 'FAILED'} — ${error.message}`
    );
    return { ok: false, error: error.message };
  }
}

/**
 * At boot: queue a build for every subject and grade whose handouts have no
 * current Pre-Assessment — after this release every grade needs its own, and
 * nothing else would build one until a handout changed or a student waited
 * for it. One that is current is left alone, so a normal restart costs nothing.
 * Staggered, so the AI calls do not all go out at once.
 *
 * @returns {Promise<Array<{subjectId:number, gradeLevel:string}>>} what was queued
 */
async function warmMissingPreAssessments({ spacingMs = 20000 } = {}) {
  const { getPreAssessmentStatus, getSubjectHandoutTexts, getSubjects } = require('./data');
  const queued = [];
  const subjects = await getSubjects(false);
  for (const subject of subjects) {
    const handouts = await getSubjectHandoutTexts(subject.id);
    const grades = [...new Set(handouts.map((h) => h.grade_level).filter(Boolean))];
    for (const grade of grades) {
      const status = await getPreAssessmentStatus(subject.id, grade);
      if (status.exists && !status.stale) continue;
      schedulePreAssessmentWarmup(subject.id, grade, 'built at boot', { delayMs: 5000 + queued.length * spacingMs });
      queued.push({ subjectId: Number(subject.id), gradeLevel: grade });
    }
  }
  return queued;
}

module.exports = {
  schedulePreAssessmentWarmup,
  warmMissingPreAssessments,
  getWarmupState,
  DEFAULT_DELAY_MS
};
