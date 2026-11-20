/**
 * File: lib/studentPre.js
 * Purpose: Each student's own Pre-Assessment, checked by their tutor before they
 *          take it.
 *
 * The AI still writes one Pre-Assessment per subject and grade (lib/data.js,
 * getOrCreatePreAssessment): the master. No student answers the master any
 * more. Each student gets a copy of it as a draft (student_pre_assessments),
 * which their tutor — or the main admin — checks, may edit on the same page as
 * a module assessment (lib/learningPaths.js, editPageData), and opens. Only then
 * can the student take it. Once open it is never edited again: their answers
 * are graded on the questions they were shown, and their Post-Assessment
 * repeats those very questions.
 *
 * A draft nobody has edited follows its master: when the handouts change and
 * the master is written again, the draft takes the new questions. A draft that
 * was edited is left as it is, and its page offers the new version instead.
 */

const { query, withTransaction } = require('../config/db');
const { studentGradeOf, canonicalGrade } = require('./moduleGrades');

const NOW = 'DATEADD(hour, 8, GETUTCDATE())';

/** What a notice about a student's own Pre-Assessment points at (app_notifications.ref_type). */
const REF_TYPE = 'student_pre_assessment';

/** A failed write of the master is not tried again on every page view: once per this long. */
const RETRY_AFTER_MS = 10 * 60 * 1000;

const COPY_SELECT = `SELECT spa.*, s.name AS subject_name,
        u.first_name, u.last_name, u.user_id AS student_code, u.branch_id AS student_branch_id,
        ta.item_count
   FROM student_pre_assessments spa
   JOIN subjects s ON s.id = spa.subject_id
   JOIN users u ON u.id = spa.student_id
   JOIN tutor_assessments ta ON ta.id = spa.assessment_id`;

async function getCopyById(id) {
  if (!Number(id)) return null;
  const rows = await query(`${COPY_SELECT} WHERE spa.id = ?`, [Number(id)]);
  return rows[0] || null;
}

/** The copy an assessment is, or null when it is not a student's own Pre-Assessment. */
async function getCopyByAssessment(assessmentId) {
  if (!Number(assessmentId)) return null;
  const rows = await query(`${COPY_SELECT} WHERE spa.assessment_id = ?`, [Number(assessmentId)]);
  return rows[0] || null;
}

async function getCopy(studentId, subjectId, gradeLevel) {
  const grade = canonicalGrade(gradeLevel);
  if (!Number(studentId) || !Number(subjectId) || !grade) return null;
  const rows = await query(
    `${COPY_SELECT} WHERE spa.student_id = ? AND spa.subject_id = ? AND spa.grade_level = ?`,
    [Number(studentId), Number(subjectId), grade]
  );
  return rows[0] || null;
}

/**
 * Each student's copy in the given subjects, as a Map keyed `student|subject`,
 * for pages that list many students at once (the tutor's Modules & Assessments).
 */
async function getCopiesFor(studentIds = [], subjectIds = []) {
  const students = [...new Set(studentIds.map(Number).filter(Boolean))];
  const subjects = [...new Set(subjectIds.map(Number).filter(Boolean))];
  const result = new Map();
  if (!students.length || !subjects.length) return result;
  const rows = await query(
    `SELECT id, student_id, subject_id, grade_level, status, assessment_id
       FROM student_pre_assessments
      WHERE student_id IN (${students.map(() => '?').join(',')})
        AND subject_id IN (${subjects.map(() => '?').join(',')})`,
    [...students, ...subjects]
  );
  for (const row of rows) result.set(`${Number(row.student_id)}|${Number(row.subject_id)}|${row.grade_level}`, row);
  return result;
}

function studentName(row) {
  return [row && row.first_name, row && row.last_name].filter(Boolean).join(' ') || 'The student';
}

