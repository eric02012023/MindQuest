/**
 * seed-branch-enrolments.js
 *
 * Adds more tutors and students to every active branch (5 and 10 by default),
 * then ENROLS every seeded account the way the office would:
 *
 *   tutors    get the subjects they teach, through the same save as the
 *             profile's "Manage subjects" dialog (updateUser)
 *   students  get 1-3 subjects through that same save — which creates the
 *             enrolments, opens the billing account and prices it at
 *             ₱1,800 per subject — and then a tutor and a time slot through
 *             the profile's "Tutor & schedule" save (setStudentTutorAndSchedule),
 *             which enforces one tutor per student and no double-booked slot.
 *
 * Only seeded accounts are touched: the "+" aliases of the given inbox, which is
 * the only thing marking them (their names are ordinary on purpose). Real
 * registrations are never read for changes, let alone written.
 *
 * It also repairs the first batch from scripts/seed-branch-accounts.js, which
 * was written without a year level (only "Grade 3", or "Kindergarten" — not an
 * option on the registration form), so tutors could never be matched to them.
 *
 * A subject a student has already REQUESTED is left out of what they are
 * enrolled in, so the pending request stays in the Notifications inbox to be
 * accepted by hand.
 *
 * Usage:
 *   node scripts/seed-branch-enrolments.js --email=you@gmail.com            (preview)
 *   node scripts/seed-branch-enrolments.js --email=you@gmail.com --commit   (writes)
 *   options: --tutors=5 --students=10 --password=MindQuest@2026
 *            --no-tutor   enrol the students but give none of them a tutor, so
 *                         the office assigns every one by hand (they show in
 *                         the "Needs a tutor" folder of User Management)
 *
 * Re-running is safe: accounts whose address exists are skipped, enrolled
 * students are not enrolled again, and a student who has a tutor keeps them.
 * scripts/remove-seeded-branch-accounts.js removes every seeded account and
 * everything attached to it, billing included.
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { query } = require('../config/db');
const { generateUserCode, safeJsonArray, safeJsonObject } = require('../lib/utils');
const {
  updateUser,
  getUserById,
  setStudentTutorAndSchedule,
  recalculateStudentBilling,
  normalizeTutorYearLevels,
  TUTOR_YEAR_LEVEL_OPTIONS,
  FIXED_TIME_SLOTS,
  syncAssistantRosters
} = require('../lib/data');

// ---------------------------------------------------------------- vocabulary
// The student registration form's levels and the grades under each.
const STUDENT_LEVELS = [
  { level: 'Pre School Level', grades: ['Kinder 1', 'Kinder 2'], tutorLevel: 'Preschool', baseAge: 4 },
  { level: 'Primary Level', grades: ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6'], tutorLevel: 'Primary School', baseAge: 6 },
  { level: 'Junior High Level', grades: ['Grade 7', 'Grade 8', 'Grade 9', 'Grade 10'], tutorLevel: 'Junior High School', baseAge: 12 },
  { level: 'Senior High Level', grades: ['Grade 11', 'Grade 12'], tutorLevel: 'Senior High School', baseAge: 16 }
];

// A second pool of ordinary names, so this batch does not re-use the first
// batch's pairings. Every generated name is also checked against the database.
const FIRST_NAMES = [
  ['Ramil', 'Male'], ['Precious', 'Female'], ['Arnel', 'Male'], ['Rhea', 'Female'],
  ['Jericho', 'Male'], ['Mylene', 'Female'], ['Noel', 'Male'], ['Kimberly', 'Female'],
  ['Renato', 'Male'], ['Joanna', 'Female'], ['Aldrin', 'Male'], ['Czarina', 'Female'],
  ['Marvin', 'Male'], ['Leah', 'Female'], ['Rodel', 'Male'], ['Hazel', 'Female'],
  ['Jayson', 'Male'], ['Frances', 'Female'], ['Allan', 'Male'], ['Divina', 'Female'],
  ['Ronald', 'Male'], ['Erica', 'Female'], ['Benedict', 'Male'], ['Stephanie', 'Female'],
  ['Cedric', 'Male'], ['Janine', 'Female'], ['Harold', 'Male'], ['Lorna', 'Female'],
  ['Gilbert', 'Male'], ['Aileen', 'Female'], ['Tristan', 'Male'], ['Maricel', 'Female'],
  ['Wilfredo', 'Male'], ['Pauline', 'Female'], ['Raymart', 'Male'], ['Gwen', 'Female'],
  ['Efren', 'Male'], ['Lovely', 'Female'], ['Joel', 'Male'], ['Rowena', 'Female'],
  ['Nestor', 'Male'], ['Cristina', 'Female'], ['Anthony', 'Male'], ['Jocelyn', 'Female']
];

const LAST_NAMES = [
  'Magbanua', 'Villareal', 'Dimaculangan', 'Buenaventura', 'Macapagal', 'Panganiban',
  'Lacson', 'Sison', 'Tan', 'Uy', 'Ong', 'Lim', 'Yap', 'Co', 'Gatchalian', 'Manalo',
  'Cabrera', 'Estrada', 'Aguilar', 'Montemayor', 'Dizon', 'Bernardo', 'Galang', 'Pineda',
  'Tolentino', 'Quiambao', 'Samonte', 'Bautista', 'Carpio', 'De Leon', 'Evangelista',
  'Fajardo', 'Guevara', 'Legaspi', 'Mangubat', 'Natividad', 'Obispo', 'Perez', 'Roxas',
  'Serrano', 'Tupas', 'Umali', 'Velasco', 'Yambao', 'Zulueta', 'Alcantara', 'Belmonte'
];

const BARANGAYS = [
  'Calumpang', 'Bawing', 'Fatima', 'Lagao', 'Labangal', 'Mabuhay', 'San Isidro',
  'Apopong', 'Katangawan', 'Conel', 'Tambler', 'Baluan', 'Buayan', 'Sinawal', 'Dadiangas'
];

// ---------------------------------------------------------------- arguments
function parseArgs(argv) {
  const args = {
    commit: false,
    email: process.env.SEED_BASE_EMAIL || '',
    password: 'MindQuest@2026',
    tutors: 5,
    students: 10,
    noTutor: false
  };
  for (const raw of argv) {
    if (raw === '--commit') args.commit = true;
    else if (raw === '--no-tutor') args.noTutor = true;
    else if (raw.startsWith('--email=')) args.email = raw.slice('--email='.length).trim();
    else if (raw.startsWith('--password=')) args.password = raw.slice('--password='.length);
    else if (raw.startsWith('--tutors=')) args.tutors = Math.max(0, Number(raw.slice(9)) || 0);
    else if (raw.startsWith('--students=')) args.students = Math.max(0, Number(raw.slice(11)) || 0);
  }
  return args;
}

const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
const aliasFor = (baseEmail, tag) => {
  const [local, domain] = String(baseEmail).split('@');
  return `${local}+${tag}@${domain}`.toLowerCase();
};
const contactNumber = (index) => `09${String(180000000 + index * 5113).slice(0, 9)}`;
const pad = (n) => String(n).padStart(2, '0');

/** Deterministic, so a preview and the commit that follows it agree. */
function pseudoRandom(n) {
  const x = Math.sin(n * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

/**
 * Retry a unit of work that lost a deadlock. Several students are written at
 * once and they share tables, so SQL Server may pick one as the victim (error
 * 1205); the work is a transaction that rolled back cleanly, so it is re-run.
 */
async function withDeadlockRetry(work, attempts = 4) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      const deadlock = Number(error?.number) === 1205 || /deadlock/i.test(String(error?.message || ''));
      if (!deadlock || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
}

// ---------------------------------------------------------------- levels
/** A seeded student's level, repairing the first batch's missing year level. */
function studentLevelFor(student) {
  const grade = String(student.grade_level || '').trim();
  if (/kinder/i.test(grade)) {
    const age = Number(student.age) || 5;
    return { level: 'Pre School Level', grade: /1/.test(grade) || age <= 4 ? 'Kinder 1' : 'Kinder 2' };
  }
  const found = STUDENT_LEVELS.find((entry) => entry.grades.includes(grade));
  if (found) return { level: found.level, grade };
  const byLevel = STUDENT_LEVELS.find((entry) => entry.level === student.year_level);
  if (byLevel) return { level: byLevel.level, grade: grade || byLevel.grades[0] };
  return { level: 'Primary Level', grade: 'Grade 1' };
}

const tutorLevelOf = (studentLevel) => STUDENT_LEVELS.find((entry) => entry.level === studentLevel)?.tutorLevel;

// ---------------------------------------------------------------- inserts
const runStamp = Date.now().toString(36);
let placeholderSequence = 0;

async function insertUser(account, passwordHash) {
  const result = await query(
    `INSERT INTO users (
       user_id, role, branch_id, password_hash, first_name, middle_name, last_name,
       birth_date, age, gender, contact_number, email, facebook_account, address,
       year_level, grade_level, parent_guardian_name, parent_contact_number, parent_email,
       parent_facebook, subjects_json, support_json, extra_json, status, is_archived
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 0)`,
    [
      `TMP-${runStamp}-${placeholderSequence++}`,
      account.role,
      Number(account.branchId),
      passwordHash,
      account.firstName,
      account.middleName,
      account.lastName,
      account.birthDate,
      Number(account.age),
      account.gender,
      account.contact,
      account.email,
      `https://facebook.com/${slug(account.firstName)}.${slug(account.lastName)}`,
      account.address,
      account.yearLevel,
      account.gradeLevel,
      account.parentName || '',
      account.parentContact || '',
      '',
      '',
      '[]',
      '[]',
      account.role === 'tutor'
        ? JSON.stringify({ year_levels: account.yearLevels, branch_ids: [Number(account.branchId)] })
        : '{}'
    ]
  );
  const newId = Number(result.insertId);
  await query('UPDATE users SET user_id = ? WHERE id = ?', [generateUserCode(account.role, newId), newId]);
  for (const level of account.yearLevels || []) {
    await query('INSERT INTO tutor_year_levels (tutor_id, year_level) VALUES (?, ?)', [newId, level]);
  }
  return newId;
}

/** Everything the "Manage subjects" dialog posts, with the subjects replaced. */
function manageSubjectsPayload(user, overrides, actorId) {
  return {
    first_name: user.first_name,
    middle_name: user.middle_name || '',
    last_name: user.last_name,
    birth_date: user.birth_date ? new Date(user.birth_date).toISOString().slice(0, 10) : null,
    age: user.age,
    gender: user.gender || '',
    contact_number: user.contact_number || '',
    email: user.email || '',
    facebook_account: user.facebook_account || '',
    address: user.address || '',
    year_level: user.year_level || '',
    grade_level: user.grade_level || '',
    parent_guardian_name: user.parent_guardian_name || '',
    parent_contact_number: user.parent_contact_number || '',
    parent_email: user.parent_email || '',
    parent_facebook: user.parent_facebook || '',
    supports: safeJsonArray(user.support_json || '[]'),
    branch_id: user.branch_id,
    updated_by: actorId,
    extra: {},
    ...overrides
  };
}

/** Run `work` over `items`, a few at a time — the database is remote and slow. */
async function inBatches(items, size, work) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(work));
  }
}

