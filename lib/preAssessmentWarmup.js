

const { canonicalGrade } = require('./moduleGrades');

const DEFAULT_DELAY_MS = 12000;

const warmups = new Map();

function keyOf(subjectId, gradeLevel) {
  return `${Number(subjectId)}|${canonicalGrade(gradeLevel)}`;
}

function setState(key, patch) {
  const current = warmups.get(key) || {};
  warmups.set(key, { ...current, ...patch, at: new Date() });
}

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
  
  
  if (typeof timer.unref === 'function') timer.unref();

  setState(key, { timer, state: 'queued', reason, error: null });
  return done;
}

async function run(key, subjectId, grade, reason) {
  setState(key, { timer: null, state: 'generating', reason, error: null });
  const started = Date.now();
  try {
    
    
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
