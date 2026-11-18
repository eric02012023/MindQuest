/**
 * File: lib/mobileSerializers.js
 * Purpose: What the MindQuest student app is allowed to see of each page.
 *
 * The app does not get new business logic: routes/mobileApi.js runs the
 * website's own student routes (routes/student.js) and catches the locals they
 * hand to res.render. Those locals were written for EJS templates on the
 * server, so they carry far more than a student should ever receive:
 *
 *   - getUserById returns `u.*` — the password hash included;
 *   - an assessment being answered carries every question's correct_answer,
 *     explanation and answer_rubric;
 *   - tutor rows carry their whole account record.
 *
 * So nothing is passed through as it is. Each page (keyed by the route's
 * contentView, e.g. "student-subject-detail") has a WHITELIST serializer that
 * picks the fields the website itself shows on that page, and builds the
 * links the app follows. A page without a serializer returns `data: null`.
 *
 * Paths in the output are APP paths: the website's "/student/subjects/5" is
 * "/subjects/5" here, the same screen in the app. Files are served through the
 * token-protected "/api/mobile/..." mounts (see fileLink).
 */

const { toInputDate } = require('./utils');

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Only the listed keys of a row (undefined ones are left out by JSON). */
function pick(row, keys) {
  const out = {};
  if (!row) return out;
  for (const key of keys) {
    if (row[key] !== undefined) out[key] = row[key];
  }
  return out;
}

const num = (value) => (value === null || value === undefined || value === '' ? null : Number(value));
const str = (value) => (value === null || value === undefined ? '' : String(value));
const list = (value) => (Array.isArray(value) ? value : []);
const fullName = (row, prefix = '') => [row && row[`${prefix}first_name`], row && row[`${prefix}middle_name`], row && row[`${prefix}last_name`]]
  .map((part) => String(part || '').trim()).filter(Boolean).join(' ');

/** "/student/subjects/5" -> "/subjects/5" (an app path); other paths unchanged. */
function appPath(webPath) {
  const path = str(webPath);
  if (path === '/student') return '/';
  if (path.startsWith('/student/')) return path.slice('/student'.length);
  return path;
}

/**
 * The address the app downloads a stored file from. Study material is served
 * only behind the token (routes/mobileApi.js mounts the same guards as the
 * website's /uploads); profile photos are public on the website too.
 */
const PROTECTED_FOLDERS = ['/uploads/handouts/', '/uploads/modules/', '/uploads/resources/', '/uploads/ai-modules/'];
function fileLink(filePath) {
  const path = str(filePath).replace(/\\/g, '/');
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return null; // never hand out raw storage URLs
  if (PROTECTED_FOLDERS.some((folder) => path.startsWith(folder))) return `/api/mobile${path}`;
  if (path.startsWith('/uploads/profiles/')) return path;
  return null;
}

/** A person's photo, as the public website path (or null). */
const photo = (path) => (str(path).startsWith('/uploads/profiles/') ? str(path) : null);

const LEVEL_BANDS = [
  { name: 'Beginner', range: '0–50%' },
  { name: 'Intermediate', range: '51–80%' },
  { name: 'Advance', range: '81–100%' }
];

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** A student's enrolled subject (getStudentAssignments row). */
function assignmentOf(row) {
  if (!row) return null;
  return {
    subjectId: num(row.subject_id),
    subjectName: str(row.subject_name),
    tutorId: num(row.tutor_internal_id),
    tutorName: str(row.tutor_name),
    timeSlot: str(row.time_slot),
    preferredDays: str(row.preferred_days),
    enrolledAt: row.enrolled_at || null,
    startDate: row.start_date || null,
    endDate: row.end_date || null,
    monthOver: !!row.month_over,
    viewOnly: !!row.view_only,
    remaining: num(row.remaining)
  };
}

/**
 * The questions of an assessment the student is ANSWERING. Only what the
 * question page shows: no correct_answer, explanation, answer_rubric,
 * is_correct or source columns — the answer key never leaves the server
 * before the submission is graded.
 *
 * @param {object} options.tf  the values the website's form posts for True/False
 */
function questionsForAnswering(questions, options = {}) {
  const tf = options.tf || { true: 'true', false: 'false' };
  return list(questions).map((q, index) => {
    const type = str(q.question_type) || 'essay';
    const base = {
      id: num(q.id),
      number: index + 1,
      type: ['multiple_choice', 'true_false', 'fill_blank', 'essay'].includes(type) ? type : 'essay',
      text: str(q.question_text),
      points: num(q.points) || 1
    };
    if (type === 'multiple_choice') {
      base.choices = list(q.options).map((option) => ({
        value: str(option.option_label),
        // A retake shows the choices in a new order with the letter of their new
        // place (lib/learningPaths.js, questionsForTake); the value stays the original.
        label: str(option.display_label || option.option_label),
        text: str(option.option_text)
      }));
    } else if (type === 'true_false') {
      base.choices = [
        { value: tf.true, label: 'T', text: 'True' },
        { value: tf.false, label: 'F', text: 'False' }
      ];
    }
    return base;
  });
}

