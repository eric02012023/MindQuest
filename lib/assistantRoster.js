/**
 * File: lib/assistantRoster.js
 * Purpose: Who was under which Assistant Admin, and for how long.
 *
 * An Assistant Admin runs one branch, so "their" tutors and students are simply
 * whoever is in that branch — today. That answer disappears the moment the
 * assistant is replaced: the new account takes over the branch, and nothing is
 * left to say who the old one was responsible for. The admin needs exactly that
 * history, so it is written down as it happens:
 *
 *   one row per (assistant, member), opened when the member comes under the
 *   assistant and CLOSED — never deleted — when either side moves on.
 *
 * A closed row keeps its dates and the reason it closed, which is what lets the
 * admin open an archived assistant's profile and still see everyone they had.
 *
 * Keeping it current
 * ------------------
 * syncAssistantRosters() is set-based and idempotent: it closes rows that no
 * longer hold and opens the ones that are missing. It is called after anything
 * that can change who is in a branch (an assistant created, moved, archived or
 * recovered; a registration accepted; a profile saved) and again before a roster
 * is read, so a change made by some other path is caught up at the latest the
 * next time anyone looks.
 *
 * Rows that existed before this table did are back-filled once by sql/schema.sql,
 * dated from whichever came later, the assistant's account or the member's.
 */

const { query } = require('../config/db');

const NOW = 'DATEADD(hour, 8, GETUTCDATE())';

/** Why a row was closed, in words for the profile page. */
const RELEASE_REASONS = {
  assistant_archived: 'Assistant account archived',
  assistant_moved: 'Assistant moved to another branch',
  assistant_removed: 'Assistant account removed',
  branch_removed: 'Branch removed',
  member_moved: 'Moved to another branch'
};

/** True when the error is "this table does not exist" (before the first deploy). */
function isMissingTable(error) {
  return Number(error?.number) === 208 || /invalid object name/i.test(String(error?.message || ''));
}

/**
 * Bring the roster in line with who is in each branch right now.
 * Three statements, each a no-op when nothing changed.
 */
async function syncAssistantRosters() {
  // 1. The assistant no longer runs that branch: archived, moved, or gone.
  await query(
    `UPDATE ar
        SET released_at = ${NOW},
            release_reason = CASE
              WHEN ar.branch_id IS NULL THEN 'branch_removed'
              WHEN a.id IS NULL OR a.role <> 'admin_assistant' THEN 'assistant_removed'
              WHEN a.is_archived = 1 THEN 'assistant_archived'
              ELSE 'assistant_moved'
            END
       FROM assistant_rosters ar
       LEFT JOIN users a ON a.id = ar.assistant_id
      WHERE ar.released_at IS NULL
        AND (ar.branch_id IS NULL
             OR a.id IS NULL
             OR a.role <> 'admin_assistant'
             OR a.is_archived = 1
             OR COALESCE(a.assistant_scope_branch_id, 0) <> ar.branch_id)`
  );

  // 2. The member left the branch. Archiving a member does NOT close the row:
  //    they were still this assistant's, and recovering them should not start a
  //    second stint.
  await query(
    `UPDATE ar
        SET released_at = ${NOW}, release_reason = 'member_moved'
       FROM assistant_rosters ar
       INNER JOIN users m ON m.id = ar.member_id
      WHERE ar.released_at IS NULL
        AND COALESCE(m.branch_id, 0) <> ar.branch_id`
  );

  // 3. Everyone active in a branch belongs to that branch's active assistant(s).
  await query(
    `INSERT INTO assistant_rosters (assistant_id, member_id, branch_id, member_role, linked_at)
     SELECT a.id, m.id, a.assistant_scope_branch_id, m.role, ${NOW}
       FROM users a
       INNER JOIN users m
               ON m.branch_id = a.assistant_scope_branch_id
              AND m.role IN ('student', 'tutor')
              AND m.is_archived = 0
      WHERE a.role = 'admin_assistant'
        AND a.is_archived = 0
        AND a.assistant_scope_branch_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM assistant_rosters ar
           WHERE ar.assistant_id = a.id AND ar.member_id = m.id AND ar.released_at IS NULL
        )`
  );
}

/**
 * The same, for callers that must not fail because of it. A roster that is a
 * moment behind is caught up on the next read; an accepted registration that
 * errors out because the history table hiccupped is not acceptable.
 */
async function syncAssistantRostersSafely() {
  try {
    await syncAssistantRosters();
  } catch (error) {
    if (!isMissingTable(error)) console.error('[assistant roster] sync failed:', error.message);
  }
}

/**
 * One assistant's roster, filtered and paged, with the counts for the header.
 *
 * @param {object} assistant  the admin_assistant user row
 * @param {object} [options]  { role: 'all'|'student'|'tutor',
 *                              period: 'all'|'current'|'former',
 *                              search, page, pageSize }
 */