/**
 * The master to copy: { state: 'ready', master }, { state: 'preparing' } while
 * the AI writes it, or { state: 'not_ready' } while the grade has no readable
 * handout. Never waits on the AI: a missing master is written in the background
 * (lib/preAssessmentWarmup.js).
 *
 * A master that is out of date — its handouts changed — is still copied rather
 * than leaving the student with nothing; a newer one is asked for, and a draft
 * nobody has edited follows it once it is written (followMaster).
 */
async function readyMaster(subjectId, grade) {
  const data = require('./data');
  const status = await data.getPreAssessmentStatus(subjectId, grade);
  const master = status.exists
    ? await data.getGeneratedAssessment(subjectId, 'pre_assessment', { gradeLevel: grade })
    : null;
  if ((!master || status.stale) && status.readableHandouts) askForMaster(subjectId, grade);
  if (master) return { state: 'ready', master };
  return { state: status.readableHandouts ? 'preparing' : 'not_ready' };
}

function askForMaster(subjectId, grade) {
  const warmup = require('./preAssessmentWarmup');
  const now = warmup.getWarmupState(subjectId, grade);
  if (now.status === 'queued' || now.status === 'generating') return;
  if (now.status === 'error' && now.at && Date.now() - new Date(now.at).getTime() < RETRY_AFTER_MS) return;
  warmup.schedulePreAssessmentWarmup(subjectId, grade, 'a student needs one', { delayMs: 0 });
}

/** The questions of an assessment, each with its choices, ready to be inserted again. */
async function questionsOf(assessmentId) {
  const data = require('./data');
  const full = await data.getAssessmentWithQuestions(Number(assessmentId), { includeArchived: true });
  return full ? full.questions : [];
}

