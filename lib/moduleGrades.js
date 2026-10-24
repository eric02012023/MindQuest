

const { safeJsonArray } = require('./utils');

const YEAR_LEVEL_GROUPS = ['Pre School Level', 'Primary Level', 'Junior High Level', 'Senior High Level'];

const GRADES_BY_GROUP = {
  'Pre School Level': ['Kinder 1', 'Kinder 2'],
  'Primary Level': ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6'],
  'Junior High Level': ['Grade 7', 'Grade 8', 'Grade 9', 'Grade 10'],
  'Senior High Level': ['Grade 11', 'Grade 12']
};

const GRADE_LEVELS = YEAR_LEVEL_GROUPS.flatMap((group) => GRADES_BY_GROUP[group]);

function gradeToken(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const GRADE_BY_TOKEN = new Map(GRADE_LEVELS.map((grade) => [gradeToken(grade), grade]));

function canonicalGrade(value) {
  return GRADE_BY_TOKEN.get(gradeToken(value)) || '';
}

function gradeOrder(value) {
  const index = GRADE_LEVELS.indexOf(canonicalGrade(value));
  return index === -1 ? GRADE_LEVELS.length : index;
}

function groupOfGrade(value) {
  const grade = canonicalGrade(value);
  return YEAR_LEVEL_GROUPS.find((group) => GRADES_BY_GROUP[group].includes(grade)) || '';
}

function moduleGradeOf(mod) {
  if (!mod) return '';
  const direct = canonicalGrade(mod.grade_level);
  if (direct) return direct;
  
  
  const listed = safeJsonArray(mod.target_year_levels_json || mod.target_year_levels)
    .map(canonicalGrade)
    .filter(Boolean)
    .sort((a, b) => gradeOrder(a) - gradeOrder(b));
  return listed[0] || '';
}

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

function moduleVisibleTo(mod, student) {
  const grade = moduleGradeOf(mod);
  return !!grade && grade === studentGradeOf(student);
}

function getGradeOptions() {
  return YEAR_LEVEL_GROUPS.map((group) => ({ group, grades: [...GRADES_BY_GROUP[group]] }));
}

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
