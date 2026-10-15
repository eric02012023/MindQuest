/**
 * File: scripts/test-tutor-assignment.js
 * Purpose: Pin down how a student gets their tutors.
 *
 * Run:  node scripts/test-tutor-assignment.js      (needs no database, no keys)
 *
 * THE RULES
 *   1. A tutor teaches only the subjects they teach. Assigning a tutor writes
 *      them to the student's subjects THEY TEACH — never to a subject they do
 *      not. (It used to write one tutor to every subject, so a Math tutor
 *      became the English tutor as well.)
 *   2. A subject the tutor does not teach is left open, and reported, so the
 *      student (or the office) picks another tutor for that subject alone.
 *   3. The student may only ask for a tutor for subjects that have none; a
 *      subject that has a tutor is the office's to change. The guard reads the
 *      ASSIGNMENTS, not the requests, so an admin-assigned student is covered.
 *   4. One tutor cannot hold one time slot for two students.
 *   5. ONE SUBJECT, ONE HOUR. A student picks a subject's days, time and tutor
 *      on their own; the tutor who accepts takes that subject alone, and a
 *      student never spends the same hour (on the same days) on two subjects —
 *      not even with the same tutor. The same hour on the other days is free.
 *
 * config/db is replaced in the require cache before lib/data.js loads, so the
 * real code runs against a scripted database.
 */