/** The anti-cheat watcher's settings, with the endpoint as an app path. */
function antiCheatOf(antiCheat) {
  if (!antiCheat) return null;
  return {
    endpoint: appPath(antiCheat.endpoint),
    sessionKey: str(antiCheat.sessionKey),
    limit: num(antiCheat.limit) || 3,
    startCount: num(antiCheat.startCount) || 0
  };
}

/** An activity or module test row with the student's submission, if any. */
function workItem(assessment, submissions) {
  const done = list(submissions).find((s) => Number(s.assessment_id) === Number(assessment.id));
  return {
    id: num(assessment.id),
    title: str(assessment.title),
    done: done
      ? {
        submissionId: num(done.id),
        score: num(done.score),
        totalPoints: num(done.total_points),
        percentage: num(done.percentage)
      }
      : null
  };
}

// ---------------------------------------------------------------------------
// Serializers, one per view (routes/student.js contentView)
// ---------------------------------------------------------------------------

const SERIALIZERS = {
  /** Home: welcome, the subjects' tutors, attendance, the latest SOA, subjects. */
  'student-dashboard'(locals) {
    const dashboard = locals.dashboard || {};
    const assignments = list(dashboard.assignments);
    const tutors = [];
    for (const item of assignments.filter((a) => a.tutor_internal_id)) {
      let entry = tutors.find((t) => Number(t.id) === Number(item.tutor_internal_id));
      if (!entry) {
        entry = { id: num(item.tutor_internal_id), name: str(item.tutor_name), subjects: [] };
        tutors.push(entry);
      }
      entry.subjects.push(str(item.subject_name));
    }
    const attendance = dashboard.attendance || {};
    const soa = dashboard.latestSoa;
    return {
      firstName: str(dashboard.user && dashboard.user.first_name),
      imagePath: photo(dashboard.user && dashboard.user.image_path),
      tutors,
      attendance: {
        present: num(attendance.present) || 0,
        late: num(attendance.late) || 0,
        absent: num(attendance.absent) || 0,
        excused: num(attendance.excused) || 0
      },
      latestSoa: soa
        ? {
          statementDate: soa.statement_date || soa.created_at || null,
          fullBill: num(soa.full_bill) || 0,
          forSettlement: num(soa.for_settlement) || 0
        }
        : null,
      subjects: assignments.map(assignmentOf)
    };
  },

  /** My Subjects: enrolled subjects, picking a tutor, and enrolling in more. */
  'student-subjects'(locals) {
    const choices = locals.tutorChoices || { subjects: [], held: [], timeSlots: [], preferredDays: [] };
    const waiting = list(locals.pendingRequests);
    const requestFor = (subjectId) => waiting.find((r) => Number(r.subject_id) === Number(subjectId)) || null;
    const choiceFor = (subjectId) => list(choices.subjects).find((s) => Number(s.subject_id) === Number(subjectId)) || null;
    return {
      enrolled: list(locals.assignments).map((row) => {
        const pending = row.tutor_internal_id ? null : requestFor(row.subject_id);
        return {
          ...assignmentOf(row),
          pending: pending
            ? {
              tutorName: fullName(pending),
              preferredDays: str(pending.preferred_days),
              timeSlot: str(pending.time_slot)
            }
            : null,
          canChooseTutor: !row.tutor_internal_id && !pending && !!choiceFor(row.subject_id)
        };
      }),
      allSubjects: list(locals.allSubjects).map((subject) => ({
        id: num(subject.id),
        name: str(subject.name),
        status: subject.is_enrolled ? 'enrolled' : subject.has_pending_request ? 'pending' : 'not_enrolled'
      })),
      // The Select Tutor flow: per subject still without a tutor, who could
      // take it and when each tutor is already busy ("Days|Time" keys).
      tutorChoices: {
        subjects: list(choices.subjects)
          .filter((subject) => !requestFor(subject.subject_id))
          .map((subject) => ({
            subjectId: num(subject.subject_id),
            subjectName: str(subject.subject_name),
            tutors: list(subject.tutors).map((tutor) => ({
              id: num(tutor.id),
              name: str(tutor.name),
              imagePath: photo(tutor.image_path),
              yearLevels: list(tutor.year_levels).map(str),
              alsoYours: list(tutor.also_yours).map(str),
              blocked: list(tutor.blocked).map(str)
            }))
          })),
        // The hours the student already spends on their other subjects.
        held: list(choices.held).map((session) => ({
          days: str(session.days),
          timeSlot: str(session.time_slot),
          subjectName: str(session.subject_name),
          waiting: !!session.waiting
        })),
        timeSlots: list(choices.timeSlots).map(str),
        preferredDays: list(choices.preferredDays).map(str)
      }
    };
  },

  /** A tutor's profile, with "Select this tutor" when reached from the picker. */
  'student-tutor-profile'(locals) {
    const tutor = locals.tutor || {};
    const pickInfo = locals.pick;
    return {
      tutor: {
        id: num(tutor.id),
        code: str(tutor.user_id),
        name: fullName(tutor),
        imagePath: photo(tutor.image_path),
        email: str(tutor.email),
        contactNumber: str(tutor.contact_number),
        facebookAccount: str(tutor.facebook_account),
        gender: str(tutor.gender),
        branchName: str(tutor.branch_name),
        yearLevel: str(tutor.year_level),
        subjects: list(tutor.subjects).map(str)
      },
      pick: pickInfo
        ? {
          subjectId: num(pickInfo.subjectId),
          subjectName: str(pickInfo.subjectName),
          preferredDays: str(pickInfo.days),
          timeSlot: str(pickInfo.slot),
          canSelect: !!pickInfo.canSelect,
          waiting: !!pickInfo.waiting,
          alsoYours: list(pickInfo.alsoYours).map(str)
        }
        : null
    };
  },

  /**
   * One subject: tutor and schedule, the month notes, the Pre-Assessment gate
   * with WHY it is shut, the modules (or the learning path), the
   * Post-Assessment, files and attendance — the same decisions the website's
   * template makes, worded the same way.
   */
  'student-subject-detail'(locals) {
    const assignment = locals.assignment || {};
    const subjectName = str(assignment.subject_name);
    const viewOnly = str(locals.viewOnly);
    const monthNote = str(locals.monthNote);
    const pre = locals.preAssessmentDone || null;
    const newModules = list(locals.newModules);
    const lp = locals.learningPath || null;
    const completion = locals.completion || {};
    const comparison = locals.comparison || null;
    const downPayment = locals.downPayment || null;
    const gradeLevel = str(locals.gradeLevel);
    const tutor = locals.tutor;

    // ---- The Pre-Assessment gate (student-subject-detail.ejs) -------------
    let preGate = null;
    if (!pre && !viewOnly) {
      const downPaymentDue = !!(downPayment && !downPayment.satisfied);
      let reason;
      let message;
      if (!gradeLevel) {
        reason = 'no_grade_level';
        message = 'Your grade level is not on your profile yet, so no modules are assigned to you. Please ask the office to set it.';
      } else if (!newModules.length) {
        reason = 'no_modules';
        message = `There are no ${gradeLevel} modules in ${subjectName} yet. The Pre-Assessment opens once your modules are ready.`;
      } else if (downPaymentDue) {
        reason = 'down_payment';
        message = `A down payment of at least ₱${Number(downPayment.required || 0).toFixed(2)} is required before you can take the Pre-Assessment.`
          + (downPayment.hasBill
            ? ` You have paid ₱${Number(downPayment.paid || 0).toFixed(2)}, so ₱${Number(downPayment.shortfall || 0).toFixed(2)} is still needed.`
            : ' Your account has not been billed yet — please contact the office.');
      } else if (num(locals.handoutsReady)) {
        reason = null;
        message = '';
      } else {
        reason = 'no_handout';
        message = `Your ${gradeLevel} modules have no handout yet, so the Pre-Assessment is not ready. It opens once the office uploads them.`;
      }
      preGate = {
        canStart: reason === null,
        reason,
        message,
        startPath: `/subjects/${num(assignment.subject_id)}/pre-assessment`,
        goToBilling: reason === 'down_payment' && !!(downPayment && downPayment.hasBill)
      };
    }

    // ---- Modules: the learning path, or the level modules -----------------
    const levelOf = new Map(list(locals.levelEntries).map((entry) => [Number(entry.module && entry.module.id), entry.levelModule]));
    const learningPath = lp
      ? {
        placementLevel: str(lp.path && lp.path.placement_level),
        passed: num(lp.passed) || 0,
        total: num(lp.total) || 0,
        allPassed: !!lp.allPassed,
        modules: list(lp.modules).map((m, index) => {
          const before = index > 0 ? lp.modules[index - 1] : null;
          return {
            id: num(m.id),
            number: num(m.order_number || m.position),
            title: str(m.module_title),
            status: str(m.status),
            additionsStatus: str(m.additions_status),
            weakPointCount: num(m.weak_point_count) || 0,
            addedCount: num(m.added_count) || 0,
            preTotal: num(m.pre_total) || 0,
            takeState: str(m.take_state),
            attempts: list(m.attempts).length,
            opensAfter: before ? num(before.order_number || before.position) : null,
            path: `/path-modules/${num(m.id)}`
          };
        })
      }
      : null;

    const modules = lp ? [] : newModules.map((mod) => {
      const mine = levelOf.get(Number(mod.id)) || null;
      return {
        id: num(mod.id),
        number: num(mod.order_number),
        title: str(mod.title),
        description: str(mod.description),
        handoutCount: list(mod.handouts).length,
        levelModule: mine ? { id: num(mine.id), level: str(mine.level), status: str(mine.status) } : null,
        path: mine ? `/level-modules/${num(mine.id)}` : `/modules/${num(mod.id)}`,
        // The office's module, still openable to view its handouts.
        handoutsPath: `/modules/${num(mod.id)}`
      };
    });

    // ---- The Post-Assessment ----------------------------------------------
    let post = null;
    if (pre) {
      const postSub = completion.postSubmission;
      let note = '';
      if (completion.postTaken) note = '';
      else if (completion.postStatus === 'open') {
        note = 'Your tutor opened your Post-Assessment. '
          + (lp && lp.post && !/same questions as your Pre-Assessment/i.test(String(lp.post.instructions || ''))
            ? 'Its questions come from your own modules,'
            : lp ? 'It repeats your Pre-Assessment, in a new order,' : 'It repeats your Pre-Assessment,')
          + ' so you and your tutor can see how much you have improved.';
      } else if (lp) {
        note = !lp.allPassed
          ? `It opens after you pass all your modules (${num(lp.passed)} of ${num(lp.total)} so far) and your tutor opens it.`
          : 'You passed all your modules. Your tutor opens your Post-Assessment once it is ready.';
      } else {
        note = 'Your tutor opens the Post-Assessment once you finish your modules.';
      }
      post = {
        taken: !!completion.postTaken,
        status: str(completion.postStatus),
        note,
        startPath: completion.postStatus === 'open' && !completion.postTaken
          ? `/subjects/${num(assignment.subject_id)}/post-assessment` : null,
        submission: postSub
          ? { id: num(postSub.id), percentage: num(postSub.percentage), level: str(postSub.level) }
          : null,
        // Before and after, when both exist (a learning path shows its own below).
        comparison: completion.postTaken && comparison && comparison.pre_submission_id && !(lp && locals.pathScores)
          ? {
            prePercentage: num(comparison.pre_percentage),
            preLevel: str(comparison.pre_level),
            postPercentage: num(comparison.post_percentage),
            postLevel: str(comparison.post_level),
            delta: num(comparison.delta),
            levelChanged: !!comparison.level_changed
          }
          : null,
        // Without a learning path: what is still to do before it opens.
        stillToDo: !lp && !completion.postTaken && completion.postStatus !== 'open'
          ? {
            modulesOpened: num(completion.modulesOpened) || 0,
            modulesTotal: num(completion.modulesTotal) || 0,
            assessments: list(completion.pendingAssessments).map((a) => ({
              id: num(a.id), title: str(a.title), path: `/tutor-assessments/${num(a.id)}`
            }))
          }
          : null
      };
    }

    const resourceOf = (resource) => ({
      id: num(resource.id),
      title: str(resource.title),
      type: str(resource.type_of_module),
      description: str(resource.description),
      // The website's /download/module/:id, behind the app's token.
      fileUrl: resource.file_path || resource.content_text ? `/api/mobile/download/module/${num(resource.id)}` : null
    });

    return {
      subject: {
        ...assignmentOf(assignment),
        tutor: tutor
          ? {
            id: num(tutor.id),
            name: fullName(tutor),
            imagePath: photo(tutor.image_path),
            email: str(tutor.email),
            contactNumber: str(tutor.contact_number)
          }
          : null
      },
      viewOnlyNote: viewOnly,
      monthNote: viewOnly ? '' : monthNote,
      preGate,
      preAssessment: pre
        ? { submissionId: num(pre.id), percentage: num(pre.percentage), level: str(pre.level) }
        : null,
      placementLevel: str(locals.placementLevel),
      gradeLevel,
      learningPath,
      modules,
      post,
      pathScores: lp ? pathScoresOf(locals.pathScores) : null,
      legacyModules: list(locals.modules).map(resourceOf),
      sharedFiles: list(locals.resources).map(resourceOf),
      attendance: list(locals.attendanceLogs).map((log) => ({
        date: log.attendance_date || null,
        status: str(log.status),
        tutorName: fullName(log, 'tutor_')
      }))
    };
  },

  /** The Pre- and the Post-Assessment (one template for both on the website). */
  'student-pre-assessment'(locals) {
    const assessment = locals.assessment || {};
    const isPost = locals.kind === 'post';
    const subjectId = num(locals.subjectId);
    return {
      assessment: {
        id: num(assessment.id),
        title: isPost ? 'Post-Assessment' : 'Pre-Assessment',
        kind: isPost ? 'post' : 'pre',
        instructions: str(assessment.instructions) || 'Answer every item as best you can.'
      },
      subjectId,
      subjectName: str(locals.assignment && locals.assignment.subject_name),
      submitPath: `/subjects/${subjectId}/${isPost ? 'post-assessment' : 'pre-assessment'}`,
      cancelPath: `/subjects/${subjectId}`,
      startedAt: str(locals.startedAt),
      requireAll: false,
      antiCheat: antiCheatOf(locals.antiCheat),
      questions: questionsForAnswering(assessment.questions, { tf: { true: 'true', false: 'false' } })
    };
  },

  /** A tutor's activity, a module post-test, or a learning-path module assessment. */
  'student-take-tutor-assessment'(locals) {
    const assessment = locals.assessment || {};
    const subjectId = num(locals.subjectId);
    const submitTo = locals.formAction
      ? appPath(locals.formAction)
      : locals.isPre ? `/subjects/${subjectId}/pre-assessment` : `/tutor-assessments/${num(assessment.id)}/submit`;
    return {
      assessment: {
        id: num(assessment.id),
        title: str(assessment.title),
        kind: locals.isPre ? 'pre' : (locals.formAction ? 'module' : (assessment.purpose === 'post' ? 'post_test' : 'activity')),
        label: str(locals.pillLabel) || (locals.isPre ? 'Pre-Assessment' : assessment.purpose === 'post' ? 'Post-Assessment' : 'Activity'),
        instructions: str(assessment.instructions)
      },
      subjectId,
      subjectName: str(locals.subjectName),
      submitPath: submitTo,
      cancelPath: locals.cancelHref ? appPath(locals.cancelHref) : `/subjects/${subjectId}`,
      startedAt: str(locals.startedAt),
      // The website's form marks every item `required` here (not on the Pre/Post).
      requireAll: true,
      antiCheat: antiCheatOf(locals.antiCheat),
      questions: questionsForAnswering(assessment.questions, { tf: { true: 'True', false: 'False' } })
    };
  },

  /**
   * A result — after the submission, exactly as the website shows it: the
   * correct answer and the reason only on the items the student missed.
   */
  'student-assessment-breakdown'(locals) {
    const submission = locals.submission || {};
    const answers = list(submission.answers);
    const optionText = (options, label) => {
      const hit = list(options).find((o) => String(o.option_label) === String(label));
      return hit ? str(hit.option_text) : '';
    };
    return {
      submission: {
        id: num(submission.id),
        title: str(submission.title),
        subjectId: num(submission.subject_id),
        subjectName: str(submission.subject_name),
        submittedAt: submission.submitted_at || null,
        percentage: num(submission.percentage) || 0,
        level: str(submission.level) || 'Beginner',
        score: num(submission.score) || 0,
        totalPoints: num(submission.total_points) || 0,
        correct: answers.filter((a) => a.is_correct === true || Number(a.is_correct) === 1).length,
        incorrect: answers.filter((a) => !(a.is_correct === true || Number(a.is_correct) === 1)).length
      },
      bands: LEVEL_BANDS,
      // Worst first: the point of the page is what to study next.
      topics: list(locals.weakAreas)
        .map((area) => ({
          moduleNumber: num(area.order_number),
          moduleTitle: str(area.module_title),
          handoutName: str(area.handout_name),
          correct: num(area.correct) || 0,
          total: num(area.total) || 0,
          percentage: num(area.percentage) || 0,
          isWeak: !!area.is_weak
        }))
        .sort((a, b) => a.percentage - b.percentage),
      answers: answers.map((a, index) => {
        const isCorrect = a.is_correct === true || Number(a.is_correct) === 1;
        const type = str(a.question_type);
        const item = {
          number: index + 1,
          type,
          text: str(a.question_text),
          isCorrect,
          pointsEarned: num(a.points_earned) || 0,
          points: num(a.points) || 0,
          yourAnswer: str(a.student_answer),
          yourAnswerText: type === 'multiple_choice' ? optionText(a.options, a.student_answer) : '',
          feedback: str(a.ai_feedback),
          source: [a.source_order_number ? `Module ${a.source_order_number}` : '', str(a.source_module_title), str(a.source_handout_name)]
            .filter(Boolean).join(' · ')
        };
        if (!isCorrect) {
          item.correctAnswer = type === 'essay' ? str(a.answer_rubric || a.correct_answer) : str(a.correct_answer);
          item.correctAnswerText = type === 'multiple_choice' ? optionText(a.options, a.correct_answer) : '';
          item.explanation = str(a.explanation);
        }
        return item;
      })
    };
  },

  /** A module: the office's (to view) or the one written for the student's level. */
  'student-module-view'(locals) {
    const mod = locals.mod || {};
    const lesson = locals.levelModule || null;
    const elsewhere = locals.levelModuleLink || null;
    const submissions = list(locals.submissions);
    return {
      module: {
        id: num(mod.id),
        number: num(mod.order_number),
        title: str(mod.title),
        description: str(mod.description),
        subjectId: num(mod.subject_id),
        subjectName: str(mod.subject_name)
      },
      viewOnlyNote: str(locals.viewOnly),
      // The lesson of the level module: raw text, laid out by the app with the
      // same marks as views/partials/level-lesson.ejs ("## ", "- ", "1. ", "Answer:").
      lesson: lesson
        ? {
          id: num(lesson.id),
          level: str(lesson.level),
          status: str(lesson.status),
          parts: list(lesson.sections).map((part, index) => ({
            number: index + 1,
            title: str(part.title) || `Part ${index + 1}`,
            text: str(part.content_text)
          }))
        }
        : null,
      levelModuleLink: elsewhere ? { id: num(elsewhere.id), level: str(elsewhere.level), path: `/level-modules/${num(elsewhere.id)}` } : null,
      handouts: list(locals.handouts).map((h) => ({
        id: num(h.id),
        title: str(h.title || h.file_original_name || 'Handout'),
        fileName: str(h.file_original_name),
        sizeKb: h.file_size_bytes ? Math.round(Number(h.file_size_bytes) / 1024) : null,
        fileUrl: fileLink(h.file_path)
      })),
      progress: elsewhere ? null : {
        percent: num(locals.progressPercent) || 0,
        completed: num(locals.completedTasks) || 0,
        total: num(locals.totalTasks) || 0
      },
      activities: elsewhere ? [] : list(locals.activities).map((a) => workItem(a, submissions)),
      postTests: elsewhere ? [] : list(locals.postAssessments).map((a) => workItem(a, submissions))
    };
  },

  /** The student's own copy of a module on their learning path. */
  'student-path-module'(locals) {
    const row = locals.row || {};
    const submissions = list(locals.submissions);
    // Activities written for this student alone carry their own answer; the
    // shared ones are matched against the student's submissions.
    const activityOf = (a) => (a.submission_id
      ? {
        id: num(a.id),
        title: str(a.title),
        done: { submissionId: num(a.submission_id), score: num(a.score), totalPoints: num(a.total_points), percentage: num(a.percentage) }
      }
      : workItem(a, submissions));
    return {
      module: {
        id: num(row.id),
        number: num(row.order_number || row.position),
        title: str(row.module_title),
        status: str(row.status),
        subjectId: num(row.subject_id),
        subjectName: str(locals.assignment && locals.assignment.subject_name),
        additionsStatus: str(row.additions_status),
        takeState: str(row.take_state),
        pdfUrl: `/api/mobile/student/path-modules/${num(row.id)}/pdf`,
        assessmentPath: row.take_state === 'can_take' ? `/path-modules/${num(row.id)}/assessment` : null
      },
      passLabel: str(locals.passLabel) || 'Advance (81%)',
      viewOnlyNote: str(locals.viewOnly),
      // "Added for You": their weak points with five topics each. The missed
      // Pre-Assessment items behind them are for their tutor, not shown here.
      weakPoints: list(row.weakPoints).map((point) => ({
        no: num(point.no),
        title: str(point.title),
        afterPage: num(point.after_page),
        focus: str(point.focus),
        legacy: !!point.legacy,
        topics: list(point.topics).map((topic) => ({ no: num(topic.no), title: str(topic.title), text: str(topic.text) }))
      })),
      attempts: list(locals.attempts).map((attempt) => ({
        number: num(attempt.attempt_number),
        score: num(attempt.score),
        totalPoints: num(attempt.total_points),
        percentage: num(attempt.percentage),
        level: str(attempt.level),
        submittedAt: attempt.submitted_at || null
      })),
      activities: list(locals.activities).map(activityOf)
    };
  },

  /** Billing Data: what is owed, how to pay, and what has been paid. */
  'student-billing'(locals) {
    const data = locals.billingData || {};
    const totals = data.totals || {};
    const bill = data.bill || null;
    const pending = data.pendingRequest || null;
    const floor = data.paymentFloor || { amount: data.minimumPayment, kind: 'down_payment', remaining: totals.remaining };
    const remaining = num(totals.remaining) || 0;
    return {
      hasBill: !!bill,
      totals: {
        totalBilled: num(totals.totalBilled) || 0,
        totalPaid: num(totals.totalPaid) || 0,
        remaining,
        paymentCount: num(totals.paymentCount) || 0
      },
      paymentDue: bill ? bill.payment_due || null : null,
      floor: {
        amount: num(floor.amount) || 0,
        kind: str(floor.kind) || 'down_payment',
        remaining: num(floor.remaining),
        billed: num(floor.billed)
      },
      minimumPayment: num(data.minimumPayment) || 0,
      pendingSlip: pending
        ? { amount: num(pending.amount), createdAt: pending.created_at || null, branchName: str(pending.branch_name) }
        : null,
      branchName: str(locals.branchName),
      paymentMethods: list(locals.paymentMethods).map((method) => ({
        value: str(method.value), label: str(method.label), enabled: !!method.enabled, description: str(method.description)
      })),
      entries: list(data.entries).map((entry) => ({
        sequenceNo: num(entry.sequence_no),
        paidAt: entry.paid_at || null,
        amount: num(entry.amount),
        method: str(entry.payment_method) || 'Cash',
        purpose: str(entry.purpose) || 'Tuition',
        referenceNo: str(entry.reference_no),
        balanceAfter: num(entry.balance_after),
        locked: Number(entry.is_locked) === 1
      })),
      requests: list(data.requests).map((request) => ({
        createdAt: request.created_at || null,
        amount: num(request.amount),
        branchName: str(request.branch_name),
        preferredAt: request.preferred_at || null,
        status: str(request.status)
      })),
      statements: list(data.statements).map((statement) => ({
        statementDate: statement.statement_date || null,
        type: str(statement.soa_type) || 'Regular SOA',
        fullBill: num(statement.full_bill),
        paid: num(statement.partial_payment),
        balance: num(statement.for_settlement),
        paymentDue: statement.payment_due || null
      })),
      openPay: !!locals.openPay
    };
  },

  /** The payment slip the student shows at the counter. */
  'student-payment-slip'(locals) {
    const slip = locals.slip || {};
    const totals = slip.totals || {};
    return {
      slip: {
        code: str(slip.slipCode),
        studentName: str(slip.student && slip.student.name),
        studentCode: str(slip.student && slip.student.code),
        branchName: str(slip.branchName),
        issuedAt: slip.issuedAt || null,
        dueDate: slip.dueDate || null,
        subjects: list(slip.subjects).map((subject) => ({
          name: str(subject.name), startDate: subject.startDate || null, endDate: subject.endDate || null, amount: num(subject.amount)
        })),
        totals: { billed: num(totals.billed), paid: num(totals.paid), remaining: num(totals.remaining) },
        minimumNow: num(slip.minimumNow),
        floorKind: str(slip.floorKind),
        declaredAmount: num(slip.declaredAmount)
      },
      hasOpenSlip: !!locals.slipRequest,
      pdfUrl: '/api/mobile/student/billing/slip.pdf'
    };
  },

  /** My Profile: the fields the student may edit, and those the office sets. */
  'student-profile'(locals) {
    const user = locals.profileUser || {};
    const assignments = list(locals.assignments);
    const tutors = [];
    for (const item of assignments.filter((a) => a.tutor_internal_id)) {
      if (tutors.some((t) => Number(t.id) === Number(item.tutor_internal_id))) continue;
      tutors.push({ id: num(item.tutor_internal_id), name: str(item.tutor_name), schedule: [item.preferred_days, item.time_slot].filter(Boolean).join(', ') });
    }
    return {
      profile: {
        code: str(user.user_id),
        firstName: str(user.first_name),
        middleName: str(user.middle_name),
        lastName: str(user.last_name),
        birthDate: user.birth_date || null,
        // As the website's date box fills it (lib/utils.js toInputDate), so a
        // save sends back exactly the day that is stored.
        birthDateInput: toInputDate(user.birth_date),
        age: num(user.age),
        gender: str(user.gender),
        contactNumber: str(user.contact_number),
        parentEmail: str(user.parent_email || user.email),
        parentFacebook: str(user.parent_facebook || user.facebook_account),
        parentGuardianName: str(user.parent_guardian_name),
        parentContactNumber: str(user.parent_contact_number),
        address: str(user.address),
        imagePath: photo(user.image_path),
        joinedAt: user.created_at || null,
        // Set by the office; shown, never sent back.
        email: str(user.email),
        yearLevel: str(user.year_level),
        gradeLevel: str(user.grade_level),
        branchName: str(user.branch_name)
      },
      tutors,
      subjects: assignments.map(assignmentOf)
    };
  },

  /** My Progress: per subject, the level, modules and every assessment. */
  'student-progress'(locals) {
    const subjects = list(locals.subjects);
    const taken = subjects.flatMap((s) => list(s.attempts).filter((row) => row.percentage != null));
    const kindOf = (row) => (row.assessment_type === 'pre' ? 'Pre-Assessment'
      : row.assessment_type === 'post' ? 'Post-Assessment'
        : row.assessment_type === 'module_test' ? 'Module assessment' : 'Module activity');
    return {
      overview: {
        overallAverage: taken.length ? Number((taken.reduce((sum, row) => sum + Number(row.percentage || 0), 0) / taken.length).toFixed(1)) : null,
        assessmentsTaken: taken.length,
        subjects: list(locals.assignments).length,
        modulesOpened: subjects.reduce((sum, s) => sum + Number((s.stats || {}).totalModulesRead || 0), 0),
        modulesTotal: subjects.reduce((sum, s) => sum + Number((s.stats || {}).totalModules || 0), 0),
        preAssessmentsDone: subjects.filter((s) => (s.stats || {}).preAssessment).length
      },
      subjects: subjects.map((s) => {
        const st = s.stats || {};
        const preRow = st.preAssessment;
        const postRow = st.postAssessment;
        const viewOnly = !!(s.assignment && s.assignment.view_only);
        return {
          subjectId: num(s.subject && s.subject.id),
          subjectName: str(s.subject && s.subject.name),
          currentLevel: str(st.currentLevel),
          modulesOpened: num(st.totalModulesRead) || 0,
          modulesTotal: num(st.totalModules) || 0,
          violations: num(st.totalViolations) || 0,
          pre: preRow ? { score: num(preRow.score), totalPoints: num(preRow.total_points), percentage: num(preRow.percentage), level: str(preRow.level) } : null,
          post: postRow ? { score: num(postRow.score), totalPoints: num(postRow.total_points), percentage: num(postRow.percentage), level: str(postRow.level) } : null,
          activitiesDone: num((s.completion || {}).assessmentsDone) || 0,
          activitiesTotal: num((s.completion || {}).assessmentsTotal) || 0,
          viewOnly,
          assessments: list(s.assessments).map((a) => ({
            title: str(a.title),
            kind: kindOf(a),
            module: str(a.source_module_title),
            score: num(a.score),
            totalQuestions: num(a.total_questions),
            percentage: num(a.percentage),
            level: str(a.level),
            takenAt: a.taken_at || null,
            // Where the row opens, as on the website.
            path: a.submission_id ? `/results/${num(a.submission_id)}`
              : a.attempt_id ? (a.path_module_id ? `/path-modules/${num(a.path_module_id)}` : null)
                : viewOnly ? null : `/tutor-assessments/${num(a.id)}`
          }))
        };
      })
    };
  },

  /** Notifications: tutors' answers to the student's requests, then updates. */
  'user-notifications'(locals) {
    return {
      answers: list(locals.scheduleUpdates).map((row) => ({
        id: num(row.id),
        accepted: String(row.status || '').toLowerCase() === 'accepted',
        tutorName: str(row.tutor_name) || fullName(row, 'tutor_'),
        tutorImagePath: photo(row.tutor_image_path),
        subjectName: str(row.subject_name),
        preferredDays: str(row.preferred_days),
        timeSlot: str(row.time_slot),
        at: row.updated_at || row.created_at || null
      })),
      updates: list(locals.allAlerts).map(alertOf)
    };
  },

  'user-notification-archive'(locals) {
    return { archived: list(locals.archivedAlerts).map(alertOf) };
  },

  'user-notification-history'(locals) {
    return {
      requests: list(locals.requestHistory).map((row) => ({
        tutorName: str(row.tutor_name),
        subjectName: str(row.subject_name),
        preferredDays: str(row.preferred_days),
        timeSlot: str(row.time_slot),
        status: str(row.status),
        decidedAt: row.decided_at || row.updated_at || null
      })),
      read: list(locals.readAlerts).map(alertOf)
    };
  }
};

