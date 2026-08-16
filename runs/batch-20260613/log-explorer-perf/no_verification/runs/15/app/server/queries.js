import { SEVERITIES } from './db.js';

export const MAX_LIMIT = 200;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

// Parse & validate the query params for GET /api/logs.
// Throws ValidationError (-> 400) on bad input.
export function parseLogParams(query) {
  const rawOffset = query.offset;
  const rawLimit = query.limit;
  const rawSeverity = query.severity;
  const rawQ = query.q;

  let offset = 0;
  if (rawOffset !== undefined && rawOffset !== '') {
    offset = Number(rawOffset);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new ValidationError('offset must be a non-negative integer');
    }
  }

  let limit = 100;
  if (rawLimit !== undefined && rawLimit !== '') {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ValidationError('limit must be a positive integer');
    }
    if (limit > MAX_LIMIT) {
      throw new ValidationError(`limit must not exceed ${MAX_LIMIT}`);
    }
  }

  let severity = null;
  if (rawSeverity !== undefined && rawSeverity !== '' && rawSeverity !== 'all') {
    if (!SEVERITIES.includes(rawSeverity)) {
      throw new ValidationError(`unknown severity: ${rawSeverity}`);
    }
    severity = rawSeverity;
  }

  let q = null;
  if (rawQ !== undefined && rawQ !== '') {
    q = String(rawQ);
    if (q.length > 200) {
      throw new ValidationError('q must be at most 200 characters');
    }
  }

  return { offset, limit, severity, q };
}

// Build the WHERE clause + params shared by the count and window queries.
function buildWhere(severity, q) {
  const clauses = [];
  const params = [];
  if (severity) {
    params.push(severity);
    clauses.push(`severity = $${params.length}`);
  }
  if (q) {
    // Case-insensitive substring. Escape LIKE metacharacters in the user input.
    const escaped = q.replace(/([\\%_])/g, '\\$1').toLowerCase();
    params.push(`%${escaped}%`);
    clauses.push(`lower(message) LIKE $${params.length} ESCAPE '\\'`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { where, params };
}

// Fetch a window: { total, rows } ordered by ts DESC.
export async function queryLogs(db, { offset, limit, severity, q }) {
  const { where, params } = buildWhere(severity, q);

  const countSql = `SELECT COUNT(*)::bigint AS total FROM logs ${where};`;
  const countRes = await db.query(countSql, params);
  const total = Number(countRes.rows[0].total);

  // Window params come after the filter params.
  const rowParams = params.slice();
  rowParams.push(limit);
  const limitIdx = rowParams.length;
  rowParams.push(offset);
  const offsetIdx = rowParams.length;

  const rowsSql = `
    SELECT id, ts, severity, service, message
    FROM logs
    ${where}
    ORDER BY ts DESC, id DESC
    LIMIT $${limitIdx} OFFSET $${offsetIdx};
  `;
  const rowsRes = await db.query(rowsSql, rowParams);

  return { total, rows: rowsRes.rows };
}

// Stats for the filter bar: total + per-severity counts.
export async function queryStats(db) {
  const totalRes = await db.query('SELECT COUNT(*)::bigint AS total FROM logs;');
  const bySevRes = await db.query(
    'SELECT severity, COUNT(*)::bigint AS c FROM logs GROUP BY severity;'
  );
  const bySeverity = {};
  for (const s of SEVERITIES) bySeverity[s] = 0;
  for (const row of bySevRes.rows) {
    bySeverity[row.severity] = Number(row.c);
  }
  return { total: Number(totalRes.rows[0].total), bySeverity };
}
