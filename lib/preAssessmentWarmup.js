/**
 * File: lib/preAssessmentWarmup.js
 * Purpose: Build a subject's Pre-Assessment as soon as its handouts change, so the
 *          first student to open the subject finds it already waiting.
 *
 * Before this, generation was triggered by the student's click and took ~18s for
 * three handouts. It was cached afterwards, so exactly one student per handout
 * version paid the wait — but that student was a child sitting in front of a
 * spinner. The work is the same; this moves it to the moment the admin uploads,
 * when nobody is waiting on it.
 *
 * Two things make this safe to fire and forget:
 *
 *   - It is debounced per subject. Uploading five handouts one at a time would
 *     otherwise bump the version five times and pay for five generations; the
 *     timer restarts on each change and only the last one runs.
 *   - getOrCreatePreAssessment is already single-flight in process and guarded by
 *     a unique index per handout version in the database. If a student arrives
 *     mid-generation they join the same work rather than starting a second copy.
 *
 * Nothing here throws into a request. A failed warm-up costs nothing: the student
 * path still generates on demand exactly as it did before.
 */

const DEFAULT_DELAY_MS = 12000;

// subjectId -> { timer, state, reason, error, at, version }
const warmups = new Map();

function setState(subjectId, patch) {
  const key = Number(subjectId);
  const current = warmups.get(key) || {};
  warmups.set(key, { ...current, ...patch, at: new Date() });
}

/**
 * What the admin UI should say about this subject right now.
 *
 * Only the transient part lives in memory — whether a build is queued or running,
 * and why the last one stopped. Whether an assessment actually exists for the
 * current handout version is a database question, and the caller asks it there.
 */
function getWarmupState(subjectId) {
  const entry = warmups.get(Number(subjectId));
  if (!entry) return { status: 'idle' };
  return {
    status: entry.state || 'idle',
    reason: entry.reason || null,
    error: entry.error || null,
    at: entry.at || null
  };
}

/**
 * Queue a Pre-Assessment build for a subject whose handouts just changed.
 *
 * @param {number} subjectId
 * @param {string} reason  short label for the log — "handouts uploaded", etc.
 * @param {object} [options]
 * @param {number} [options.delayMs]  debounce window; 0 runs on the next tick
 * @returns {Promise|null} the work, for tests that need to await it
 */
function schedulePreAssessmentWarmup(subjectId, reason = 'handouts changed', options = {}) {
  const key = Number(subjectId);
  if (!key) return null;

  const delayMs = options.delayMs === undefined ? DEFAULT_DELAY_MS : Number(options.delayMs);
  const existing = warmups.get(key);
  if (existing && existing.timer) clearTimeout(existing.timer);

  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });

  const timer = setTimeout(() => { run(key, reason).then(resolveDone); }, delayMs);
  // A pending warm-up must never hold the process open — this matters for the
  // test suites and for any script that requires lib/data.
  if (typeof timer.unref === 'function') timer.unref();

  setState(key, { timer, state: 'queued', reason, error: null });
  return done;
}

async function run(subjectId, reason) {
  setState(subjectId, { timer: null, state: 'generating', reason, error: null });
  const started = Date.now();
  try {
    // Required lazily: lib/data pulls in the whole data layer, and requiring it at
    // module load would make this file and data.js a require cycle.
    const { getOrCreatePreAssessment } = require('./data');
    const result = await getOrCreatePreAssessment(subjectId);
    const items = (result.assessment.questions || []).length;
    setState(subjectId, {
      state: 'ready',
      error: null,
      version: result.assessment.handout_version
    });
    console.log(
      `[pre-assessment warmup] subject ${subjectId}: ${result.generated ? 'generated' : 'reused'} `
      + `${items} item(s) in ${Date.now() - started}ms (${reason})`
    );
    return { ok: true, generated: result.generated, items };
  } catch (error) {
    // "No readable handouts yet" is the normal state right after a scanned PDF is
    // uploaded, not a failure worth alarming anyone about. It is reported to the
    // admin as "waiting" so the UI can explain what is missing.
    const waiting = /no handouts with readable text/i.test(error.message || '');
    setState(subjectId, {
      state: waiting ? 'waiting' : 'error',
      error: error.message || String(error)
    });
    console.log(
      `[pre-assessment warmup] subject ${subjectId}: ${waiting ? 'waiting' : 'FAILED'} — ${error.message}`
    );
    return { ok: false, error: error.message };
  }
}

module.exports = {
  schedulePreAssessmentWarmup,
  getWarmupState,
  DEFAULT_DELAY_MS
};
