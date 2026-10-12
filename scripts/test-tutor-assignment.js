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
 *   4. One tutor cannot hold one time slot for two students, and one student
 *      cannot be with two tutors at the same time.
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
      && Number(r.student_id) !== Number(exceptId) && overlaps(r.preferred_days, days));
  }
  // getBlockedSlotsForTutor — the tutor's other students
  if (/SELECT DISTINCT time_slot, preferred_days FROM user_subject_assignments WHERE tutor_id = \?/i.test(s)) {
    const [tutorId, exceptId] = params;
    return db.others.filter((r) => Number(r.tutor_id) === Number(tutorId) && Number(r.student_id) !== Number(exceptId))
      .map((r) => ({ time_slot: r.time_slot, preferred_days: r.preferred_days || null }));
  }
  // … open requests to that tutor
  if (/SELECT DISTINCT time_slot, preferred_days FROM tutor_schedule_applications/i.test(s)) {
    const [tutorId, exceptId] = params;
    return db.applications.filter((a) => Number(a.tutor_id) === Number(tutorId) && ['pending', 'accepted'].includes(a.status) && Number(a.student_id) !== Number(exceptId))
      .map((a) => ({ time_slot: a.time_slot, preferred_days: a.preferred_days || null }));
  }
  // … and the student's own time with OTHER tutors
  if (/SELECT DISTINCT time_slot, preferred_days FROM user_subject_assignments WHERE student_id = \?/i.test(s)) {
    const [, tutorId] = params;
    return active().filter((a) => a.tutor_id && a.time_slot && Number(a.tutor_id) !== Number(tutorId))
      .map((a) => ({ time_slot: a.time_slot, preferred_days: a.preferred_days || null }));
  }
  // the student's own waiting requests (create / accept / admin assign)
  if (/FROM tutor_schedule_applications WHERE student_id = \? AND status = 'pending'/i.test(s)) {
    const exceptId = /AND id <> \?/i.test(s) ? Number(params[1]) : null;
    return db.applications.filter((a) => Number(a.student_id) === Number(params[0]) && a.status === 'pending' && Number(a.id) !== exceptId)
      .map((a) => ({ id: a.id, tutor_id: a.tutor_id, time_slot: a.time_slot, preferred_days: a.preferred_days || null }));
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
  if (/SELECT TOP 1 id FROM tutor_schedule_applications WHERE tutor_id = \? AND time_slot = \? AND status = 'accepted'/i.test(s)) {
    return [];
  }
  if (/SELECT TOP 1 id FROM user_subject_assignments WHERE tutor_id = \? AND time_slot = \?/i.test(s)) {
    const [tutorId, slot, exceptId, days] = params;
    return db.others.filter((r) => Number(r.tutor_id) === Number(tutorId) && r.time_slot === slot
      && Number(r.student_id) !== Number(exceptId) && overlaps(r.preferred_days, days)).map(() => ({ id: 1 }));
  }
  // acceptance: is the student already with ANOTHER tutor then?
  if (/SELECT TOP 1 id FROM user_subject_assignments WHERE student_id = \? AND is_archived = 0 AND tutor_id IS NOT NULL AND tutor_id <> \? AND time_slot = \?/i.test(s)) {
    const [, tutorId, slot, days] = params;
    return active().filter((a) => a.tutor_id && Number(a.tutor_id) !== Number(tutorId) && a.time_slot === slot
      && overlaps(a.preferred_days, days)).map((a) => ({ id: a.id }));
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
  // keepCurrentTutorForSubject: one enrolment joins the kept tutor's sessions
  if (/^UPDATE user_subject_assignments SET tutor_id = \?, time_slot = \?, preferred_days = \?, assigned_at = .* WHERE id = \?$/i.test(s)) {
    const [tutorId, slot, days, id] = params;
    const row = active().find((a) => Number(a.id) === Number(id));
    if (row) { row.tutor_id = tutorId; row.time_slot = slot; row.preferred_days = days || null; }
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
  createTutorScheduleApplicationForAllSubjects, acceptTutorScheduleApplication, cancelTutorScheduleApplication,
  normalizeTutorYearLevels, tutorTeachesSubject, repairNameList,
  getBlockedSlotsForTutor, slotKey, normalizePreferredDays, daysOverlap, keepCurrentTutorForSubject
} = require('../lib/data');

const refuse = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
const tutorOf = (subjectId) => active().find((a) => a.subject_id === subjectId).tutor_id;

(async () => {
  console.log('\n== a tutor is written only to the subjects they teach ==');
  reset();
  const result = await setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '2:00-3:00 PM' }, { id: 1, role: 'admin' });
  ok('Math goes to the Math tutor', Number(tutorOf(1)) === 28);
  ok('Filipino goes to them too (they teach it)', Number(tutorOf(6)) === 28);
  ok('English is NOT given to a tutor who does not teach it', tutorOf(4) === null, String(tutorOf(4)));
  ok('it reports the subjects it set', result.subjectsUpdated === 2 && result.subjectNames.length === 2, JSON.stringify(result.subjectNames));
  ok('and the subject left for another tutor', result.skippedSubjects.join() === SUBJECTS[4], JSON.stringify(result.skippedSubjects));

  console.log('\n== the open subject gets its own tutor ==');
  const english = await setStudentTutorAndSchedule(30, { tutorId: 29, timeSlot: '3:00-4:00 PM', subjectIds: [4] }, { id: 1, role: 'admin' });
  ok('English now has the English tutor', Number(tutorOf(4)) === 29);
  ok('the other subjects keep theirs', Number(tutorOf(1)) === 28 && Number(tutorOf(6)) === 28);
  ok('one subject was set', english.subjectsUpdated === 1);

  console.log('\n== naming a subject the tutor does not teach is refused ==');
  const wrong = await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 29, timeSlot: '5:00-6:00 PM', subjectIds: [1] }, { id: 1 }));
  ok('refused', wrong !== null, wrong || 'it went through');
  ok('and says which subject', /does not teach MATHEMATICS/.test(wrong || ''), wrong || '');
  ok('nothing changed', Number(tutorOf(1)) === 28);

  reset();
  const none = await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 29, timeSlot: '', subjectIds: [1, 6] }, { id: 1 }));
  ok('a tutor who teaches none of them is refused', /does not teach/.test(none || ''), none || 'went through');

  console.log('\n== a damaged subject list still counts ==');
  ok('fragments read back as names', repairNameList(['["MATHEMATICS (BASIC TO ADVANCE)"', '"ENGLISH"]']).join('|') === `${SUBJECTS[1]}|ENGLISH`);
  ok('the tutor still teaches Math', tutorTeachesSubject({ subjects_json: db.users[31].subjects_json }, SUBJECTS[1]));
  ok('an archived subject does not count',
    !tutorTeachesSubject({ subjects: [SUBJECTS[1]], extra: { archived_subjects: [SUBJECTS[1]] } }, SUBJECTS[1]));

  console.log('\n== clearing a tutor clears that subject\'s schedule ==');
  reset();
  await setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '2:00-3:00 PM' }, { id: 1, role: 'admin' });
  await setStudentTutorAndSchedule(30, { tutorId: '', timeSlot: '', subjectIds: [1] }, { id: 1, role: 'admin' });
  ok('Math has no tutor', tutorOf(1) === null);
  ok('and no orphan slot', active().find((a) => a.subject_id === 1).time_slot === null);
  ok('Filipino keeps its tutor', Number(tutorOf(6)) === 28);

  console.log('\n== nobody is double-booked ==');
  reset();
  db.others = [{ tutor_id: 28, time_slot: '3:00-4:00 PM', student_id: 99, first_name: 'Other', last_name: 'Learner' }];
  const clash = await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '3:00-4:00 PM' }, { id: 1 }));
  ok('the tutor\'s taken slot is refused', /Other Learner/.test(clash || ''), clash || 'went through');
  reset();
  await setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '9:00-10:00 AM' }, { id: 1 });
  const twoPlaces = await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 29, timeSlot: '9:00-10:00 AM', subjectIds: [4] }, { id: 1 }));
  ok('a student cannot have two tutors at the same time', /already has/.test(twoPlaces || ''), twoPlaces || 'went through');

  console.log('\n== the inputs are checked ==');
  reset();
  ok('an unknown time slot is refused',
    (await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '4am-ish' }, { id: 1 }))) !== null);
  ok('a tutor from another branch is refused',
    (await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 10, timeSlot: '2:00-3:00 PM' }, { id: 1 }))) !== null);
  reset();
  ok('a tutor who serves this branch as a SECOND branch is allowed',
    (await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 11, timeSlot: '2:00-3:00 PM' }, { id: 1 }))) === null);
  reset();
  ok('assigning a student as a tutor is refused',
    (await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 30, timeSlot: '2:00-3:00 PM' }, { id: 1 }))) !== null);

  console.log('\n== the student asks only for subjects with no tutor ==');
  reset();
  await setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '2:00-3:00 PM' }, { id: 1, role: 'admin' });
  ok('the student has a tutor on record', (await getAssignedTutorFor(30)) !== null);
  const forEnglish = await createTutorScheduleApplicationForAllSubjects(30, 29, '5:00-6:00 PM');
  ok('they can still ask for English', forEnglish && forEnglish.subjects.join() === SUBJECTS[4], JSON.stringify(forEnglish));
  const notTeaching = await refuse(() => createTutorScheduleApplicationForAllSubjects(30, 28, '6:00-7:00 PM'));
  ok('asking the Math tutor for English is refused', /does not teach ENGLISH/.test(notTeaching || ''), notTeaching || '');

  console.log('\n== accepting assigns only what the tutor teaches ==');
  const request = db.applications.find((a) => a.tutor_id === 29);
  const accepted = await acceptTutorScheduleApplication(request.id, 29);
  ok('English is now the English tutor\'s', Number(tutorOf(4)) === 29);
  ok('Math and Filipino were not touched', Number(tutorOf(1)) === 28 && Number(tutorOf(6)) === 28);
  ok('the acceptance names the subject', accepted.subjects.join() === SUBJECTS[4]);

  console.log('\n== once every subject has a tutor, only the office can change it ==');
  const locked = await refuse(() => createTutorScheduleApplicationForAllSubjects(30, 29, '7:00-8:00 AM'));
  ok('the request is refused', locked === TUTOR_LOCKED_MESSAGE, locked || 'went through');
  ok('and says an admin must do it', /Only an admin/.test(locked || ''));

  console.log('\n== weekdays and the weekend are separate sessions ==');
  reset();
  // Ana already teaches another student at 1:00 PM on WEEKDAYS.
  db.others = [{ tutor_id: 28, time_slot: '1:00-2:00 PM', preferred_days: 'Weekdays', student_id: 99, first_name: 'Other', last_name: 'Learner' }];
  const blocked = await getBlockedSlotsForTutor(28, 30);
  ok('the weekday slot is blocked', blocked.has(slotKey('Weekdays', '1:00-2:00 PM')));
  ok('the same slot on the weekend is free', !blocked.has(slotKey('Weekend', '1:00-2:00 PM')));
  const weekend = await refuse(() => createTutorScheduleApplicationForAllSubjects(30, 28, '1:00-2:00 PM', { preferredDays: 'Weekend', subjectIds: [1] }));
  ok('a weekend request at that time goes through', weekend === null, weekend || '');
  ok('the request records the days', db.applications.some((a) => a.preferred_days === 'Weekend'));
  reset();
  db.others = [{ tutor_id: 28, time_slot: '1:00-2:00 PM', preferred_days: 'Weekdays', student_id: 99, first_name: 'Other', last_name: 'Learner' }];
  const weekday = await refuse(() => createTutorScheduleApplicationForAllSubjects(30, 28, '1:00-2:00 PM', { preferredDays: 'Weekdays', subjectIds: [1] }));
  ok('a weekday request at that time is refused', /no longer available/.test(weekday || ''), weekday || 'went through');
  reset();
  db.others = [{ tutor_id: 28, time_slot: '1:00-2:00 PM', preferred_days: null, student_id: 99, first_name: 'Other', last_name: 'Learner' }];
  const unset = await getBlockedSlotsForTutor(28, 30);
  ok('an enrolment with no days chosen blocks BOTH',
    unset.has(slotKey('Weekdays', '1:00-2:00 PM')) && unset.has(slotKey('Weekend', '1:00-2:00 PM')));
  ok('the days helper reads either spelling', normalizePreferredDays('weekends') === 'Weekend' && normalizePreferredDays('Weekday') === 'Weekdays');
  ok('"not set" overlaps both', daysOverlap(null, 'Weekend') && daysOverlap('Weekdays', '') && !daysOverlap('Weekdays', 'Weekend'));

  console.log('\n== the admin can book the same slot on the other days ==');
  reset();
  db.others = [{ tutor_id: 28, time_slot: '3:00-4:00 PM', preferred_days: 'Weekdays', student_id: 99, first_name: 'Other', last_name: 'Learner' }];
  const adminWeekend = await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '3:00-4:00 PM', preferredDays: 'Weekend' }, { id: 1 }));
  ok('allowed on the weekend', adminWeekend === null, adminWeekend || '');
  ok('and the days are written', active().filter((a) => a.tutor_id === 28).every((a) => a.preferred_days === 'Weekend'));
  reset();
  db.others = [{ tutor_id: 28, time_slot: '3:00-4:00 PM', preferred_days: 'Weekdays', student_id: 99, first_name: 'Other', last_name: 'Learner' }];
  const adminWeekday = await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '3:00-4:00 PM', preferredDays: 'Weekdays' }, { id: 1 }));
  ok('refused on weekdays', /Other Learner/.test(adminWeekday || ''), adminWeekday || 'went through');

  console.log('\n== one request per subject; several subjects at once ==');
  reset();
  const first = await createTutorScheduleApplicationForAllSubjects(30, 28, '9:00-10:00 AM', { preferredDays: 'Weekdays', subjectIds: [1] });
  ok('Math (and Filipino) asked of Ana', first.subjects.length === 2, JSON.stringify(first));
  const second = await refuse(() => createTutorScheduleApplicationForAllSubjects(30, 29, '2:00-3:00 PM', { preferredDays: 'Weekdays', subjectIds: [4] }));
  ok('English can be asked of Ben at the same time', second === null, second || '');
  const again = await refuse(() => createTutorScheduleApplicationForAllSubjects(30, 28, '5:00-6:00 PM', { preferredDays: 'Weekend', subjectIds: [6] }));
  ok('asking Ana twice is refused', /already asked/.test(again || ''), again || 'went through');
  reset();
  await createTutorScheduleApplicationForAllSubjects(30, 28, '9:00-10:00 AM', { preferredDays: 'Weekdays', subjectIds: [1] });
  const sameTime = await refuse(() => createTutorScheduleApplicationForAllSubjects(30, 29, '9:00-10:00 AM', { preferredDays: 'Weekdays', subjectIds: [4] }));
  ok('two tutors at the same time are refused', /same time|that time/.test(sameTime || ''), sameTime || 'went through');

  console.log('\n== declining a request takes nothing else away ==');
  reset();
  await setStudentTutorAndSchedule(30, { tutorId: 29, timeSlot: '7:00-8:00 AM', preferredDays: 'Weekdays', subjectIds: [4] }, { id: 1 });
  await createTutorScheduleApplicationForAllSubjects(30, 28, '11:00-12:00 PM', { preferredDays: 'Weekdays', subjectIds: [1] });
  const pending = db.applications.find((a) => a.tutor_id === 28 && a.status === 'pending');
  await cancelTutorScheduleApplication(pending.id, 28);
  ok('the request is closed', pending.status === 'cancelled');
  ok('English keeps its tutor', Number(tutorOf(4)) === 29);

  console.log('\n== keeping a current tutor for a new subject ==');
  reset();
  await setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '2:00-3:00 PM', preferredDays: 'Weekend', subjectIds: [1] }, { id: 1 });
  const kept = await keepCurrentTutorForSubject(30, 6, 28);
  ok('Filipino joins Ana\'s sessions', Number(tutorOf(6)) === 28);
  ok('at the same time and days', kept.timeSlot === '2:00-3:00 PM' && kept.preferredDays === 'Weekend', JSON.stringify(kept));
  const notTheirs = await refuse(() => keepCurrentTutorForSubject(30, 4, 28));
  ok('a tutor who does not teach it cannot be kept for it', /does not teach/.test(notTheirs || ''), notTheirs || 'went through');
  const stranger = await refuse(() => keepCurrentTutorForSubject(30, 4, 29));
  ok('only a CURRENT tutor can be kept', /not one of your current tutors/.test(stranger || ''), stranger || 'went through');

  console.log('\n== a tutor\'s year levels survive either spelling ==');
  ok('the registration spelling is kept',
    normalizeTutorYearLevels(['Preschool', 'Senior High School']).join('|') === 'Preschool|Senior High School');
  ok('the student-form spelling is mapped, not dropped',
    normalizeTutorYearLevels(['Pre School Level', 'Primary Level', 'Junior High Level', 'Senior High Level']).join('|')
      === 'Preschool|Primary School|Junior High School|Senior High School');
  ok('anything else is still refused', normalizeTutorYearLevels(['College', '']).length === 0);
  ok('there are nine fixed slots', FIXED_TIME_SLOTS.length === 9, `${FIXED_TIME_SLOTS.length}`);

  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'A tutor teaches only their own subjects; the rest wait for another — holds.'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message, e.stack); process.exit(1); });
