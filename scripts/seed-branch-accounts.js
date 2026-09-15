/**
 * seed-branch-accounts.js
 *
 * Creates 10 tutor and 30 student accounts for every active branch so the
 * system can be demonstrated with a populated roster.
 *
 * Every account is approved on creation, so it can log in immediately without
 * going through the admin approval queue.
 *
 * All addresses are "+" aliases of one real inbox (Gmail and most providers
 * ignore everything after the "+"), so every account can actually receive its
 * login OTP while the codes all land in a single mailbox. That shared prefix is
 * also the only marker these rows carry — the names themselves are ordinary —
 * so it is what to match on if they ever need to be found again.
 *
 * Usage:
 *   node scripts/seed-branch-accounts.js --email=you@gmail.com            (preview)
 *   node scripts/seed-branch-accounts.js --email=you@gmail.com --commit   (writes)
 *
 * Without --commit nothing is written: it reports what it would create.
 * Re-running skips any account whose address already exists, so an interrupted
 * run can simply be run again.
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { query } = require('../config/db');
const { generateUserCode } = require('../lib/utils');

const TUTORS_PER_BRANCH = 10;
const STUDENTS_PER_BRANCH = 30;
const TUTOR_YEAR_LEVELS = ['Preschool', 'Primary School', 'Junior High School', 'Senior High School'];
const GRADE_LEVELS = [
  'Kindergarten', 'Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6',
  'Grade 7', 'Grade 8', 'Grade 9', 'Grade 10', 'Grade 11', 'Grade 12'
];

const FIRST_NAMES = [
  ['Juan', 'Male'], ['Maria', 'Female'], ['Jose', 'Male'], ['Ana', 'Female'],
  ['Mark', 'Male'], ['Sofia', 'Female'], ['Paolo', 'Male'], ['Isabel', 'Female'],
  ['Carlo', 'Male'], ['Camille', 'Female'], ['Miguel', 'Male'], ['Angelica', 'Female'],
  ['Rafael', 'Male'], ['Patricia', 'Female'], ['Andres', 'Male'], ['Kristine', 'Female'],
  ['Emilio', 'Male'], ['Danica', 'Female'], ['Ramon', 'Male'], ['Rosario', 'Female'],
  ['Nathaniel', 'Male'], ['Beatriz', 'Female'], ['Christian', 'Male'], ['Clarisse', 'Female'],
  ['Joshua', 'Male'], ['Jasmine', 'Female'], ['Daniel', 'Male'], ['Michelle', 'Female'],
  ['Gabriel', 'Male'], ['Bernadette', 'Female'], ['Francis', 'Male'], ['Katrina', 'Female'],
  ['Vicente', 'Male'], ['Lourdes', 'Female'], ['Jerome', 'Male'], ['Margarita', 'Female'],
  ['Lorenzo', 'Male'], ['Veronica', 'Female'], ['Adrian', 'Male'], ['Trisha', 'Female'],
  ['Kevin', 'Male'], ['Althea', 'Female'], ['Dominic', 'Male'], ['Charmaine', 'Female'],
  ['Elijah', 'Male'], ['Nicole', 'Female'], ['Sebastian', 'Male'], ['Shaira', 'Female'],
  ['Enrique', 'Male'], ['Marianne', 'Female']
];

const LAST_NAMES = [
  'Dela Cruz', 'Santos', 'Reyes', 'Ramos', 'Mercado', 'Bautista', 'Villanueva', 'Gonzales',
  'Aquino', 'Castillo', 'Navarro', 'Salazar', 'Domingo', 'Fernandez', 'Torres', 'Rivera',
  'Alvarez', 'Mendoza', 'Cruz', 'Flores', 'Padilla', 'Sarmiento', 'Abella', 'Espinosa',
  'Gallardo', 'Hernandez', 'Ignacio', 'Jimenez', 'Lazaro', 'Macaraeg', 'Nolasco', 'Ocampo',
  'Pascual', 'Quijano', 'Rosales', 'Soriano', 'Tolentino', 'Urbano', 'Valdez', 'Zamora'
];

const BARANGAYS = [
  'Calumpang', 'Bawing', 'Fatima', 'Lagao', 'Labangal', 'Mabuhay', 'San Isidro',
  'Apopong', 'Katangawan', 'Conel', 'Tambler', 'Baluan', 'Buayan', 'Sinawal'
];

function parseArgs(argv) {
  const args = { commit: false, email: process.env.SEED_BASE_EMAIL || '', password: 'MindQuest@2026' };
  for (const raw of argv) {
    if (raw === '--commit') args.commit = true;
    else if (raw.startsWith('--email=')) args.email = raw.slice('--email='.length).trim();
    else if (raw.startsWith('--password=')) args.password = raw.slice('--password='.length);
  }
  return args;
}

function aliasFor(baseEmail, tag) {
  const [local, domain] = String(baseEmail).split('@');
  return `${local}+${tag}@${domain}`.toLowerCase();
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The first-name list has 50 entries and the surname list 40, and 13 is coprime
 * with 40, so walking `index` produces 200 distinct full names before any pair
 * repeats — more than the 40 accounts a branch needs.
 */
function personAt(index) {
  const [firstName, gender] = FIRST_NAMES[index % FIRST_NAMES.length];
  const lastName = LAST_NAMES[(index * 13) % LAST_NAMES.length];
  const middleName = LAST_NAMES[(index * 7 + 5) % LAST_NAMES.length];
  return { firstName, middleName, lastName, gender };
}

