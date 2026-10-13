/**
 * File: lib/moduleGrades.js
 * Purpose: Which grade level a module belongs to, and which students see it.
 *
 * A module belongs to exactly ONE grade level. "Grade 1 English — Module 1" is
 * for Grade 1 students taking English and nobody else; Grade 6 English has its
 * own Module 1, 2, 3.
 *
 * It used to be a list of year levels ("visible to"), and the admin form saved
 * the group together with the grade: ["Primary Level", "Grade 3"]. A group
 * stood for every grade inside it, so that one Grade 3 module reached Grades 1
 * to 6 — a Grade 6 learner saw, and answered, Grade 3's modules, and the subject's
 * Pre-Assessment was written from every grade's handouts at once.
 *
 * Kept free of the database so the rules can be tested on their own
 * (scripts/test-module-grades.js) and read the same way by every caller: the
 * student's pages, the handout guard in server.js, the tutor's lists and the
 * admin's forms.
 */

const { safeJsonArray } = require('./utils');

const YEAR_LEVEL_GROUPS = ['Pre School Level', 'Primary Level', 'Junior High Level', 'Senior High Level'];

const GRADES_BY_GROUP = {
  'Pre School Level': ['Kinder 1', 'Kinder 2'],
  'Primary Level': ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6'],
  'Junior High Level': ['Grade 7', 'Grade 8', 'Grade 9', 'Grade 10'],
  'Senior High Level': ['Grade 11', 'Grade 12']
};

/** Every grade, youngest first — the order modules are listed in. */
const GRADE_LEVELS = YEAR_LEVEL_GROUPS.flatMap((group) => GRADES_BY_GROUP[group]);

/** "Grade 3", "grade 3", "GRADE3" all read the same. */
function gradeToken(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const GRADE_BY_TOKEN = new Map(GRADE_LEVELS.map((grade) => [gradeToken(grade), grade]));

/** The grade's own spelling ('Grade 3'), or '' for anything that is not one grade. */
function canonicalGrade(value) {
  return GRADE_BY_TOKEN.get(gradeToken(value)) || '';
}

/** Position in GRADE_LEVELS, for sorting; unknown grades go last. */
function gradeOrder(value) {
  const index = GRADE_LEVELS.indexOf(canonicalGrade(value));
  return index === -1 ? GRADE_LEVELS.length : index;
}

/** 'Grade 3' -> 'Primary Level'. */
function groupOfGrade(value) {
  const grade = canonicalGrade(value);
  return YEAR_LEVEL_GROUPS.find((group) => GRADES_BY_GROUP[group].includes(grade)) || '';
}

/**
 * The one grade a module is for.
 *
 * modules.grade_level when it is set. A module saved before that column existed
 * is read from its old target list, taking the specific grade in it — the
 * group beside it ("Primary Level") was what made the module leak, so it is
 * deliberately not expanded. A module that only ever named a group belongs to no
 * grade and is shown to no student until the office gives it one.
 */
function moduleGradeOf(mod) {
  if (!mod) return '';
  const direct = canonicalGrade(mod.grade_level);
  if (direct) return direct;
  // The youngest grade listed — the same pick the migration in sql/schema.sql
  // (section 43) makes when it fills modules.grade_level.
  const listed = safeJsonArray(mod.target_year_levels_json || mod.target_year_levels)
    .map(canonicalGrade)
    .filter(Boolean)
    .sort((a, b) => gradeOrder(a) - gradeOrder(b));
  return listed[0] || '';
}

/**
 * The grade a student is in. grade_level is where registration records it;
 * year_level is read too for older records that put the grade there.
 */
function studentGradeOf(student) {
  if (!student) return '';
  const candidates = [
    student.grade_level, student.student_grade_level,
    student.year_level, student.student_year_level
  ];
  for (const value of candidates) {
    const grade = canonicalGrade(value);
    if (grade) return grade;
  }
  return '';
}

/** Does this module show for this student? Only when it is for their grade. */
function moduleVisibleTo(mod, student) {
  const grade = moduleGradeOf(mod);
  return !!grade && grade === studentGradeOf(student);
}

/** The admin's grade picker: grades grouped under their year level. */
function getGradeOptions() {
  return YEAR_LEVEL_GROUPS.map((group) => ({ group, grades: [...GRADES_BY_GROUP[group]] }));
}

/** Sort modules by grade, then by module number. */
function compareModules(a, b) {
  return gradeOrder(moduleGradeOf(a)) - gradeOrder(moduleGradeOf(b))
    || Number(a.order_number || 0) - Number(b.order_number || 0)
    || Number(a.id || 0) - Number(b.id || 0);
}

module.exports = {
  YEAR_LEVEL_GROUPS,
  GRADES_BY_GROUP,
  GRADE_LEVELS,
  canonicalGrade,
  gradeOrder,
  groupOfGrade,
  moduleGradeOf,
  studentGradeOf,
  moduleVisibleTo,
  getGradeOptions,
  compareModules
};