/** An app notification addressed to the student. */
function alertOf(alert) {
  const link = str(alert.link_url);
  return {
    id: num(alert.id),
    title: str(alert.title),
    message: str(alert.message),
    isRead: alert.is_read === true || Number(alert.is_read) === 1,
    createdAt: alert.created_at || null,
    readAt: alert.read_at || null,
    // Only the student's own pages open from the app.
    path: link.startsWith('/student') ? appPath(link) : null
  };
}

/** Every score of a learning path, and the Pre against the Post (getPathScores). */
function pathScoresOf(scores) {
  if (!scores) return null;
  const sub = (row) => (row ? { score: num(row.score), totalPoints: num(row.total_points), percentage: num(row.percentage), level: str(row.level) } : null);
  return {
    pre: sub(scores.pre),
    post: sub(scores.post),
    comparison: scores.comparison ? pick(scores.comparison, ['prePct', 'postPct', 'delta', 'preLevel', 'postLevel', 'levelChanged']) : null,
    modules: list(scores.modules).map((m) => ({
      number: num(m.number),
      title: str(m.title),
      pre: m.pre ? { correct: num(m.pre.correct), total: num(m.pre.total) } : null,
      post: m.post ? { correct: num(m.post.correct), total: num(m.post.total) } : null,
      prePct: num(m.prePct),
      postPct: num(m.postPct),
      change: num(m.change)
    })),
    rows: list(scores.rows).map((r) => ({
      kind: str(r.kind),
      title: str(r.title),
      module: str(r.module),
      score: num(r.score),
      total: num(r.total),
      percentage: num(r.percentage),
      level: str(r.level),
      at: r.at || null,
      passed: r.kind === 'take' ? !!r.passed : null,
      // A take of a module assessment shows its score only (as on the website).
      path: r.kind !== 'take' && r.submissionId ? `/results/${num(r.submissionId)}` : null
    }))
  };
}

/** "../content/student-subject-detail" -> "student-subject-detail". */
function viewKeyOf(view, locals = {}) {
  const source = str(locals.contentView || view);
  return source.split('/').pop().replace(/\.ejs$/, '');
}

/**
 * The app's copy of one rendered page: only the whitelisted fields of its
 * view, or null for a view the app does not show.
 */
function serialize(viewKey, locals = {}, context = {}) {
  const serializer = SERIALIZERS[viewKey];
  if (!serializer) return null;
  return serializer(locals, context);
}

module.exports = {
  SERIALIZERS,
  serialize,
  viewKeyOf,
  appPath,
  fileLink,
  questionsForAnswering,
  pick
};