async function getAssistantRoster(assistant, options = {}) {
  const role = ['student', 'tutor'].includes(options.role) ? options.role : 'all';
  const period = ['current', 'former'].includes(options.period) ? options.period : 'all';
  const search = String(options.search || '').trim().toLowerCase();
  const pageSize = Math.min(100, Math.max(10, Number(options.pageSize) || 25));

  await syncAssistantRostersSafely();

  let rows;
  try {
    rows = await query(
      `SELECT ar.id AS roster_id, ar.member_role, ar.branch_id AS roster_branch_id,
              ar.linked_at, ar.released_at, ar.release_reason,
              m.id, m.user_id, m.first_name, m.middle_name, m.last_name, m.email,
              m.year_level, m.grade_level, m.is_archived, m.branch_id AS current_branch_id,
              rb.name AS roster_branch_name, cb.name AS current_branch_name
         FROM assistant_rosters ar
         INNER JOIN users m ON m.id = ar.member_id
         LEFT JOIN branches rb ON rb.id = ar.branch_id
         LEFT JOIN branches cb ON cb.id = m.branch_id
        WHERE ar.assistant_id = ?
        ORDER BY CASE WHEN ar.released_at IS NULL THEN 0 ELSE 1 END,
                 ar.member_role DESC, m.last_name ASC, m.first_name ASC, ar.linked_at DESC`,
      [Number(assistant.id)]
    );
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    // Before the table exists, the live branch membership is still a truthful
    // answer for "current" — there is just no history yet.
    rows = assistant.is_archived ? [] : await query(
      `SELECT NULL AS roster_id, m.role AS member_role, m.branch_id AS roster_branch_id,
              COALESCE(m.accepted_at, m.created_at) AS linked_at, NULL AS released_at, NULL AS release_reason,
              m.id, m.user_id, m.first_name, m.middle_name, m.last_name, m.email,
              m.year_level, m.grade_level, m.is_archived, m.branch_id AS current_branch_id,
              b.name AS roster_branch_name, b.name AS current_branch_name
         FROM users m
         LEFT JOIN branches b ON b.id = m.branch_id
        WHERE m.branch_id = ? AND m.role IN ('student', 'tutor') AND m.is_archived = 0
        ORDER BY m.role DESC, m.last_name ASC, m.first_name ASC`,
      [Number(assistant.assistant_scope_branch_id) || -1]
    );
  }

  let since = null;
  let until = null;
  for (const row of rows) {
    if (row.linked_at && (!since || new Date(row.linked_at) < new Date(since))) since = row.linked_at;
    if (row.released_at && (!until || new Date(row.released_at) > new Date(until))) until = row.released_at;
  }
  // Counted in people, not rows: someone who moved away and came back has two
  // stints under the same assistant but is still one person.
  const people = (current, tutor) => new Set(rows
    .filter((r) => !r.released_at === current && (r.member_role === 'tutor') === tutor)
    .map((r) => Number(r.id))).size;
  const summary = {
    currentTutors: people(true, true),
    currentStudents: people(true, false),
    formerTutors: people(false, true),
    formerStudents: people(false, false)
  };

  const filtered = rows.filter((row) => {
    if (role !== 'all' && row.member_role !== role) return false;
    if (period === 'current' && row.released_at) return false;
    if (period === 'former' && !row.released_at) return false;
    if (search) {
      const haystack = [row.first_name, row.middle_name, row.last_name, row.user_id, row.email]
        .map((value) => String(value || '').toLowerCase()).join(' ');
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  const total = filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pageCount, Math.max(1, Number(options.page) || 1));

  return {
    rows: filtered.slice((page - 1) * pageSize, page * pageSize).map((row) => ({
      ...row,
      is_current: !row.released_at,
      release_label: row.release_reason ? (RELEASE_REASONS[row.release_reason] || row.release_reason) : ''
    })),
    pager: { page, pageCount, total, pageSize },
    summary,
    since,
    // An assistant who is still active has no end date, even if some of their
    // members have left.
    until: assistant.is_archived ? until : null,
    filters: { role, period, search }
  };
}

/** Current headcount per assistant, for the assistant list on User Management. */
async function getAssistantRosterCounts() {
  await syncAssistantRostersSafely();
  try {
    const rows = await query(
      `SELECT ar.assistant_id,
              SUM(CASE WHEN ar.released_at IS NULL AND ar.member_role = 'tutor' THEN 1 ELSE 0 END) AS current_tutors,
              SUM(CASE WHEN ar.released_at IS NULL AND ar.member_role = 'student' THEN 1 ELSE 0 END) AS current_students,
              COUNT(DISTINCT ar.member_id) AS ever
         FROM assistant_rosters ar
         INNER JOIN users m ON m.id = ar.member_id
        GROUP BY ar.assistant_id`
    );
    return new Map(rows.map((row) => [Number(row.assistant_id), {
      currentTutors: Number(row.current_tutors || 0),
      currentStudents: Number(row.current_students || 0),
      ever: Number(row.ever || 0)
    }]));
  } catch (error) {
    if (isMissingTable(error)) return new Map();
    throw error;
  }
}

module.exports = {
  RELEASE_REASONS,
  syncAssistantRosters,
  syncAssistantRostersSafely,
  getAssistantRoster,
  getAssistantRosterCounts
};