function contactNumber(index) {
  return `09${String(170000000 + index * 4637).slice(0, 9)}`;
}

function buildTutor(index, branch) {
  const person = personAt(index);
  const age = 22 + (index % 14);
  const levels = [
    TUTOR_YEAR_LEVELS[index % TUTOR_YEAR_LEVELS.length],
    TUTOR_YEAR_LEVELS[(index + 1) % TUTOR_YEAR_LEVELS.length]
  ];
  return {
    ...person,
    role: 'tutor',
    age,
    birthDate: `${2026 - age}-${String((index % 12) + 1).padStart(2, '0')}-${String((index % 27) + 1).padStart(2, '0')}`,
    contact: contactNumber(index),
    address: `Purok ${(index % 7) + 1}, ${BARANGAYS[index % BARANGAYS.length]}, General Santos City`,
    yearLevel: levels.join(', '),
    yearLevels: levels,
    gradeLevel: '',
    branchId: branch.id
  };
}

function buildStudent(index, branch) {
  const person = personAt(index);
  const gradeLevel = GRADE_LEVELS[index % GRADE_LEVELS.length];
  const age = 5 + (index % GRADE_LEVELS.length) + 1;
  const guardian = personAt(index + 23);
  return {
    ...person,
    role: 'student',
    age,
    birthDate: `${2026 - age}-${String((index % 12) + 1).padStart(2, '0')}-${String((index % 27) + 1).padStart(2, '0')}`,
    contact: contactNumber(index + 500),
    address: `Purok ${(index % 7) + 1}, ${BARANGAYS[index % BARANGAYS.length]}, General Santos City`,
    yearLevel: '',
    yearLevels: [],
    gradeLevel,
    parentName: `${guardian.firstName} ${person.lastName}`,
    parentContact: contactNumber(index + 900),
    branchId: branch.id
  };
}

async function emailExists(email) {
  const rows = await query('SELECT TOP 1 id FROM users WHERE LOWER(email) = ?', [email]);
  return Boolean(rows[0]);
}

async function insertUser(account, passwordHash) {
  const result = await query(
    `INSERT INTO users (
       user_id, role, branch_id, password_hash, first_name, middle_name, last_name,
       birth_date, age, gender, contact_number, email, facebook_account, address,
       year_level, grade_level, parent_guardian_name, parent_contact_number, parent_email,
       parent_facebook, subjects_json, support_json, extra_json, status, is_archived
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 0)`,
    [
      `TMP-${account.email.slice(0, 40)}`,
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
      account.role === 'tutor' ? JSON.stringify({ year_levels: account.yearLevels }) : '{}'
    ]
  );

  const newId = Number(result.insertId);
  await query('UPDATE users SET user_id = ? WHERE id = ?', [generateUserCode(account.role, newId), newId]);

  for (const level of account.yearLevels) {
    await query('INSERT INTO tutor_year_levels (tutor_id, year_level) VALUES (?, ?)', [newId, level]);
  }
  return newId;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.email || !args.email.includes('@')) {
    console.error('Pass the inbox that should receive the OTPs, e.g. --email=you@gmail.com');
    process.exit(1);
  }

  const branches = await query('SELECT id, name FROM branches WHERE is_archived = 0 ORDER BY id');
  if (!branches.length) {
    console.error('No active branches found — nothing to seed.');
    process.exit(1);
  }

  console.log(`Database : ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
  console.log(`Branches : ${branches.length} (${branches.map((b) => b.name).join(', ')})`);
  console.log(`Per branch: ${TUTORS_PER_BRANCH} tutors + ${STUDENTS_PER_BRANCH} students`);
  console.log(`Mode     : ${args.commit ? 'COMMIT — rows will be written' : 'DRY RUN — nothing will be written'}\n`);

  const passwordHash = args.commit ? await bcrypt.hash(args.password, 10) : null;
  let created = 0;
  let skipped = 0;
  let counter = 0;

  for (const branch of branches) {
    const branchTag = slug(branch.name).replace(/branch$/, '').slice(0, 8);
    const accounts = [];

    for (let i = 0; i < TUTORS_PER_BRANCH; i++) accounts.push(buildTutor(counter++, branch));
    for (let i = 0; i < STUDENTS_PER_BRANCH; i++) accounts.push(buildStudent(counter++, branch));

    for (const [position, account] of accounts.entries()) {
      account.email = aliasFor(
        args.email,
        `${slug(account.firstName)}${slug(account.lastName)}.${branchTag}${String(position + 1).padStart(2, '0')}`
      );

      if (await emailExists(account.email)) {
        skipped++;
        continue;
      }
      if (args.commit) await insertUser(account, passwordHash);
      created++;
    }

    console.log(`${branch.name}: ${args.commit ? 'created' : 'would create'} accounts (running total ${created}, skipped ${skipped})`);
  }

  console.log(`\n${args.commit ? 'Created' : 'Would create'}: ${created} accounts. Already present: ${skipped}.`);
  if (args.commit) {
    console.log(`Password for every seeded account: ${args.password}`);
  } else {
    console.log('Re-run with --commit to write these rows.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Seeding failed:', error.message);
    process.exit(1);
  });
