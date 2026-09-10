/**
 * ANNOTATED COPY FOR DEFENSE REVIEW
 * File: config/db.js
 * Purpose: Database connection wrapper for Microsoft SQL Server. This file centralizes connection pooling, SQL parameter conversion, query execution, and transaction helpers.
 * Notes: Comments were added to help explain the system during code defense without changing the original logic.
 */

require('dotenv').config();
const sql = require('mssql');

const baseConfig = {
  server: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 1433),
  user: process.env.DB_USER || 'sa',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'mindquest1_db',
  options: {
    encrypt: false,
    trustServerCertificate: String(process.env.DB_TRUST_SERVER_CERTIFICATE || 'true').toLowerCase() === 'true',
    enableArithAbort: true
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  },
  requestTimeout: Number(process.env.DB_REQUEST_TIMEOUT || 60000),
  connectionTimeout: Number(process.env.DB_CONNECTION_TIMEOUT || 30000)
};

/**
 * ── Surviving a dropped connection ──────────────────────────────────────────
 *
 * The database is a remote, shared host that closes idle sockets and drops
 * connections under load. Two things made every one of those drops permanent:
 *
 *  1. `poolPromise` was cached forever, *including when it rejected*. One failed
 *     connect — a blip during boot, a restart at the far end — and every query
 *     for the rest of the process's life awaited that same rejected promise. The
 *     app looked dead until someone restarted it, with a fresh server sitting
 *     right there able to connect.
 *  2. A socket that died between queries surfaced as "Connection lost -
 *     read ECONNRESET" on whatever page the user happened to be opening, with no
 *     attempt to get a working connection and try again.
 *
 * So a failed connect is no longer remembered, and a lost connection retires the
 * pool so the next caller builds a new one.
 */
const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ESOCKET', 'ETIMEOUT', 'ETIMEDOUT',
  'ECONNCLOSED', 'ENOTOPEN', 'EPIPE', 'ECONNREFUSED'
]);

const TRANSIENT_TEXT = [
  'connection lost', 'connection is closed', 'connection not yet open',
  'socket hang up', 'the connection is closed'
];

/** True when the error is the connection dying, not the statement being wrong. */
function isTransientConnectionError(error) {
  if (!error) return false;
  const code = error.code || error.originalError?.code || error.originalError?.originalError?.code;
  if (code && TRANSIENT_CODES.has(code)) return true;
  const message = String(error.message || '').toLowerCase();
  return TRANSIENT_TEXT.some((fragment) => message.includes(fragment));
}

let poolPromise;

/** Drop the cached pool so the next caller opens a fresh one. */
function retirePool(reason) {
  if (!poolPromise) return;
  const dying = poolPromise;
  poolPromise = null;
  console.error(`[db] connection pool retired: ${reason}`);
  // Close in the background. A pool whose socket already died will often reject
  // here, and that must not become an unhandled rejection.
  Promise.resolve(dying)
    .then((pool) => pool.close())
    .catch(() => {});
}

// Function: getPool
// Role: Provides helper logic for this file.
function getPool() {
  if (!poolPromise) {
    const pool = new sql.ConnectionPool(baseConfig);
    // Without a listener, the pool emitting 'error' takes the whole process down
    // — an EventEmitter with no 'error' handler throws. This is the one place
    // that can hear a socket die while no query is in flight.
    pool.on('error', (error) => retirePool(error.message || 'pool error'));
    poolPromise = pool.connect().catch((error) => {
      // Never cache a rejection: the next request deserves a fresh attempt.
      poolPromise = null;
      throw error;
    });
  }
  return poolPromise;
}

// Function: rewriteLimit

// Role: Provides helper logic for this file.

function rewriteLimit(sqlText) {
  return sqlText.replace(/select\s+(distinct\s+)?([\s\S]*?)\s+limit\s+(\d+)\s*;?$/i, (_m, distinctPart = '', selectBody, limitValue) => {
    return `SELECT ${distinctPart || ''}TOP ${limitValue} ${selectBody}`;
  });
}

// Function: transformSql

// Role: Provides helper logic for this file.