let failures = 0;
const ok = (l, c, e = '') => {
  if (c) console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`);
  else { failures++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};

// --- the scripted database ------------------------------------------------
const SUBJECTS = { 1: 'MATHEMATICS (BASIC TO ADVANCE)', 4: 'ENGLISH', 6: 'FILIPINO' };
let db;
function reset() {
  db = {
    users: {
      30: { id: 30, role: 'student', branch_id: 2, first_name: 'Jordan', last_name: 'Lee', subjects_json: '[]', extra_json: '{}' },
      // Teaches Math and Filipino, not English.
      28: { id: 28, role: 'tutor', branch_id: 2, first_name: 'Ana', last_name: 'Cruz',
        subjects_json: JSON.stringify([SUBJECTS[1], SUBJECTS[6]]), extra_json: '{}' },
      // Teaches English only.
      29: { id: 29, role: 'tutor', branch_id: 2, first_name: 'Ben', last_name: 'Reyes',
        subjects_json: JSON.stringify([SUBJECTS[4]]), extra_json: '{}' },
      10: { id: 10, role: 'tutor', branch_id: 1, first_name: 'Far', last_name: 'Away',
        subjects_json: JSON.stringify(Object.values(SUBJECTS)), extra_json: '{}' },
      11: { id: 11, role: 'tutor', branch_id: 9, first_name: 'Multi', last_name: 'Branch',
        subjects_json: JSON.stringify(Object.values(SUBJECTS)), extra_json: JSON.stringify({ branch_ids: [2, 9] }) },
      // The damaged list the old profile save left behind: still teaches Math.
      31: { id: 31, role: 'tutor', branch_id: 2, first_name: 'Juan', last_name: 'Dela Cruz',
        subjects_json: JSON.stringify(['["MATHEMATICS (BASIC TO ADVANCE)"', '"ENGLISH"]']), extra_json: '{}' }
    },
    assignments: [
      { id: 1, student_id: 30, subject_id: 1, tutor_id: null, time_slot: null, is_archived: 0 },
      { id: 2, student_id: 30, subject_id: 4, tutor_id: null, time_slot: null, is_archived: 0 },
      { id: 3, student_id: 30, subject_id: 6, tutor_id: null, time_slot: null, is_archived: 0 }
    ],
    // other students' enrolments: { tutor_id, time_slot, preferred_days, student_id, first_name, last_name }
    others: [],
    applications: []
  };
}
reset();

function active() { return db.assignments.filter((a) => !a.is_archived); }
function withSubject(a) { return { ...a, subject_name: SUBJECTS[a.subject_id] }; }
// The SQL's DAYS_OVERLAP_SQL: "not set" on either side overlaps everything.
const overlaps = (a, b) => !a || !b || a === b;

async function runSql(text, params = []) {
  const s = String(text).replace(/\s+/g, ' ').trim();

  if (/FROM users u LEFT JOIN branches b ON b\.id = u\.branch_id WHERE u\.id = \?/i.test(s)) {
    const u = db.users[Number(params[0])];
    return u ? [{ ...u }] : [];
  }
  // getAssignedTutorFor
  if (/INNER JOIN users u ON u\.id = usa\.tutor_id/i.test(s)) {
    const hit = active().find((a) => a.tutor_id);
    if (!hit) return [];
    const t = db.users[hit.tutor_id];
    return [{ tutor_id: hit.tutor_id, time_slot: hit.time_slot, first_name: t.first_name, last_name: t.last_name, middle_name: '' }];
  }
  // a student's active enrolments, with subject names
  if (/SELECT usa\.id, usa\.subject_id, usa\.tutor_id, usa\.time_slot, (usa\.preferred_days, )?s\.name AS subject_name/i.test(s)) {
    return active().map(withSubject);
  }
  // the open (tutor-less) enrolments, for an acceptance
  if (/SELECT usa\.id, s\.name AS subject_name .* usa\.tutor_id IS NULL/i.test(s)) {
    return active().filter((a) => !a.tutor_id).map(withSubject);
  }
  // clash: the tutor already teaches ANOTHER student at that slot, on those days
  if (/SELECT TOP 1 usa\.student_id, u\.first_name, u\.last_name .* usa\.student_id <> \?/i.test(s)) {
    const [tutorId, slot, exceptId, days] = params;
    return db.others.filter((r) => Number(r.tutor_id) === Number(tutorId) && r.time_slot === slot
      && Number(r.student_id) !== Number(exceptId) && !r.archived && overlaps(r.preferred_days, days));
  }
  // blockedSlotsByTutor — the tutors' other learners (an archived one holds nothing)
  if (/SELECT DISTINCT usa\.tutor_id, usa\.time_slot, usa\.preferred_days FROM user_subject_assignments usa INNER JOIN users st/i.test(s)) {
    const ids = params.slice(0, -1).map(Number);
    const exceptId = Number(params[params.length - 1]);
    return db.others.filter((r) => ids.includes(Number(r.tutor_id)) && Number(r.student_id) !== exceptId && !r.archived)
      .map((r) => ({ tutor_id: r.tutor_id, time_slot: r.time_slot, preferred_days: r.preferred_days || null }));
  }
  // … and other learners' requests still WAITING (an accepted one lives in the enrolments)
  if (/SELECT DISTINCT tsa\.tutor_id, tsa\.time_slot, tsa\.preferred_days FROM tutor_schedule_applications tsa/i.test(s)) {
    if (!/tsa\.status = 'pending'/.test(s)) throw new Error('only waiting requests may block a tutor');
    const ids = params.slice(0, -1).map(Number);
    const exceptId = Number(params[params.length - 1]);
    return db.applications.filter((a) => ids.includes(Number(a.tutor_id)) && a.status === 'pending' && Number(a.student_id) !== exceptId)
      .map((a) => ({ tutor_id: a.tutor_id, time_slot: a.time_slot, preferred_days: a.preferred_days || null }));
  }
  // getStudentHeldSessions — the hours the student already spends: enrolments
  // that have a tutor and a time …
  if (/SELECT usa\.subject_id, s\.name AS subject_name, usa\.time_slot, usa\.preferred_days FROM user_subject_assignments usa/i.test(s)) {
    return active().filter((a) => a.tutor_id && a.time_slot)
      .map((a) => ({ subject_id: a.subject_id, subject_name: SUBJECTS[a.subject_id], time_slot: a.time_slot, preferred_days: a.preferred_days || null }));
  }
  // … and requests still waiting for a tutor's answer
  if (/SELECT tsa\.subject_id, s\.name AS subject_name, tsa\.time_slot, tsa\.preferred_days FROM tutor_schedule_applications tsa/i.test(s)) {
    // only while the subject is still enrolled and still has no tutor
    return db.applications.filter((a) => Number(a.student_id) === Number(params[0]) && a.status === 'pending'
      && active().some((x) => Number(x.subject_id) === Number(a.subject_id) && !x.tutor_id))
      .map((a) => ({ subject_id: a.subject_id, subject_name: SUBJECTS[a.subject_id], time_slot: a.time_slot, preferred_days: a.preferred_days || null }));
  }
  // the student's own waiting requests (create / accept / admin assign)
  if (/FROM tutor_schedule_applications WHERE student_id = \? AND status = 'pending'/i.test(s)) {
    const exceptId = /AND id <> \?/i.test(s) ? Number(params[1]) : null;
    return db.applications.filter((a) => Number(a.student_id) === Number(params[0]) && a.status === 'pending' && Number(a.id) !== exceptId)
      .map((a) => ({ id: a.id, subject_id: a.subject_id, tutor_id: a.tutor_id, time_slot: a.time_slot, preferred_days: a.preferred_days || null }));
  }
  if (/^INSERT INTO tutor_schedule_applications/i.test(s)) {
    const [studentId, tutorId, subjectId, , slot, days] = params;
    const id = db.applications.length + 100;
    db.applications.push({ id, student_id: studentId, tutor_id: tutorId, subject_id: subjectId, time_slot: slot, preferred_days: days || null, status: 'pending' });
    return { insertId: id };
  }
  if (/^SELECT TOP 1 \* FROM tutor_schedule_applications WHERE id = \?/i.test(s)) {
    return db.applications.filter((a) => Number(a.id) === Number(params[0]));
  }
  if (/FROM tutor_schedule_applications WHERE tutor_id = \? AND time_slot = \? AND status = 'accepted'/i.test(s)) {
    throw new Error('an old accepted request must not decide whether an hour is free');
  }
  // acceptance: does the tutor already teach ANOTHER (active) learner then?
  if (/SELECT TOP 1 usa\.id FROM user_subject_assignments usa INNER JOIN users st ON st\.id = usa\.student_id WHERE usa\.tutor_id = \? AND usa\.time_slot = \?/i.test(s)) {
    const [tutorId, slot, exceptId, days] = params;
    return db.others.filter((r) => Number(r.tutor_id) === Number(tutorId) && r.time_slot === slot
      && Number(r.student_id) !== Number(exceptId) && !r.archived && overlaps(r.preferred_days, days)).map(() => ({ id: 1 }));
  }
  // acceptance: does the student already spend that hour on ANOTHER subject?
  if (/SELECT TOP 1 usa\.id, s\.name AS subject_name FROM user_subject_assignments usa .* usa\.subject_id <> \? AND usa\.time_slot = \?/i.test(s)) {
    const [, subjectId, slot, days] = params;
    return active().filter((a) => a.tutor_id && Number(a.subject_id) !== Number(subjectId) && a.time_slot === slot
      && overlaps(a.preferred_days, days)).map((a) => ({ id: a.id, subject_name: SUBJECTS[a.subject_id] }));
  }
  // acceptance: the one subject the request names
  if (/SELECT usa\.id, usa\.tutor_id, s\.name AS subject_name FROM user_subject_assignments usa .* usa\.subject_id = \?/i.test(s)) {
    const [, subjectId] = params;
    return active().filter((a) => Number(a.subject_id) === Number(subjectId)).map(withSubject);
  }
  if (/^UPDATE tutor_schedule_applications SET status = 'accepted'/i.test(s)) {
    const app = db.applications.find((a) => Number(a.id) === Number(params[1]));
    if (app) app.status = 'accepted';
    return [];
  }
  // declining a waiting request closes that one request only
  if (/^UPDATE tutor_schedule_applications SET status = 'cancelled'.* WHERE id = \?$/i.test(s)) {
    const app = db.applications.find((a) => Number(a.id) === Number(params[params.length - 1]));
    if (app) app.status = 'cancelled';
    return [];
  }
  if (/^UPDATE tutor_schedule_applications SET status = 'cancelled'.* WHERE id = \? AND status = 'pending'/i.test(s)) {
    const app = db.applications.find((a) => Number(a.id) === Number(params[params.length - 1]) && a.status === 'pending');
    if (app) app.status = 'cancelled';
    return [];
  }
  if (/^UPDATE tutor_schedule_applications/i.test(s)) {
    return [];
  }
  // releaseSession: this hour, on these days, with this tutor goes back to the student — nothing else
  if (/^UPDATE user_subject_assignments SET tutor_id = NULL, time_slot = NULL, preferred_days = NULL, assigned_at = NULL, updated_at = .* WHERE student_id = \? AND is_archived = 0 AND tutor_id = \? AND time_slot = \? AND \(\? IS NULL OR preferred_days IS NULL OR preferred_days = \?\)$/i.test(s)) {
    const [studentId, tutorId, slot, days] = params;
    for (const a of active()) {
      if (Number(a.student_id) === Number(studentId) && Number(a.tutor_id) === Number(tutorId) && a.time_slot === slot
        && overlaps(a.preferred_days, days)) {
        a.tutor_id = null; a.time_slot = null; a.preferred_days = null;
      }
    }
    return [];
  }
  // the write: tutor + slot (+ days) onto the listed enrolments
  if (/^UPDATE user_subject_assignments SET tutor_id = \?, time_slot = \?, preferred_days = (\?|COALESCE\(\?, preferred_days\))/i.test(s)) {
    const keepDays = /COALESCE/i.test(s);
    const [tutorId, slot, days, , ...ids] = params;
    for (const a of active()) {
      if (ids.map(Number).includes(Number(a.id))) {
        a.tutor_id = tutorId; a.time_slot = slot;
        a.preferred_days = keepDays ? (days || a.preferred_days || null) : (days || null);
      }
    }
    return [];
  }
  if (/^UPDATE user_subject_assignments SET tutor_id = NULL/i.test(s)) {
    const [, ...ids] = params;
    for (const a of active()) {
      if (ids.map(Number).includes(Number(a.id))) { a.tutor_id = null; a.time_slot = null; a.preferred_days = null; }
    }
    return [];
  }
  return [];
}

const dbPath = require.resolve('../config/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    sql: {}, baseConfig: {},
    getPool: async () => { throw new Error('the test must never open a connection'); },
    query: async (text, params = []) => runSql(text, params),
    withTransaction: async (work) => work({ query: async (text, params = []) => [await runSql(text, params)] })
  }
};

const {
  setStudentTutorAndSchedule, getAssignedTutorFor, FIXED_TIME_SLOTS, TUTOR_LOCKED_MESSAGE,
  createTutorScheduleRequest, acceptTutorScheduleApplication, cancelTutorScheduleApplication, finishTutorScheduleApplication,
  normalizeTutorYearLevels, tutorTeachesSubject, repairNameList,
  getBlockedSlotsForTutor, getStudentHeldSessions, slotKey, normalizePreferredDays, daysOverlap
} = require('../lib/data');

const refuse = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
const tutorOf = (subjectId) => active().find((a) => a.subject_id === subjectId).tutor_id;
const slotOf = (subjectId) => active().find((a) => a.subject_id === subjectId).time_slot;
const admin = { id: 1, role: 'admin' };
const MATH = 1;
const ENGLISH = 4;
const FILIPINO = 6;

(async () => {
  console.log('\n== a tutor is written only to the subjects they teach ==');
  reset();
  const result = await setStudentTutorAndSchedule(30, { tutorId: 28 }, admin);
  ok('Math goes to the Math tutor', Number(tutorOf(MATH)) === 28);
  ok('Filipino goes to them too (they teach it)', Number(tutorOf(FILIPINO)) === 28);
  ok('English is NOT given to a tutor who does not teach it', tutorOf(ENGLISH) === null, String(tutorOf(ENGLISH)));
  ok('it reports the subjects it set', result.subjectsUpdated === 2 && result.subjectNames.length === 2, JSON.stringify(result.subjectNames));
  ok('and the subject left for another tutor', result.skippedSubjects.join() === SUBJECTS[ENGLISH], JSON.stringify(result.skippedSubjects));

  console.log('\n== the open subject gets its own tutor ==');
  const english = await setStudentTutorAndSchedule(30, { tutorId: 29, timeSlot: '3:00-4:00 PM', subjectIds: [ENGLISH] }, admin);
  ok('English now has the English tutor', Number(tutorOf(ENGLISH)) === 29);
  ok('the other subjects keep theirs', Number(tutorOf(MATH)) === 28 && Number(tutorOf(FILIPINO)) === 28);
  ok('one subject was set', english.subjectsUpdated === 1);

  console.log('\n== naming a subject the tutor does not teach is refused ==');
  const wrong = await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 29, timeSlot: '5:00-6:00 PM', subjectIds: [MATH] }, { id: 1 }));
  ok('refused', wrong !== null, wrong || 'it went through');
  ok('and says which subject', /does not teach MATHEMATICS/.test(wrong || ''), wrong || '');
  ok('nothing changed', Number(tutorOf(MATH)) === 28);

  reset();
  const none = await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 29, timeSlot: '', subjectIds: [MATH, FILIPINO] }, { id: 1 }));
  ok('a tutor who teaches none of them is refused', /does not teach/.test(none || ''), none || 'went through');

  console.log('\n== a damaged subject list still counts ==');
  ok('fragments read back as names', repairNameList(['["MATHEMATICS (BASIC TO ADVANCE)"', '"ENGLISH"]']).join('|') === `${SUBJECTS[MATH]}|ENGLISH`);
  ok('the tutor still teaches Math', tutorTeachesSubject({ subjects_json: db.users[31].subjects_json }, SUBJECTS[MATH]));
  ok('an archived subject does not count',
    !tutorTeachesSubject({ subjects: [SUBJECTS[MATH]], extra: { archived_subjects: [SUBJECTS[MATH]] } }, SUBJECTS[MATH]));

  console.log('\n== clearing a tutor clears that subject\'s schedule ==');
  reset();
  await setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '2:00-3:00 PM', subjectIds: [MATH] }, admin);
  await setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '3:00-4:00 PM', subjectIds: [FILIPINO] }, admin);
  await setStudentTutorAndSchedule(30, { tutorId: '', timeSlot: '', subjectIds: [MATH] }, admin);
  ok('Math has no tutor', tutorOf(MATH) === null);
  ok('and no orphan slot', slotOf(MATH) === null);
  ok('Filipino keeps its tutor and its own hour', Number(tutorOf(FILIPINO)) === 28 && slotOf(FILIPINO) === '3:00-4:00 PM');

  console.log('\n== nobody is double-booked ==');
  reset();
  db.others = [{ tutor_id: 28, time_slot: '3:00-4:00 PM', student_id: 99, first_name: 'Other', last_name: 'Learner' }];
  const clash = await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '3:00-4:00 PM', subjectIds: [MATH] }, { id: 1 }));
  ok('the tutor\'s taken slot is refused', /Other Learner/.test(clash || ''), clash || 'went through');
  reset();
  await setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '9:00-10:00 AM', subjectIds: [MATH] }, admin);
  const twoPlaces = await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 29, timeSlot: '9:00-10:00 AM', subjectIds: [ENGLISH] }, { id: 1 }));
  ok('a student cannot be at two places at the same time', /already has MATHEMATICS/.test(twoPlaces || ''), twoPlaces || 'went through');

  console.log('\n== ONE SUBJECT, ONE HOUR — the office too ==');
  reset();
  await setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '9:00-10:00 AM', subjectIds: [MATH] }, admin);
  const sameTutorSameHour = await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '9:00-10:00 AM', subjectIds: [FILIPINO] }, admin));
  ok('even the SAME tutor cannot teach a second subject in that hour', /already has MATHEMATICS.*One subject takes one hour/.test(sameTutorSameHour || ''), sameTutorSameHour || 'went through');
  ok('Filipino was not given the hour', tutorOf(FILIPINO) === null);
  const otherHour = await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '11:00-12:00 PM', subjectIds: [FILIPINO] }, admin));
  ok('the same tutor at another hour is fine', otherHour === null, otherHour || '');
  reset();
  const asOne = await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '2:00-3:00 PM' }, admin));
  ok('one time slot cannot be written to two subjects at once', /belongs to one subject/.test(asOne || ''), asOne || 'went through');
  ok('and nothing was written', tutorOf(MATH) === null && tutorOf(FILIPINO) === null);
  reset();
  await setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '9:00-10:00 AM', preferredDays: 'Weekdays', subjectIds: [MATH] }, admin);
  const otherDays = await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '9:00-10:00 AM', preferredDays: 'Weekend', subjectIds: [FILIPINO] }, admin));
  ok('the same hour on the other days is a different session', otherDays === null, otherDays || '');

  console.log('\n== the inputs are checked ==');
  reset();
  ok('an unknown time slot is refused',
    (await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '4am-ish', subjectIds: [MATH] }, { id: 1 }))) !== null);
  ok('a tutor from another branch is refused',
    (await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 10, timeSlot: '2:00-3:00 PM', subjectIds: [MATH] }, { id: 1 }))) !== null);
  reset();
  ok('a tutor who serves this branch as a SECOND branch is allowed',
    (await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 11, timeSlot: '2:00-3:00 PM', subjectIds: [MATH] }, { id: 1 }))) === null);
  reset();
  ok('assigning a student as a tutor is refused',
    (await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 30, timeSlot: '2:00-3:00 PM', subjectIds: [MATH] }, { id: 1 }))) !== null);

  console.log('\n== the student asks only for subjects with no tutor ==');
  reset();
  await setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '2:00-3:00 PM', subjectIds: [MATH] }, admin);
  await setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '3:00-4:00 PM', subjectIds: [FILIPINO] }, admin);
  ok('the student has a tutor on record', (await getAssignedTutorFor(30)) !== null);
  const forEnglish = await createTutorScheduleRequest(30, ENGLISH, 29, '5:00-6:00 PM', 'Weekdays');
  ok('they can still ask for English', forEnglish && forEnglish.subjectName === SUBJECTS[ENGLISH], JSON.stringify(forEnglish));
  const notTeaching = await refuse(() => createTutorScheduleRequest(30, ENGLISH, 28, '6:00-7:00 PM', 'Weekdays'));
  ok('asking the Math tutor for English is refused', /does not teach ENGLISH/.test(notTeaching || ''), notTeaching || '');
  const hasTutor = await refuse(() => createTutorScheduleRequest(30, MATH, 28, '6:00-7:00 PM', 'Weekdays'));
  ok('a subject that already has a tutor is the office\'s to change', hasTutor === TUTOR_LOCKED_MESSAGE, hasTutor || 'went through');
  const noDays = await refuse(() => createTutorScheduleRequest(30, ENGLISH, 29, '6:00-7:00 PM', ''));
  ok('the days are required', /Choose Weekdays or Weekend/.test(noDays || ''), noDays || 'went through');
  const notEnrolled = await refuse(() => createTutorScheduleRequest(30, 99, 29, '6:00-7:00 PM', 'Weekdays'));
  ok('a subject the student is not in is refused', /not enrolled/.test(notEnrolled || ''), notEnrolled || 'went through');

  console.log('\n== accepting assigns only the subject that was asked for ==');
  const request = db.applications.find((a) => a.tutor_id === 29);
  const accepted = await acceptTutorScheduleApplication(request.id, 29);
  ok('English is now the English tutor\'s', Number(tutorOf(ENGLISH)) === 29);
  ok('Math and Filipino were not touched', Number(tutorOf(MATH)) === 28 && Number(tutorOf(FILIPINO)) === 28);
  ok('the acceptance names the subject', accepted.subjects.join() === SUBJECTS[ENGLISH]);

  console.log('\n== once every subject has a tutor, only the office can change it ==');
  const locked = await refuse(() => createTutorScheduleRequest(30, ENGLISH, 29, '7:00-8:00 AM', 'Weekdays'));
  ok('the request is refused', locked === TUTOR_LOCKED_MESSAGE, locked || 'went through');
  ok('and says an admin must do it', /Only an admin/.test(locked || ''));

  console.log('\n== a tutor who teaches two of the student\'s subjects takes only the one asked for ==');
  reset();
  await createTutorScheduleRequest(30, MATH, 28, '9:00-10:00 AM', 'Weekdays');
  const mathRequest = db.applications.find((a) => a.subject_id === MATH);
  const acceptedMath = await acceptTutorScheduleApplication(mathRequest.id, 28);
  ok('Math is Ana\'s', Number(tutorOf(MATH)) === 28);
  ok('Filipino is still OPEN — Ana teaches it, but it was not asked for', tutorOf(FILIPINO) === null, String(tutorOf(FILIPINO)));
  ok('the acceptance names Math alone', acceptedMath.subjects.join() === SUBJECTS[MATH], JSON.stringify(acceptedMath.subjects));
  const second = await refuse(() => createTutorScheduleRequest(30, FILIPINO, 28, '11:00-12:00 PM', 'Weekdays'));
  ok('Filipino can be asked of the same tutor — at its own hour', second === null, second || '');
  const filipinoRequest = db.applications.find((a) => a.subject_id === FILIPINO);
  await acceptTutorScheduleApplication(filipinoRequest.id, 28);
  ok('and then both are Ana\'s, one hour each', Number(tutorOf(FILIPINO)) === 28 && slotOf(MATH) === '9:00-10:00 AM' && slotOf(FILIPINO) === '11:00-12:00 PM');

  console.log('\n== an hour taken by one subject is not offered for another ==');
  reset();
  await setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '7:00-8:00 AM', preferredDays: 'Weekdays', subjectIds: [FILIPINO] }, admin);
  const held = await getStudentHeldSessions(30);
  ok('Filipino holds Weekdays 7:00-8:00 AM', held.length === 1 && held[0].days === 'Weekdays' && held[0].time_slot === '7:00-8:00 AM', JSON.stringify(held));
  ok('its own subject is left out when it is the one being edited', (await getStudentHeldSessions(30, null, { exceptSubjectId: FILIPINO })).length === 0);
  const forBen = await getBlockedSlotsForTutor(29, 30);
  ok('for ANY tutor, that hour is blocked on weekdays', forBen.has(slotKey('Weekdays', '7:00-8:00 AM')));
  ok('the same hour on the weekend is still free', !forBen.has(slotKey('Weekend', '7:00-8:00 AM')));
  const english2 = await refuse(() => createTutorScheduleRequest(30, ENGLISH, 29, '7:00-8:00 AM', 'Weekdays'));
  ok('English cannot take weekdays 7:00-8:00 AM', /already have FILIPINO at 7:00-8:00 AM on weekdays.*One subject takes one hour/.test(english2 || ''), english2 || 'went through');
  const english3 = await refuse(() => createTutorScheduleRequest(30, ENGLISH, 29, '7:00-8:00 AM', 'Weekend'));
  ok('but English can have 7:00-8:00 AM on the weekend', english3 === null, english3 || '');

  console.log('\n== a waiting request holds its hour too ==');
  reset();
  await createTutorScheduleRequest(30, MATH, 28, '9:00-10:00 AM', 'Weekdays');
  const waitingHeld = await getStudentHeldSessions(30);
  ok('the waiting request is a held hour', waitingHeld.length === 1 && waitingHeld[0].waiting === true && waitingHeld[0].subject_name === SUBJECTS[MATH], JSON.stringify(waitingHeld));
  const sameHourElsewhere = await refuse(() => createTutorScheduleRequest(30, ENGLISH, 29, '9:00-10:00 AM', 'Weekdays'));
  ok('another subject cannot ask for that hour meanwhile', /already have MATHEMATICS/.test(sameHourElsewhere || ''), sameHourElsewhere || 'went through');
  const again = await refuse(() => createTutorScheduleRequest(30, MATH, 28, '11:00-12:00 PM', 'Weekdays'));
  ok('and a subject cannot be asked for twice', /already asked a tutor for MATHEMATICS/.test(again || ''), again || 'went through');

  console.log('\n== accepting is refused if the hour was spent on another subject meanwhile ==');
  reset();
  await createTutorScheduleRequest(30, MATH, 28, '9:00-10:00 AM', 'Weekdays');
  // the office gives Filipino that very hour while Math's request is waiting
  await setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '9:00-10:00 AM', preferredDays: 'Weekdays', subjectIds: [FILIPINO] }, admin);
  const stale = await refuse(() => acceptTutorScheduleApplication(db.applications.find((a) => a.subject_id === MATH).id, 28));
  ok('the tutor is told, and Math stays open', /already has FILIPINO/.test(stale || '') && tutorOf(MATH) === null, stale || 'went through');

  console.log('\n== the admin\'s choice closes only the request for that subject ==');
  reset();
  await createTutorScheduleRequest(30, MATH, 28, '9:00-10:00 AM', 'Weekdays');
  await createTutorScheduleRequest(30, ENGLISH, 29, '2:00-3:00 PM', 'Weekdays');
  await setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '11:00-12:00 PM', subjectIds: [MATH] }, admin);
  ok('the Math request is closed', db.applications.find((a) => a.subject_id === MATH).status === 'cancelled');
  ok('the English request is still waiting', db.applications.find((a) => a.subject_id === ENGLISH).status === 'pending');

  console.log('\n== weekdays and the weekend are separate sessions ==');
  reset();
  // Ana already teaches another student at 1:00 PM on WEEKDAYS.
  db.others = [{ tutor_id: 28, time_slot: '1:00-2:00 PM', preferred_days: 'Weekdays', student_id: 99, first_name: 'Other', last_name: 'Learner' }];
  const blocked = await getBlockedSlotsForTutor(28, 30);
  ok('the weekday slot is blocked', blocked.has(slotKey('Weekdays', '1:00-2:00 PM')));
  ok('the same slot on the weekend is free', !blocked.has(slotKey('Weekend', '1:00-2:00 PM')));
  const weekend = await refuse(() => createTutorScheduleRequest(30, MATH, 28, '1:00-2:00 PM', 'Weekend'));
  ok('a weekend request at that time goes through', weekend === null, weekend || '');
  ok('the request records the days', db.applications.some((a) => a.preferred_days === 'Weekend'));
  reset();
  db.others = [{ tutor_id: 28, time_slot: '1:00-2:00 PM', preferred_days: 'Weekdays', student_id: 99, first_name: 'Other', last_name: 'Learner' }];
  const weekday = await refuse(() => createTutorScheduleRequest(30, MATH, 28, '1:00-2:00 PM', 'Weekdays'));
  ok('a weekday request at that time is refused', /no longer available/.test(weekday || ''), weekday || 'went through');
  reset();
  db.others = [{ tutor_id: 28, time_slot: '1:00-2:00 PM', preferred_days: null, student_id: 99, first_name: 'Other', last_name: 'Learner' }];
  const unset = await getBlockedSlotsForTutor(28, 30);
  ok('an enrolment with no days chosen blocks BOTH',
    unset.has(slotKey('Weekdays', '1:00-2:00 PM')) && unset.has(slotKey('Weekend', '1:00-2:00 PM')));
  ok('the days helper reads either spelling', normalizePreferredDays('weekends') === 'Weekend' && normalizePreferredDays('Weekday') === 'Weekdays');
  ok('"not set" overlaps both', daysOverlap(null, 'Weekend') && daysOverlap('Weekdays', '') && !daysOverlap('Weekdays', 'Weekend'));
  reset();
  await setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '5:00-6:00 PM', subjectIds: [MATH] }, admin);
  const legacy = await getStudentHeldSessions(30);
  ok('a student\'s own old enrolment with no days holds both days',
    legacy.length === 1 && legacy[0].days === '' && daysOverlap(legacy[0].days, 'Weekend') && daysOverlap(legacy[0].days, 'Weekdays'));

  console.log('\n== the admin can book the same slot on the other days ==');
  reset();
  db.others = [{ tutor_id: 28, time_slot: '3:00-4:00 PM', preferred_days: 'Weekdays', student_id: 99, first_name: 'Other', last_name: 'Learner' }];
  const adminWeekend = await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '3:00-4:00 PM', preferredDays: 'Weekend', subjectIds: [MATH] }, { id: 1 }));
  ok('allowed on the weekend', adminWeekend === null, adminWeekend || '');
  ok('and the days are written', active().filter((a) => a.tutor_id === 28).every((a) => a.preferred_days === 'Weekend'));
  reset();
  db.others = [{ tutor_id: 28, time_slot: '3:00-4:00 PM', preferred_days: 'Weekdays', student_id: 99, first_name: 'Other', last_name: 'Learner' }];
  const adminWeekday = await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '3:00-4:00 PM', preferredDays: 'Weekdays', subjectIds: [MATH] }, { id: 1 }));
  ok('refused on weekdays', /Other Learner/.test(adminWeekday || ''), adminWeekday || 'went through');

  console.log('\n== several subjects, asked one by one ==');
  reset();
  const first = await createTutorScheduleRequest(30, MATH, 28, '9:00-10:00 AM', 'Weekdays');
  ok('Math asked of Ana — Math alone', first.subjectName === SUBJECTS[MATH], JSON.stringify(first));
  const next = await refuse(() => createTutorScheduleRequest(30, ENGLISH, 29, '2:00-3:00 PM', 'Weekdays'));
  ok('English can be asked of Ben at another hour', next === null, next || '');
  const sameTutor = await refuse(() => createTutorScheduleRequest(30, FILIPINO, 28, '5:00-6:00 PM', 'Weekend'));
  ok('Ana can be asked again — for another subject, at another hour', sameTutor === null, sameTutor || '');
  ok('three requests are waiting, one per subject', db.applications.filter((a) => a.status === 'pending').length === 3);
  reset();
  await createTutorScheduleRequest(30, MATH, 28, '9:00-10:00 AM', 'Weekdays');
  const sameTime = await refuse(() => createTutorScheduleRequest(30, ENGLISH, 29, '9:00-10:00 AM', 'Weekdays'));
  ok('two subjects at the same hour are refused', /one hour|already have/.test(sameTime || ''), sameTime || 'went through');

  console.log('\n== declining a request takes nothing else away ==');
  reset();
  await setStudentTutorAndSchedule(30, { tutorId: 29, timeSlot: '7:00-8:00 AM', preferredDays: 'Weekdays', subjectIds: [ENGLISH] }, admin);
  await createTutorScheduleRequest(30, MATH, 28, '11:00-12:00 PM', 'Weekdays');
  const pending = db.applications.find((a) => a.tutor_id === 28 && a.status === 'pending');
  await cancelTutorScheduleApplication(pending.id, 28);
  ok('the request is closed', pending.status === 'cancelled');
  ok('English keeps its tutor', Number(tutorOf(ENGLISH)) === 29);
  const afterDecline = await refuse(() => createTutorScheduleRequest(30, MATH, 28, '11:00-12:00 PM', 'Weekdays'));
  ok('and the hour is free to ask for again', afterDecline === null, afterDecline || '');

  console.log('\n== ending one session gives back that hour only ==');
  reset();
  await createTutorScheduleRequest(30, MATH, 28, '9:00-10:00 AM', 'Weekdays');
  await acceptTutorScheduleApplication(db.applications.find((a) => a.subject_id === MATH).id, 28);
  await createTutorScheduleRequest(30, FILIPINO, 28, '11:00-12:00 PM', 'Weekdays');
  await acceptTutorScheduleApplication(db.applications.find((a) => a.subject_id === FILIPINO).id, 28);
  ok('both subjects are Ana\'s, at their own hours', slotOf(MATH) === '9:00-10:00 AM' && slotOf(FILIPINO) === '11:00-12:00 PM');
  await cancelTutorScheduleApplication(db.applications.find((a) => a.subject_id === MATH).id, 28);
  ok('Math goes back to having no tutor and no hour', tutorOf(MATH) === null && slotOf(MATH) === null);
  ok('Filipino is untouched', Number(tutorOf(FILIPINO)) === 28 && slotOf(FILIPINO) === '11:00-12:00 PM');

  console.log('\n== ending one session leaves the same hour on the other days alone ==');
  reset();
  const appFor = (subjectId) => db.applications.find((a) => a.subject_id === subjectId && ['pending', 'accepted'].includes(a.status));
  await createTutorScheduleRequest(30, MATH, 28, '9:00-10:00 AM', 'Weekdays');
  await acceptTutorScheduleApplication(appFor(MATH).id, 28);
  await createTutorScheduleRequest(30, FILIPINO, 28, '9:00-10:00 AM', 'Weekend');
  await acceptTutorScheduleApplication(appFor(FILIPINO).id, 28);
  ok('Ana teaches Math on weekdays and Filipino on the weekend, both at 9:00', slotOf(MATH) === '9:00-10:00 AM' && slotOf(FILIPINO) === '9:00-10:00 AM'
    && active().find((a) => a.subject_id === MATH).preferred_days === 'Weekdays' && active().find((a) => a.subject_id === FILIPINO).preferred_days === 'Weekend');
  await finishTutorScheduleApplication(appFor(MATH).id, 28);
  ok('finishing the weekday session gives back Math only', tutorOf(MATH) === null);
  ok('the weekend session at the same hour is untouched', Number(tutorOf(FILIPINO)) === 28 && slotOf(FILIPINO) === '9:00-10:00 AM', `${tutorOf(FILIPINO)} ${slotOf(FILIPINO)}`);
  await cancelTutorScheduleApplication(appFor(FILIPINO).id, 28);
  ok('and cancelling the weekend one gives back Filipino', tutorOf(FILIPINO) === null);

  console.log('\n== only what is really held blocks an hour ==');
  reset();
  // an old accepted request of another learner, whose session the office has since moved
  db.applications.push({ id: 900, student_id: 99, tutor_id: 28, subject_id: 1, time_slot: '1:00-2:00 PM', preferred_days: 'Weekdays', status: 'accepted' });
  let heldNow = await getBlockedSlotsForTutor(28, 30);
  ok('an old ACCEPTED request does not block (the enrolments are the record)', !heldNow.has(slotKey('Weekdays', '1:00-2:00 PM')));
  const acceptedLeftover = await refuse(() => createTutorScheduleRequest(30, MATH, 28, '1:00-2:00 PM', 'Weekdays'));
  ok('so the hour can be asked for', acceptedLeftover === null, acceptedLeftover || '');
  reset();
  db.applications.push({ id: 901, student_id: 99, tutor_id: 28, subject_id: 1, time_slot: '2:00-3:00 PM', preferred_days: 'Weekdays', status: 'pending' });
  heldNow = await getBlockedSlotsForTutor(28, 30);
  ok('another learner\'s request still WAITING does block', heldNow.has(slotKey('Weekdays', '2:00-3:00 PM')));
  reset();
  db.others = [{ tutor_id: 28, time_slot: '3:00-4:00 PM', preferred_days: 'Weekdays', student_id: 98, archived: true, first_name: 'Gone', last_name: 'Learner' }];
  heldNow = await getBlockedSlotsForTutor(28, 30);
  ok('an archived learner holds no hour', !heldNow.has(slotKey('Weekdays', '3:00-4:00 PM')));
  const adminOnArchived = await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '3:00-4:00 PM', preferredDays: 'Weekdays', subjectIds: [MATH] }, admin));
  ok('nor does the office find a clash with one', adminOnArchived === null, adminOnArchived || '');
  reset();
  db.applications.push({ id: 902, student_id: 30, tutor_id: 29, subject_id: ENGLISH, time_slot: '7:00-8:00 AM', preferred_days: 'Weekdays', status: 'pending' });
  db.assignments.find((a) => a.subject_id === ENGLISH).is_archived = 1;
  ok('a request left over from a dropped subject holds nothing', (await getStudentHeldSessions(30)).length === 0);

  console.log('\n== only an approved, active tutor can be asked ==');
  reset();
  db.users[28].is_archived = 1;
  ok('an archived tutor is refused', (await refuse(() => createTutorScheduleRequest(30, MATH, 28, '9:00-10:00 AM', 'Weekdays'))) === 'Tutor not found.');
  reset();
  db.users[28].status = 'pending';
  ok('a tutor not yet approved is refused', (await refuse(() => createTutorScheduleRequest(30, MATH, 28, '9:00-10:00 AM', 'Weekdays'))) === 'Tutor not found.');
  reset();
  ok('a student is not a tutor', (await refuse(() => createTutorScheduleRequest(30, MATH, 30, '9:00-10:00 AM', 'Weekdays'))) === 'Tutor not found.');

  console.log('\n== a tutor\'s year levels survive either spelling ==');
  ok('the registration spelling is kept',
    normalizeTutorYearLevels(['Preschool', 'Senior High School']).join('|') === 'Preschool|Senior High School');
  ok('the student-form spelling is mapped, not dropped',
    normalizeTutorYearLevels(['Pre School Level', 'Primary Level', 'Junior High Level', 'Senior High Level']).join('|')
      === 'Preschool|Primary School|Junior High School|Senior High School');
  ok('anything else is still refused', normalizeTutorYearLevels(['College', '']).length === 0);
  ok('there are nine fixed slots', FIXED_TIME_SLOTS.length === 9, `${FIXED_TIME_SLOTS.length}`);

  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'Each subject has its own tutor and its own hour; the rest wait for their own choice — holds.'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message, e.stack); process.exit(1); });
