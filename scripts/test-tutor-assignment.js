/**
 * File: scripts/test-tutor-assignment.js
 * Purpose: Pin down Phase 5 — ONE tutor per student, and a schedule only an
 *          admin can change.
 *
 * Run:  node scripts/test-tutor-assignment.js      (needs no database, no keys)
 *
 * WHY THIS EXISTS
 * Three rules that are easy to state and easy to half-implement:
 *
 *   1. Changing a student's tutor changes it for EVERY subject they hold. The
 *      obvious implementation updates the subject the admin was looking at,
 *      which is exactly how a student ends up with three tutors and a timetable
 *      nobody can run.
 *   2. The student may not change their own tutor or schedule once it is set.
 *      The pre-existing guard read tutor_schedule_applications — so a student
 *      whose tutor an ADMIN had assigned had no accepted application row and
 *      walked straight through it. The guard has to read the assignments.
 *   3. One tutor cannot hold one time slot for two students.
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
const db = {
  users: {
    30: { id: 30, role: 'student', branch_id: 2, first_name: 'Jordan', last_name: 'Lee' },
    28: { id: 28, role: 'tutor', branch_id: 2, first_name: 'Ana', last_name: 'Cruz', extra: {} },
    10: { id: 10, role: 'tutor', branch_id: 1, first_name: 'Ben', last_name: 'Santos', extra: {} },
    11: { id: 11, role: 'tutor', branch_id: 9, first_name: 'Multi', last_name: 'Branch', extra: { branch_ids: [2, 9] } }
  },
  // Three subjects, deliberately with DIFFERENT tutors to start with.
  assignments: [
    { id: 1, student_id: 30, subject_id: 1, tutor_id: 28, time_slot: '9:00-10:00 AM', is_archived: 0 },
    { id: 2, student_id: 30, subject_id: 4, tutor_id: 10, time_slot: '1:00-2:00 PM', is_archived: 0 },
    { id: 3, student_id: 30, subject_id: 6, tutor_id: null, time_slot: null, is_archived: 0 }
  ],
  otherStudentSlots: [],   // [{tutor_id, time_slot, student_id, first_name, last_name}]
  applications: [],
  cancelled: 0
};

const dbPath = require.resolve('../config/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    sql: {}, baseConfig: {},
    getPool: async () => { throw new Error('the test must never open a connection'); },
    query: async (text, params = []) => runSql(text, params),
    withTransaction: async (work) => work({
      query: async (text, params = []) => [await runSql(text, params)]
    })
  }
};

function active() { return db.assignments.filter((a) => !a.is_archived); }

async function runSql(text, params = []) {
  const s = String(text).replace(/\s+/g, ' ').trim();

  // getUserById
  if (/FROM users/i.test(s) && /WHERE u\.id = \?|WHERE id = \?/i.test(s)) {
    const u = db.users[Number(params[0])];
    return u ? [{ ...u, extra_json: JSON.stringify(u.extra || {}) }] : [];
  }
  // getAssignedTutorFor
  if (/INNER JOIN users u ON u\.id = usa\.tutor_id/i.test(s)) {
    const hit = active().find((a) => a.tutor_id);
    if (!hit) return [];
    const t = db.users[hit.tutor_id];
    return [{ tutor_id: hit.tutor_id, time_slot: hit.time_slot, first_name: t.first_name, last_name: t.last_name, middle_name: '' }];
  }
  // the active-subject count
  if (/SELECT id FROM user_subject_assignments WHERE student_id = \? AND is_archived = 0/i.test(s)) {
    return active().map((a) => ({ id: a.id }));
  }
  // slot clash against ANOTHER student — the `student_id <> ?` in the real
  // query is honoured here, or the test could not tell a genuine double-booking
  // apart from the student's own existing slot.
  if (/usa\.student_id <> \?/i.test(s)) {
    const [tutorId, slot, exceptStudentId] = params;
    return db.otherStudentSlots
      .filter((r) => Number(r.tutor_id) === Number(tutorId)
        && r.time_slot === slot
        && Number(r.student_id) !== Number(exceptStudentId))
      .map((r) => ({ student_id: r.student_id, first_name: r.first_name, last_name: r.last_name }));
  }
  // the write
  if (/^UPDATE user_subject_assignments/i.test(s)) {
    const clearing = /tutor_id = NULL/i.test(s);
    for (const a of active()) {
      a.tutor_id = clearing ? null : params[0];
      a.time_slot = clearing ? null : params[1];
    }
    return [];
  }
  if (/^UPDATE tutor_schedule_applications/i.test(s)) { db.cancelled++; return []; }
  if (/FROM tutor_schedule_applications/i.test(s)) return db.applications;
  return [];
}

const {
  setStudentTutorAndSchedule, getAssignedTutorFor, FIXED_TIME_SLOTS, TUTOR_LOCKED_MESSAGE,
  createTutorScheduleApplicationForAllSubjects, normalizeTutorYearLevels
} = require('../lib/data');

const reset = () => {
  db.assignments = [
    { id: 1, student_id: 30, subject_id: 1, tutor_id: 28, time_slot: '9:00-10:00 AM', is_archived: 0 },
    { id: 2, student_id: 30, subject_id: 4, tutor_id: 10, time_slot: '1:00-2:00 PM', is_archived: 0 },
    { id: 3, student_id: 30, subject_id: 6, tutor_id: null, time_slot: null, is_archived: 0 }
  ];
  db.otherStudentSlots = [];
  db.applications = [];
  db.cancelled = 0;
};

const refuse = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

(async () => {
  console.log('\n== the starting state really is inconsistent ==');
  reset();
  ok('three subjects with two different tutors and one unassigned',
    new Set(active().map((a) => String(a.tutor_id))).size === 3);

  console.log('\n== assigning a tutor applies it to EVERY subject ==');
  reset();
  const result = await setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '2:00-3:00 PM' }, { id: 1, role: 'admin' });
  ok('every subject now has the same tutor',
    active().every((a) => Number(a.tutor_id) === 28), active().map((a) => a.tutor_id).join(','));
  ok('including the one that had no tutor at all',
    Number(active().find((a) => a.id === 3).tutor_id) === 28);
  ok('and the one that had a DIFFERENT tutor',
    Number(active().find((a) => a.id === 2).tutor_id) === 28);
  ok('every subject shares the one schedule',
    active().every((a) => a.time_slot === '2:00-3:00 PM'));
  ok('it reports how many subjects it touched', result.subjectsUpdated === 3, `${result.subjectsUpdated}`);
  ok('a student can never hold two tutors afterwards',
    new Set(active().map((a) => String(a.tutor_id))).size === 1);

  console.log('\n== clearing the tutor clears the schedule with it ==');
  reset();
  await setStudentTutorAndSchedule(30, { tutorId: '', timeSlot: '' }, { id: 1, role: 'admin' });
  ok('no tutor left', active().every((a) => a.tutor_id === null));
  ok('no orphan time slot left', active().every((a) => a.time_slot === null));

  console.log('\n== a tutor cannot be double-booked ==');
  reset();
  db.otherStudentSlots = [{ tutor_id: 28, time_slot: '3:00-4:00 PM', student_id: 99, first_name: 'Other', last_name: 'Learner' }];
  const clash = await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '3:00-4:00 PM' }, { id: 1 }));
  ok('the clashing slot is refused', clash !== null, clash || 'it went through');
  ok('and the refusal names who has it', /Other Learner/.test(clash || ''), clash || '');
  ok('nothing was written', active().some((a) => Number(a.tutor_id) === 10));

  reset();
  db.otherStudentSlots = [{ tutor_id: 28, time_slot: '3:00-4:00 PM', student_id: 30, first_name: 'Jordan', last_name: 'Lee' }];
  const ownSlot = await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '3:00-4:00 PM' }, { id: 1 }));
  ok("the student's OWN existing slot is not a clash", ownSlot === null, ownSlot || '');

  console.log('\n== the inputs are checked ==');
  reset();
  ok('an unknown time slot is refused',
    (await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '4am-ish' }, { id: 1 }))) !== null);
  ok('a tutor from another branch is refused',
    (await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 10, timeSlot: '2:00-3:00 PM' }, { id: 1 }))) !== null);
  reset();
  ok('a tutor who teaches at this branch as a SECOND branch is allowed',
    (await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 11, timeSlot: '2:00-3:00 PM' }, { id: 1 }))) === null);
  reset();
  ok('assigning a student as a tutor is refused',
    (await refuse(() => setStudentTutorAndSchedule(30, { tutorId: 30, timeSlot: '2:00-3:00 PM' }, { id: 1 }))) !== null);

  console.log('\n== the student cannot change what the admin set ==');
  reset();
  // Admin assigns — note this leaves NO accepted application row, which is the
  // case the old guard missed entirely.
  await setStudentTutorAndSchedule(30, { tutorId: 28, timeSlot: '2:00-3:00 PM' }, { id: 1, role: 'admin' });
  ok('the student now has a tutor on record', (await getAssignedTutorFor(30)) !== null);
  ok('there is no accepted application backing it', db.applications.length === 0);

  // A same-branch tutor and a free slot: everything ELSE about this request is
  // valid, so only the tutor lock can be what refuses it.
  const blocked = await refuse(() => createTutorScheduleApplicationForAllSubjects(30, 28, '5:00-6:00 PM'));
  ok('the student-side apply is refused', blocked !== null, blocked || 'it went through');
  ok('and says an admin must do it', blocked === TUTOR_LOCKED_MESSAGE, blocked || '');
  ok('the tutor is unchanged', active().every((a) => Number(a.tutor_id) === 28));
  ok('the schedule is unchanged', active().every((a) => a.time_slot === '2:00-3:00 PM'));

  console.log('\n== a student with no tutor yet can still apply ==');
  reset();
  await setStudentTutorAndSchedule(30, { tutorId: '', timeSlot: '' }, { id: 1, role: 'admin' });
  ok('no tutor on record', (await getAssignedTutorFor(30)) === null);
  const allowed = await refuse(() => createTutorScheduleApplicationForAllSubjects(30, 28, '5:00-6:00 PM'));
  ok('the apply is NOT blocked by the tutor lock',
    allowed === null || !/Only an admin/.test(allowed), allowed || 'allowed');

  console.log('\n== a tutor\'s year levels survive either spelling ==');
  // Tutors register with "Preschool / Primary School / ...". The admin profile
  // editor used to offer the student form's "Pre School Level / Primary Level",
  // which the normaliser dropped — so saving a tutor emptied their levels.
  ok('the registration spelling is kept',
    normalizeTutorYearLevels(['Preschool', 'Senior High School']).join('|') === 'Preschool|Senior High School');
  ok('the student-form spelling is mapped, not dropped',
    normalizeTutorYearLevels(['Pre School Level', 'Primary Level', 'Junior High Level', 'Senior High Level']).join('|')
      === 'Preschool|Primary School|Junior High School|Senior High School');
  ok('a stored comma list is split and de-duplicated',
    normalizeTutorYearLevels('Primary School, Primary Level, Junior High School').join('|') === 'Primary School|Junior High School');
  ok('anything else is still refused', normalizeTutorYearLevels(['College', '']).length === 0);

  console.log('\n== the slots offered are the centre\'s own ==');
  ok('there are nine fixed slots', FIXED_TIME_SLOTS.length === 9, `${FIXED_TIME_SLOTS.length}`);
  ok('the lock message tells the student what to do', /Only an admin/.test(TUTOR_LOCKED_MESSAGE));

  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'One tutor per student, admin-only schedule — holds.'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message, e.stack); process.exit(1); });
