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

let poolPromise;
// Function: getPool
// Role: Provides helper logic for this file.
function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(baseConfig).connect();
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
  text = text.replace(/NOW\(\)/gi, 'SYSDATETIME()');
  text = text.replace(/\bCURRENT_TIMESTAMP\b/gi, 'SYSDATETIME()');
  text = rewriteLimit(text);
  const params = [];
  let index = 0;
  text = text.replace(/\?/g, () => {
    const name = `p${index++}`;
    params.push(name);
    return `@${name}`;
  });
  return { text, params };
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

async function query(sqlText, params = []) {
  const pool = await getPool();
  return runQuery(pool, sqlText, params);
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
    throw error;
  }
}

module.exports = { sql, getPool, query, withTransaction, baseConfig };