async function insertQuestions(connection, assessmentId, questions) {
  for (const q of questions) {
    const [saved] = await connection.query(
      `INSERT INTO tutor_assessment_questions
         (assessment_id, question_text, question_type, points, correct_answer,
          explanation, answer_rubric, source_module_id, source_handout_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(assessmentId), q.question_text, q.question_type, Number(q.points || 1), q.correct_answer,
        q.explanation || null, q.answer_rubric || null,
        Number(q.source_module_id) || null, Number(q.source_handout_id) || null
      ]
    );
    for (const option of q.options || []) {
      await connection.query(
        'INSERT INTO tutor_question_options (question_id, option_label, option_text) VALUES (?, ?, ?)',
        [saved.insertId, option.option_label, option.option_text]
      );
    }
  }
}

/** Make a student's copy of the master, as a draft. A second request at the same moment gets the first one's copy. */
async function createCopy(studentId, subjectId, grade, master) {
  const questions = await questionsOf(master.id);
  if (!questions.length) return null;
  try {
    await withTransaction(async (connection) => {
      const [created] = await connection.query(
        `INSERT INTO tutor_assessments
           (subject_id, module_id, tutor_id, title, instructions, purpose, assessment_kind,
            question_type, item_count, handout_version, is_published, grade_level, source_fingerprint, for_student_id)
         VALUES (?, NULL, NULL, ?, ?, 'pre', 'pre_assessment', ?, ?, ?, 0, ?, ?, ?)`,
        [
          Number(subjectId), master.title, master.instructions || null, master.question_type || 'multiple_choice',
          questions.length, master.handout_version || null, grade, master.source_fingerprint || null, Number(studentId)
        ]
      );
      await insertQuestions(connection, created.insertId, questions);
      await connection.query(
        `INSERT INTO student_pre_assessments (student_id, subject_id, grade_level, master_assessment_id, assessment_id, status)
         VALUES (?, ?, ?, ?, ?, 'draft')`,
        [Number(studentId), Number(subjectId), grade, Number(master.id), created.insertId]
      );
    });
  } catch (error) {
    // The student's page and their tutor's at once: uq_spa_student kept one copy.
    if (!/duplicate key|unique/i.test(String(error.message))) throw error;
  }
  return getCopy(studentId, subjectId, grade);
}

/** Has anyone edited this draft since it last took its master's questions? */
async function editedSinceSync(copy) {
  const rows = await query(
    `SELECT COUNT(*) AS n
       FROM tutor_assessment_edits e
       JOIN student_pre_assessments spa ON spa.assessment_id = e.assessment_id
      WHERE spa.id = ? AND e.edited_at > spa.synced_at`,
    [Number(copy.id)]
  );
  return Number((rows[0] || {}).n || 0) > 0;
}

/**
 * Give a draft its master's questions again — the newest master's. With an
 * actor it was asked for ("Use the New Version") and is recorded as an edit.
 */
async function takeMaster(copy, master, actorId = null) {
  const questions = await questionsOf(master.id);
  if (!questions.length) throw new Error('The new version has no questions yet.');
  await withTransaction(async (connection) => {
    const [rows] = await connection.query(
      `UPDATE student_pre_assessments SET master_assessment_id = ?, updated_at = ${NOW}
       OUTPUT inserted.id
        WHERE id = ? AND status = 'draft'`,
      [Number(master.id), Number(copy.id)]
    );
    if (!rows.length) throw new Error('It was opened for the student already, so it can no longer change.');
    await connection.query(
      `DELETE FROM tutor_question_options
        WHERE question_id IN (SELECT id FROM tutor_assessment_questions WHERE assessment_id = ?)`,
      [Number(copy.assessment_id)]
    );
    await connection.query('DELETE FROM tutor_assessment_questions WHERE assessment_id = ?', [Number(copy.assessment_id)]);
    await insertQuestions(connection, copy.assessment_id, questions);
    await connection.query(
      `UPDATE tutor_assessments
          SET title = ?, instructions = ?, item_count = ?, handout_version = ?, source_fingerprint = ?, updated_at = ${NOW}
        WHERE id = ?`,
      [
        master.title, master.instructions || null, questions.length, master.handout_version || null,
        master.source_fingerprint || null, Number(copy.assessment_id)
      ]
    );
    if (actorId) {
      await connection.query(
        'INSERT INTO tutor_assessment_edits (assessment_id, edited_by, summary) VALUES (?, ?, ?)',
        [Number(copy.assessment_id), Number(actorId), 'Replaced with the new version of the Pre-Assessment']
      );
    }
    // After the edit row above, so taking the new version does not itself count as an edit.
    await connection.query(`UPDATE student_pre_assessments SET synced_at = ${NOW} WHERE id = ?`, [Number(copy.id)]);
  });
}

/**
 * Keep a draft with its master. { newer: true, master } when a newer master
 * exists but the draft was edited, so it is offered rather than forced;
 * { replaced: true } when the draft simply took it.
 */
async function followMaster(copy) {
  if (!copy || copy.status !== 'draft') return { newer: false };
  const data = require('./data');
  const master = await data.getGeneratedAssessment(copy.subject_id, 'pre_assessment', { gradeLevel: copy.grade_level });
  if (!master || Number(master.id) === Number(copy.master_assessment_id)) return { newer: false };
  if (await editedSinceSync(copy)) return { newer: true, master };
  try {
    await takeMaster(copy, master, null);
    return { newer: false, replaced: true };
  } catch (error) {
    console.error('[studentPre] a draft could not take its new master:', error.message);
    return { newer: false };
  }
}

/** "Use the New Version": an edited draft takes the newest master, its edits given up. */
async function useNewVersion(copyId, actorId) {
  const copy = await getCopyById(copyId);
  if (!copy) throw new Error('Pre-Assessment not found.');
  if (copy.status !== 'draft') throw new Error('It was opened for the student already, so it can no longer change.');
  const data = require('./data');
  const master = await data.getGeneratedAssessment(copy.subject_id, 'pre_assessment', { gradeLevel: copy.grade_level });
  if (!master || Number(master.id) === Number(copy.master_assessment_id)) {
    throw new Error('This is the newest version already.');
  }
  await takeMaster(copy, master, actorId);
  return getCopyById(copy.id);
}

async function notify(userId, input) {
  if (!Number(userId)) return null;
  try {
    const { createNotification } = require('./appNotifications');
    return await createNotification({ severity: 'info', ...input, userId: Number(userId) });
  } catch (error) {
    console.error('[studentPre] could not notify', userId, error.message);
    return null;
  }
}

/** Tell the student's tutor — or, with none, the office — that a copy waits to be checked. */
async function notifyCopyReady(copy) {
  const { notifyTutorOrOffice } = require('./learningPaths');
  const name = studentName(copy);
  return notifyTutorOrOffice(copy, {
    type: 'pre_assessment_ready',
    title: `Pre-Assessment ready to check — ${name}`,
    message: `${name}'s ${copy.subject_name} Pre-Assessment is ready. Check it, edit it if needed, then open it for them.`,
    refType: REF_TYPE,
    refId: copy.id,
    tutorPath: `/path-assessments/${Number(copy.assessment_id)}/edit`
  });
}

