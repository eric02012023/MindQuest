/**
 * File: lib/rbac.js
 * Purpose: Role-based data scoping, in one place.
 *
 * The spec's requirement is that Analytics & Reports is restricted "at the
 * query/data level, not just hidden in the UI". Hiding a link is not access
 * control: a student who edits the URL, or an assistant who changes ?branch_id=,
 * would still get the rows back.
 *
 * So every scoped query gets its WHERE fragment from here:
 *
 *   admin            everything (optionally narrowed by a branch they picked)
 *   admin_assistant  their assigned branch only, and they cannot widen it
 *   tutor            only students currently assigned to them
 *   student          only themselves
 *
 * Each builder returns { sql, params } meant to be pasted into a WHERE that
 * already has a condition (they all begin with " AND "), which is the same shape
 * buildScopeClause in lib/data.js uses.
 */

/**
 * Normalise whatever the session holds into the facts a scope decision needs.
 *
 * `branchId` for an assistant comes from assistant_scope_branch_id and NEVER from
 * the query string — that difference is the whole point of the function.
 *
 * @param {object} user  req.session.user
 * @param {object} [options]
 * @param {number|string} [options.requestedBranchId]  ?branch_id=, admin only
 * @returns {{role:string, userId:number, branchId:number|null, isAdmin:boolean,
 *            isAssistant:boolean, isTutor:boolean, isStudent:boolean,
 *            canPickBranch:boolean, label:string}}
 */
function resolveScope(user, options = {}) {
  const role = String(user?.role || '');
  const userId = Number(user?.id) || null;

  let branchId = null;
  if (role === 'admin_assistant') {
    branchId = Number(user?.assistant_scope_branch_id) || null;
  } else if (role === 'admin') {
    const requested = options.requestedBranchId;
    if (requested !== undefined && requested !== null && String(requested) !== '' && String(requested) !== 'all') {
      branchId = Number(requested) || null;
    }
  } else {
    branchId = Number(user?.branch_id) || null;
  }

  return {
    role,
    userId,
    branchId,
    isAdmin: role === 'admin',
    isAssistant: role === 'admin_assistant',
    isTutor: role === 'tutor',
    isStudent: role === 'student',
    canPickBranch: role === 'admin',
    label: role === 'admin' ? 'All branches'
      : role === 'admin_assistant' ? 'Your branch'
        : role === 'tutor' ? 'Your students'
          : 'Your own records'
  };
}

/**
 * Restrict a query to the student rows this viewer may see.
 *
 * @param {object} scope   from resolveScope
 * @param {string} alias   the students table alias in the caller's SQL
 * @returns {{sql:string, params:Array}}
 */
function studentScopeClause(scope, alias = 'u') {
  if (scope.isStudent) {
    return { sql: ` AND ${alias}.id = ?`, params: [scope.userId] };
  }

  if (scope.isTutor) {
    // "Only the learners they personally handle": an active assignment row is
    // what makes a student theirs. EXISTS rather than a JOIN so a student taking
    // three of the tutor's subjects is still one row.
    // The alias is deliberately long: callers own queries that already use `usa`,
    // and a repeated alias in a correlated subquery shadows theirs silently.
    return {
      sql: ` AND EXISTS (
        SELECT 1 FROM user_subject_assignments mq_scope_student
        WHERE mq_scope_student.student_id = ${alias}.id
          AND mq_scope_student.tutor_id = ? AND mq_scope_student.is_archived = 0
      )`,
      params: [scope.userId]
    };
  }

  if (scope.branchId) {
    return { sql: ` AND ${alias}.branch_id = ?`, params: [scope.branchId] };
  }

  return { sql: '', params: [] };
}

/**
 * Restrict to the subjects this viewer may see results for.
 * Admin and assistant are not narrowed by subject — their limit is the branch,
 * applied to the student rows instead.
 */
function subjectScopeClause(scope, alias = 'ta') {
  if (scope.isTutor) {
    return {
      sql: ` AND EXISTS (
        SELECT 1 FROM user_subject_assignments mq_scope_subject
        WHERE mq_scope_subject.subject_id = ${alias}.subject_id
          AND mq_scope_subject.tutor_id = ? AND mq_scope_subject.is_archived = 0
      )`,
      params: [scope.userId]
    };
  }
  return { sql: '', params: [] };
}

/**
 * Restrict a billing/payment query. Billing is a staff concern: a tutor has no
 * business seeing it, so their clause is one that can never match.
 */
function billingScopeClause(scope, studentAlias = 'u') {
  if (scope.isStudent) {
    return { sql: ` AND ${studentAlias}.id = ?`, params: [scope.userId] };
  }
  if (scope.isTutor) {
    return { sql: ' AND 1 = 0', params: [] };
  }
  if (scope.branchId) {
    return { sql: ` AND ${studentAlias}.branch_id = ?`, params: [scope.branchId] };
  }
  return { sql: '', params: [] };
}

/** Can this role open Analytics & Reports at all? All four can — with a scope. */
function canViewAnalytics(role) {
  return ['admin', 'admin_assistant', 'tutor', 'student'].includes(String(role || ''));
}

/** Only staff see money. Used to decide which analytics panels are even queried. */
function canViewFinancials(role) {
  return ['admin', 'admin_assistant'].includes(String(role || ''));
}

/**
 * May this staff member act on a record belonging to `branchId`?
 * An admin may act anywhere; an assistant only inside their own branch.
 */
function canActOnBranch(user, branchId) {
  const role = String(user?.role || '');
  if (role === 'admin') return true;
  if (role !== 'admin_assistant') return false;
  const scope = Number(user?.assistant_scope_branch_id) || null;
  if (!scope) return false;
  // A record with no branch is head-office work; only an admin handles it.
  return Number(branchId) === scope;
}

module.exports = {
  resolveScope,
  studentScopeClause,
  subjectScopeClause,
  billingScopeClause,
  canViewAnalytics,
  canViewFinancials,
  canActOnBranch
};