// ---------------------------------------------------------------- main
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.email || !args.email.includes('@')) {
    console.error('Pass the inbox the seeded accounts use, e.g. --email=you@gmail.com');
    process.exit(1);
  }
  const [local, domain] = args.email.toLowerCase().split('@');
  const aliasPattern = `${local}+%@${domain}`;

  const [branches, subjects, admins] = await Promise.all([
    query('SELECT id, name FROM branches WHERE is_archived = 0 ORDER BY id'),
    query('SELECT id, name FROM subjects WHERE is_archived = 0 ORDER BY id'),
    query("SELECT TOP 1 id, first_name, last_name, role FROM users WHERE role = 'admin' ORDER BY id")
  ]);
  const actor = admins[0];
  if (!branches.length || !subjects.length || !actor) {
    console.error('Need at least one active branch, one active subject and an admin account.');
    process.exit(1);
  }
  const subjectNames = subjects.map((s) => s.name);

  console.log(`Database : ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(`Branches : ${branches.map((b) => b.name).join(', ')}`);
  console.log(`Subjects : ${subjectNames.join(', ')}`);
  console.log(`Adding   : ${args.tutors} tutors + ${args.students} students per branch`);
  console.log(`Acting as: ${actor.first_name} ${actor.last_name} (admin #${actor.id})`);
  if (args.noTutor) console.log('Tutors   : none — students without one are left for the office to assign');
  console.log(`Mode     : ${args.commit ? 'COMMIT — rows will be written' : 'DRY RUN — nothing will be written'}\n`);

  // ------------------------------------------------------------ 1. accounts
  const takenNames = new Set((await query(
    "SELECT LOWER(first_name) + ' ' + LOWER(last_name) AS full_name FROM users WHERE role IN ('student','tutor')"
  )).map((row) => String(row.full_name).replace(/\s+/g, ' ').trim()));

  let nameCursor = 0;
  const nextPerson = () => {
    for (let guard = 0; guard < 5000; guard++) {
      const i = nameCursor++;
      const [firstName, gender] = FIRST_NAMES[i % FIRST_NAMES.length];
      const lastName = LAST_NAMES[(i * 7 + Math.floor(i / FIRST_NAMES.length)) % LAST_NAMES.length];
      const key = `${firstName} ${lastName}`.toLowerCase();
      if (takenNames.has(key)) continue;
      takenNames.add(key);
      const middleName = LAST_NAMES[(i * 11 + 3) % LAST_NAMES.length];
      return { firstName, middleName: middleName === lastName ? LAST_NAMES[(i + 1) % LAST_NAMES.length] : middleName, lastName, gender, index: i };
    }
    throw new Error('Ran out of unique names.');
  };

  const passwordHash = args.commit ? await bcrypt.hash(args.password, 10) : null;
  let created = 0;
  let skipped = 0;
  // In a preview nothing is inserted, so the new accounts are carried as
  // stand-ins and planned alongside the real ones — the preview then shows the
  // same tutor coverage and slot use the commit will produce.
  const previewAccounts = [];

  for (const branch of branches) {
    const branchTag = slug(branch.name).replace(/branch$/, '').slice(0, 8);
    // Continue the per-branch numbering after the accounts already there, so
    // this batch's addresses read like the first batch's and never collide.
    const existing = await query(
      'SELECT email FROM users WHERE LOWER(email) LIKE ? AND LOWER(email) LIKE ?',
      [aliasPattern, `%.${branchTag}%@${domain}`]
    );
    let position = existing.reduce((max, row) => {
      const match = String(row.email).match(new RegExp(`\\.${branchTag}(\\d+)@`));
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);

    const accounts = [];
    for (let t = 0; t < args.tutors; t++) {
      const person = nextPerson();
      const start = (branch.id + t) % TUTOR_YEAR_LEVEL_OPTIONS.length;
      // Two neighbouring levels, the way a tutor actually specialises.
      const levels = start === TUTOR_YEAR_LEVEL_OPTIONS.length - 1
        ? [TUTOR_YEAR_LEVEL_OPTIONS[start - 1], TUTOR_YEAR_LEVEL_OPTIONS[start]]
        : [TUTOR_YEAR_LEVEL_OPTIONS[start], TUTOR_YEAR_LEVEL_OPTIONS[start + 1]];
      const age = 23 + (person.index % 15);
      accounts.push({
        ...person, role: 'tutor', age, branchId: branch.id,
        birthDate: `${2026 - age}-${pad((person.index % 12) + 1)}-${pad((person.index % 27) + 1)}`,
        contact: contactNumber(person.index),
        address: `Purok ${(person.index % 7) + 1}, ${BARANGAYS[person.index % BARANGAYS.length]}, General Santos City`,
        yearLevel: levels.join(', '), yearLevels: levels, gradeLevel: ''
      });
    }
    for (let s = 0; s < args.students; s++) {
      const person = nextPerson();
      const levelEntry = STUDENT_LEVELS[(branch.id + s) % STUDENT_LEVELS.length];
      const grade = levelEntry.grades[(person.index + s) % levelEntry.grades.length];
      const age = levelEntry.baseAge + levelEntry.grades.indexOf(grade);
      const guardian = FIRST_NAMES[(person.index + 17) % FIRST_NAMES.length][0];
      accounts.push({
        ...person, role: 'student', age, branchId: branch.id,
        birthDate: `${2026 - age}-${pad((person.index % 12) + 1)}-${pad((person.index % 27) + 1)}`,
        contact: contactNumber(person.index + 700),
        address: `Purok ${(person.index % 7) + 1}, ${BARANGAYS[person.index % BARANGAYS.length]}, General Santos City`,
        yearLevel: levelEntry.level, yearLevels: [], gradeLevel: grade,
        parentName: `${guardian} ${person.lastName}`,
        parentContact: contactNumber(person.index + 1300)
      });
    }

    for (const account of accounts) {
      position += 1;
      account.email = aliasFor(args.email, `${slug(account.firstName)}${slug(account.lastName)}.${branchTag}${pad(position)}`);
      const exists = await query('SELECT TOP 1 id FROM users WHERE LOWER(email) = ?', [account.email]);
      if (exists.length) { skipped++; continue; }
      if (args.commit) await insertUser(account, passwordHash);
      else previewAccounts.push(account);
      created++;
    }
    console.log(`${branch.name}: ${args.commit ? 'created' : 'would create'} ${accounts.length} accounts`);
  }
  console.log(`\nAccounts ${args.commit ? 'created' : 'to create'}: ${created}${skipped ? ` (already present: ${skipped})` : ''}\n`);

  // ------------------------------------------------------------ 2. the seeded roster
  const seededRows = await query(
    `SELECT id FROM users
      WHERE LOWER(email) LIKE ? AND role IN ('student','tutor') AND is_archived = 0
      ORDER BY id`,
    [aliasPattern]
  );
  const seeded = [];
  for (const row of seededRows) seeded.push(await getUserById(row.id));
  previewAccounts.forEach((account, k) => seeded.push({
    id: -(k + 1),
    user_id: '(new)',
    role: account.role,
    branch_id: account.branchId,
    first_name: account.firstName,
    last_name: account.lastName,
    age: account.age,
    year_level: account.yearLevel,
    grade_level: account.gradeLevel,
    subjects_json: '[]',
    extra: account.role === 'tutor' ? { year_levels: account.yearLevels, branch_ids: [account.branchId] } : {}
  }));

  const activeRows = await query(
    `SELECT usa.student_id, usa.subject_id, usa.tutor_id, usa.time_slot
       FROM user_subject_assignments usa
      WHERE usa.is_archived = 0`
  );
  const pendingRows = await query(
    "SELECT student_id, subject_id FROM subject_enrollment_requests WHERE status = 'pending'"
  );
  const billedRows = await query('SELECT student_id FROM billing');
  const billed = new Set(billedRows.map((row) => Number(row.student_id)));

  const activeByStudent = new Map();
  for (const row of activeRows) {
    const list = activeByStudent.get(Number(row.student_id)) || [];
    list.push(row);
    activeByStudent.set(Number(row.student_id), list);
  }
  const pendingByStudent = new Map();
  for (const row of pendingRows) {
    const set = pendingByStudent.get(Number(row.student_id)) || new Set();
    set.add(Number(row.subject_id));
    pendingByStudent.set(Number(row.student_id), set);
  }
  // Every slot any tutor is already holding, real students included.
  const takenSlots = new Set(activeRows
    .filter((row) => row.tutor_id && row.time_slot)
    .map((row) => `${row.tutor_id}|${row.time_slot}`));

  // ------------------------------------------------------------ 3. tutors: subjects and levels
  const tutors = seeded.filter((u) => u.role === 'tutor');
  const tutorPlan = [];
  tutors.forEach((tutor, i) => {
    const levels = normalizeTutorYearLevels([tutor.year_level || '', ...safeJsonArray(tutor.extra?.year_levels || [])]);
    const currentSubjects = safeJsonArray(tutor.subjects_json || '[]');
    // Two or three subjects, rotated so each branch has every subject covered.
    const count = 2 + (i % 2);
    const subjectsToTeach = currentSubjects.length
      ? currentSubjects
      : Array.from({ length: count }, (_, k) => subjectNames[(i * 2 + k) % subjectNames.length]);
    const levelsToTeach = levels.length ? levels : ['Primary School', 'Junior High School'];
    const levelChanged = safeJsonArray(tutor.extra?.year_levels || []).join('|') !== levelsToTeach.join('|')
      || String(tutor.year_level || '') !== levelsToTeach.join(', ');
    tutorPlan.push({
      tutor,
      subjects: subjectsToTeach,
      levels: levelsToTeach,
      needsSave: !currentSubjects.length || levelChanged
    });
  });

  // ------------------------------------------------------------ 4. students: subjects, tutor, slot
  const students = seeded.filter((u) => u.role === 'student');
  const tutorsByBranch = new Map();
  for (const plan of tutorPlan) {
    const branchIds = [plan.tutor.branch_id, ...safeJsonArray(plan.tutor.extra?.branch_ids || [])].map(Number).filter(Boolean);
    for (const branchId of new Set(branchIds)) {
      const list = tutorsByBranch.get(branchId) || [];
      list.push(plan);
      tutorsByBranch.set(branchId, list);
    }
  }
  const load = new Map(); // tutor id -> students assigned in this run

  const studentPlan = [];
  students.forEach((student, i) => {
    const { level, grade } = studentLevelFor(student);
    const active = activeByStudent.get(Number(student.id)) || [];
    const pending = pendingByStudent.get(Number(student.id)) || new Set();
    const hasTutor = active.some((row) => row.tutor_id);
    const repairLevel = student.year_level !== level || student.grade_level !== grade;

    // A tutor from the student's branch who teaches their level and still has
    // a free slot — the least loaded one, so work spreads across the branch.
    let tutorChoice = null;
    let slot = null;
    if (!hasTutor && !args.noTutor) {
      const wantedLevel = tutorLevelOf(level);
      const candidates = (tutorsByBranch.get(Number(student.branch_id)) || [])
        .filter((plan) => plan.levels.includes(wantedLevel))
        .sort((a, b) => (load.get(a.tutor.id) || 0) - (load.get(b.tutor.id) || 0) || a.tutor.id - b.tutor.id);
      for (const plan of candidates) {
        // Start the search at a different slot per student, so a tutor's day
        // is spread out rather than every learner stacked from 7:00 AM.
        for (let k = 0; k < FIXED_TIME_SLOTS.length && !slot; k++) {
          const candidateSlot = FIXED_TIME_SLOTS[(k + i) % FIXED_TIME_SLOTS.length];
          if (!takenSlots.has(`${plan.tutor.id}|${candidateSlot}`)) slot = candidateSlot;
        }
        if (slot) {
          tutorChoice = plan;
          takenSlots.add(`${plan.tutor.id}|${slot}`);
          load.set(plan.tutor.id, (load.get(plan.tutor.id) || 0) + 1);
          break;
        }
      }
    }

    // Subjects: kept if they already have some; otherwise 1-3 of what their
    // tutor teaches, never one they have a request pending for.
    let subjectsToTake = null;
    if (!active.length) {
      const pool = (tutorChoice ? tutorChoice.subjects : subjectNames)
        .filter((name) => !pending.has(Number(subjects.find((s) => s.name === name)?.id)));
      const count = Math.min(pool.length, 1 + Math.floor(pseudoRandom(Math.abs(student.id) + i) * 3));
      subjectsToTake = Array.from({ length: Math.max(1, count) }, (_, k) => pool[(i + k) % pool.length]).filter(Boolean);
      subjectsToTake = [...new Set(subjectsToTake)];
      if (!subjectsToTake.length) subjectsToTake = [subjectNames[i % subjectNames.length]];
    }

    studentPlan.push({ student, level, grade, repairLevel, subjectsToTake, tutorChoice, slot,
      needsBilling: !billed.has(Number(student.id)), keepsSubjects: active.length > 0, hasTutor });
  });

  // ------------------------------------------------------------ report
  const toEnrol = studentPlan.filter((p) => p.subjectsToTake);
  const subjectTotal = toEnrol.reduce((sum, p) => sum + p.subjectsToTake.length, 0);
  console.log(`Seeded tutors : ${tutors.length} (${tutorPlan.filter((p) => p.needsSave).length} to give subjects / fix year levels)`);
  console.log(`Seeded students: ${students.length}`);
  console.log(`  to enrol           : ${toEnrol.length} (${subjectTotal} subject enrolments, ₱${(subjectTotal * 1800).toLocaleString()} billed at ₱1,800 each)`);
  console.log(`  already enrolled   : ${studentPlan.filter((p) => p.keepsSubjects).length} (kept as they are)`);
  console.log(`  year level repaired: ${studentPlan.filter((p) => p.repairLevel).length}`);
  console.log(`  tutor + slot to set: ${studentPlan.filter((p) => p.tutorChoice).length}`);
  console.log(`  left without tutor : ${studentPlan.filter((p) => !p.hasTutor && !p.tutorChoice).length}`);
  for (const branch of branches) {
    const inBranch = studentPlan.filter((p) => Number(p.student.branch_id) === Number(branch.id));
    const tutorsHere = (tutorsByBranch.get(Number(branch.id)) || []).length;
    console.log(`  ${branch.name.padEnd(18)} ${String(tutorsHere).padStart(2)} tutors, ${String(inBranch.length).padStart(2)} students`);
  }

  if (!args.commit) {
    console.log('\nSample:');
    studentPlan.slice(0, 6).forEach((p) => console.log(
      `  ${p.student.first_name} ${p.student.last_name} (${p.grade}) -> ${p.subjectsToTake ? p.subjectsToTake.join(', ') : '(keeps subjects)'}`
      + ` · ${p.tutorChoice ? `${p.tutorChoice.tutor.first_name} ${p.tutorChoice.tutor.last_name} @ ${p.slot}` : p.hasTutor ? '(has tutor)' : 'no tutor'}`
    ));
    console.log('\nRe-run with --commit to write all of this.');
    return;
  }

  // ------------------------------------------------------------ write: year levels
  // First, before any tutor is saved: saving a tutor re-checks every student
  // already assigned to them, and a student still carrying the first batch's
  // blank year level fails that check and loses their tutor.
  const problems = [];
  let repaired = 0;
  await inBatches(studentPlan.filter((p) => p.repairLevel), 4, async (plan) => {
    await query('UPDATE users SET year_level = ?, grade_level = ? WHERE id = ?', [plan.level, plan.grade, plan.student.id]);
    repaired++;
  });

  // ------------------------------------------------------------ write: tutors
  let tutorSaves = 0;
  await inBatches(tutorPlan.filter((p) => p.needsSave), 3, async (plan) => {
    try {
      await withDeadlockRetry(() => updateUser(plan.tutor.id, manageSubjectsPayload(plan.tutor, {
        subjects: plan.subjects,
        year_levels: plan.levels,
        year_level: plan.levels.join(', '),
        branch_ids: [plan.tutor.branch_id, ...safeJsonArray(plan.tutor.extra?.branch_ids || [])].map(Number).filter(Boolean),
        extra: safeJsonObject(plan.tutor.extra_json)
      }, actor.id)));
      tutorSaves++;
    } catch (error) {
      problems.push(`${plan.tutor.user_id} ${plan.tutor.first_name} ${plan.tutor.last_name}: ${error.message}`);
    }
  });
  console.log(`\nTutors saved: ${tutorSaves}`);

  // ------------------------------------------------------------ write: students
  let enrolled = 0;
  let tutored = 0;
  let billedNow = 0;
  let done = 0;
  await inBatches(studentPlan, 3, async (plan) => {
    const { student } = plan;
    try {
      if (plan.subjectsToTake) {
        // The Manage-subjects save: enrolments, the billing account and its
        // price, all in one transaction.
        await withDeadlockRetry(() => updateUser(student.id, manageSubjectsPayload(student, {
          year_level: plan.level,
          grade_level: plan.grade,
          subjects: plan.subjectsToTake
        }, actor.id)));
        enrolled++;
      } else {
        // Already enrolled: their subjects — and any request they have pending —
        // are theirs; the year level was repaired above.
        if (plan.needsBilling) {
          // Enrolled before anything opened a billing account for them (the
          // gap fixed in recalculateStudentBilling); open it, priced from what
          // they actually hold.
          const result = await recalculateStudentBilling(null, student.id, actor.id);
          if (result) billedNow++;
        }
      }
      if (plan.tutorChoice) {
        await withDeadlockRetry(() => setStudentTutorAndSchedule(
          student.id, { tutorId: plan.tutorChoice.tutor.id, timeSlot: plan.slot }, actor
        ));
        tutored++;
      }
    } catch (error) {
      problems.push(`${student.user_id} ${student.first_name} ${student.last_name}: ${error.message}`);
    }
    done++;
    if (done % 25 === 0) console.log(`  ... ${done}/${studentPlan.length} students`);
  });

  console.log(`Students enrolled: ${enrolled}`);
  console.log(`Year levels repaired: ${repaired}`);
  console.log(`Tutors assigned  : ${tutored}`);
  console.log(`Billing opened for already-enrolled students: ${billedNow}`);
  if (problems.length) {
    console.log(`\n${problems.length} could not be completed:`);
    problems.forEach((line) => console.log(`  ${line}`));
  }

  try {
    await syncAssistantRosters();
  } catch (error) {
    console.log(`(assistant rosters not updated: ${error.message} — they fill in when the new code starts)`);
  }
  if (created) console.log(`\nPassword for the new accounts: ${args.password}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Seeding failed:', error.message);
    process.exit(1);
  });