/**
 * Where a student's Pre-Assessment stands in a subject:
 *   'taken'      they have taken it
 *   'open'       opened for them: they can take it
 *   'draft'      their copy waits for their tutor
 *   'to_make'    the master is ready, they have no copy yet (only without options.create)
 *   'preparing'  the master is being written
 *   'not_ready'  no grade on record, or no readable handout for their grade yet
 *
 * @param {object} [options]
 * @param {boolean} [options.create]       make their copy when the master is ready
 * @param {boolean} [options.notifyTutor]  tell their tutor when a copy is made here
 * @param {object}  [options.student]      their users row, when the caller has it
 */
async function preStateFor(studentId, subjectId, options = {}) {
  const data = require('./data');
  const student = options.student || await data.getUserById(Number(studentId));
  const grade = studentGradeOf(student);
  if (!grade) return { state: 'not_ready', grade: null };

  const taken = await data.hasCompletedPreAssessment(Number(studentId), Number(subjectId), grade);
  if (taken) return { state: 'taken', grade, submission: taken };

  let copy = await getCopy(studentId, subjectId, grade);
  if (copy) {
    if (copy.status !== 'draft') return { state: 'open', grade, copy };
    const sync = await followMaster(copy);
    if (sync.replaced) copy = await getCopy(studentId, subjectId, grade);
    return { state: 'draft', grade, copy, newerMaster: !!sync.newer };
  }

  const found = await readyMaster(Number(subjectId), grade);
  if (found.state !== 'ready') return { state: found.state, grade };
  if (!options.create) return { state: 'to_make', grade };

  copy = await createCopy(studentId, subjectId, grade, found.master);
  if (!copy) return { state: 'preparing', grade };
  if (options.notifyTutor && copy.status === 'draft') {
    await notifyCopyReady(copy).catch((error) => console.error('[studentPre] could not notify the tutor:', error.message));
  }
  return { state: copy.status === 'draft' ? 'draft' : 'open', grade, copy, created: true };
}

/** Open a checked copy for its student. */
async function openCopy(copyId, actorId) {
  const copy = await getCopyById(copyId);
  if (!copy) throw new Error('Pre-Assessment not found.');
  if (copy.status !== 'draft') throw new Error('The Pre-Assessment is open for the student already.');
  const [{ n } = { n: 0 }] = await query(
    'SELECT COUNT(*) AS n FROM tutor_assessment_questions WHERE assessment_id = ?',
    [Number(copy.assessment_id)]
  );
  if (!Number(n)) throw new Error('The Pre-Assessment has no questions. Add at least one first.');
  const moved = await withTransaction(async (connection) => {
    const [rows] = await connection.query(
      `UPDATE student_pre_assessments
          SET status = 'open', opened_by = ?, opened_at = ${NOW}, updated_at = ${NOW}
       OUTPUT inserted.id
        WHERE id = ? AND status = 'draft'`,
      [Number(actorId) || null, Number(copy.id)]
    );
    if (rows.length) {
      await connection.query(`UPDATE tutor_assessments SET is_published = 1, updated_at = ${NOW} WHERE id = ?`, [Number(copy.assessment_id)]);
    }
    return rows.length > 0;
  });
  if (!moved) throw new Error('The Pre-Assessment is open for the student already.');
  await notify(copy.student_id, {
    type: 'pre_assessment_open',
    title: 'Your Pre-Assessment is open',
    message: `Your tutor opened your ${copy.subject_name} Pre-Assessment. You can take it now.`,
    linkUrl: `/student/subjects/${Number(copy.subject_id)}`,
    refType: REF_TYPE,
    refId: copy.id
  });
  return getCopyById(copy.id);
}