function transformSql(sqlText) {
  let text = String(sqlText || '').trim();
  text = text.replace(/`([^`]+)`/g, '[$1]');
  text = text.replace(/NOW\(\)/gi, 'DATEADD(hour, 8, GETUTCDATE())');
  text = text.replace(/\bCURRENT_TIMESTAMP\b/gi, 'DATEADD(hour, 8, GETUTCDATE())');
  text = rewriteLimit(text);
  // Placeholders, but ONLY outside string literals (audit bug #8).
  //
  // The previous version replaced every `?` in the statement, including one
  // inside a quoted literal — `WHERE title = 'What is it?'` became
  // `'What is it@p0'`, silently corrupting the value and shifting every
  // parameter after it by one. No query in the codebase happened to contain a
  // question mark in text, so it never fired; it would have been a very
  // confusing first failure. Walking the string keeps the scan honest about
  // where it is, and doubled quotes ('' inside a literal) are handled because
  // they simply close and reopen the literal.
  const params = [];
  let index = 0;
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") inString = !inString;
    if (ch === '?' && !inString) {
      const name = `p${index++}`;
      params.push(name);
      out += `@${name}`;
      continue;
    }
    out += ch;
  }
  return { text: out, params };
}

// Function: runQuery

// Role: Handles a reusable server-side operation used by this module.

async function runQuery(executor, sqlText, values = []) {
  const { text, params } = transformSql(sqlText);
  const request = executor.request();
  request.multiple = true;
  params.forEach((name, i) => {
    const val = values[i];
    if (val === null || val === undefined) {
      request.input(name, sql.NVarChar, null);
    } else if (typeof val === 'boolean') {
      request.input(name, sql.Bit, val ? 1 : 0);
    } else if (val instanceof Date) {
      request.input(name, sql.DateTime, val);
    } else if (typeof val === 'number') {
      // Use Decimal(18,4) for all numbers - handles both int and float correctly
      // MSSQL will auto-convert Decimal to int columns when needed
      request.input(name, sql.Decimal(18, 4), val);
    } else {
      request.input(name, sql.NVarChar(sql.MAX), String(val));
    }
  });
  const isInsert = /^\s*insert\s+/i.test(text);
  const result = await request.query(isInsert ? `${text}; SELECT CAST(SCOPE_IDENTITY() AS INT) AS insertId;` : text);
  if (isInsert) {
    const recordsets = result.recordsets || [];
    const insertId = recordsets[recordsets.length - 1]?.[0]?.insertId ?? null;
    return { insertId, rowsAffected: result.rowsAffected };
  }
  return result.recordset || [];
}

// Function: query

// Role: Handles a reusable server-side operation used by this module.

/**
 * True for a statement that only reads. Used to decide what may be retried.
 *
 * The distinction matters because a connection can die *after* the server has
 * already applied the statement. Replaying a SELECT in that window costs nothing;
 * replaying an INSERT can write the row twice — an extra payment, an extra
 * enrolment. So a write is never retried automatically, even though the pool is
 * still retired so the *next* request finds a working connection.
 */
function isReadOnlyStatement(sqlText) {
  const text = String(sqlText || '').trim().toLowerCase();
  if (!/^(select|with)\b/.test(text)) return false;
  return !/\b(insert|update|delete|merge|drop|alter|create|truncate|exec)\b/.test(text);
}

// Function: query

// Role: Handles a reusable server-side operation used by this module.

async function query(sqlText, params = []) {
  const canRetry = isReadOnlyStatement(sqlText);
  // One retry, not a loop: if a second fresh connection also dies the database
  // is genuinely unavailable, and hammering it turns a blip into an outage.
  for (let attempt = 0; ; attempt++) {
    try {
      const pool = await getPool();
      return await runQuery(pool, sqlText, params);
    } catch (error) {
      if (!isTransientConnectionError(error)) throw error;
      retirePool(error.message || 'lost connection during a query');
      if (attempt >= 1 || !canRetry) throw error;
      console.error('[db] retrying the read on a fresh connection.');
    }
  }
}

// Function: withTransaction

// Role: Handles a reusable server-side operation used by this module.

async function withTransaction(work) {
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  const connection = {
    query: async (sqlText, params = []) => {
      const rows = await runQuery(transaction, sqlText, params);
      return [rows];
    }
  };

  try {
    const result = await work(connection);
    await transaction.commit();
    return result;
  } catch (error) {
    try {
      if (!transaction._aborted && !transaction._rollbackRequested) {
        await transaction.rollback();
      }
    } catch (_rollbackError) {
      // Preserve the original database error so callers see the real cause.
    }
    // The work itself is never replayed — it may have side effects, and half of
    // it may already have been applied. But a pool whose socket died must not be
    // handed to the next caller, or one drop cascades into every later request.
    if (isTransientConnectionError(error)) {
      retirePool(error.message || 'lost connection during a transaction');
    }
    throw error;
  }
}

module.exports = { sql, getPool, query, withTransaction, baseConfig };