/**
 * The student's open copy, ready to take — or { reason } saying why it is not:
 * 'not_ready' | 'preparing' | 'draft' | 'taken'.
 */
async function openCopyFor(studentId, subjectId, gradeLevel) {
  const grade = canonicalGrade(gradeLevel);
  const copy = grade ? await getCopy(studentId, subjectId, grade) : null;
  if (!copy) return { reason: 'not_ready' };
  if (copy.status !== 'open') return { reason: 'draft', copy };
  return { copy };
}

/**
 * Delete a student's copies — in one subject, or all of them — with their
 * questions, choices, edit history and notices. Run inside the caller's
 * transaction, after the submissions that point at them are gone (a reset), or
 * when there never were any (an account deleted).
 */
async function removeCopiesWith(connection, studentId, subjectId = null) {
  const params = [Number(studentId)];
  let subjectClause = '';
  if (subjectId) {
    subjectClause = ' AND subject_id = ?';
    params.push(Number(subjectId));
  }
  const [rows] = await connection.query(
    `SELECT id, assessment_id FROM student_pre_assessments WHERE student_id = ?${subjectClause}`,
    params
  );
  if (!rows.length) return 0;
  const copyIds = rows.map((row) => Number(row.id));
  const assessmentIds = rows.map((row) => Number(row.assessment_id));
  const copies = copyIds.map(() => '?').join(',');
  const assessments = assessmentIds.map(() => '?').join(',');
  await connection.query(
    `DELETE FROM app_notifications WHERE ref_type = '${REF_TYPE}' AND ref_id IN (${copies})`,
    copyIds
  );
  await connection.query(`DELETE FROM assessment_violations WHERE assessment_id IN (${assessments})`, assessmentIds);
  await connection.query(`DELETE FROM tutor_assessment_edits WHERE assessment_id IN (${assessments})`, assessmentIds);
  await connection.query(`DELETE FROM student_pre_assessments WHERE id IN (${copies})`, copyIds);
  await connection.query(
    `DELETE FROM tutor_question_options
      WHERE question_id IN (SELECT id FROM tutor_assessment_questions WHERE assessment_id IN (${assessments}))`,
    assessmentIds
  );
  await connection.query(`DELETE FROM tutor_assessment_questions WHERE assessment_id IN (${assessments})`, assessmentIds);
  await connection.query(
    `DELETE FROM tutor_assessments WHERE id IN (${assessments}) AND for_student_id = ?`,
    [...assessmentIds, Number(studentId)]
  );
  return rows.length;
}

/** The modules a new question of a student's Pre-Assessment can belong to: their grade's in the subject. */
async function moduleChoicesFor(copy) {
  if (!copy) return [];
  const data = require('./data');
  const modules = await data.getSubjectModules(Number(copy.subject_id), { gradeLevel: copy.grade_level });
  return modules
    .filter((mod) => !Number(mod.is_archived))
    .map((mod) => ({
      id: Number(mod.id),
      label: `Module ${mod.order_number || '?'}${mod.title ? `: ${mod.title}` : ''}`
    }));
}

module.exports = {
  REF_TYPE,
  getCopyById,
  getCopyByAssessment,
  getCopy,
  getCopiesFor,
  preStateFor,
  followMaster,
  useNewVersion,
  openCopy,
  openCopyFor,
  removeCopiesWith,
  moduleChoicesFor,
  notifyCopyReady
};
