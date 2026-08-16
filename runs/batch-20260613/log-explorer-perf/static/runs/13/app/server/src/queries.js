import { SEVERITIES } from './db.js';

export const MAX_LIMIT = 200;

export class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadRequest';
  }
}

/**
 * Validate and normalize the query params for GET /api/logs.
 * Throws BadRequest on invalid input.
 */
export function parseLogParams(query) {
  const offsetRaw = query.offset ?? '0';
  const limitRaw = query.limit ?? '100';

  const offset = Number(offsetRaw);
  const limit = Number(limitRaw);

  if (!Number.isInteger(offset) || offset < 0) {
    throw new BadRequest('offset must be a non-negative integer');
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new BadRequest('limit must be a positive integer');
  }
  if (limit > MAX_LIMIT) {
    throw new BadRequest(`limit must not exceed ${MAX_LIMIT}`);
  }

  let severity = null;
  if (query.severity !== undefined && query.severity !== '') {
    if (!SEVERITIES.includes(query.severity)) {
      throw new BadRequest(`severity must be one of ${SEVERITIES.join(', ')}`);
    }
    severity = query.severity;
  }

  let q = null;
  if (query.q !== undefined && query.q !== '') {
    q = String(query.q);
  }

  return { offset, limit, severity, q };
}

function buildWhere({ severity, q }) {
  const clauses = [];
  const params = [];
  if (severity) {
    params.push(severity);
    clauses.push(`severity = $${params.length}`);
  }
  if (q) {
    // Case-insensitive substring match. Escape LIKE wildcards in the term.
    const escaped = q.replace(/([\\%_])/g, '\\$1');
    params.push(`%${escaped}%`);
    clauses.push(`message ILIKE $${params.length} ESCAPE '\\'`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { where, params };
}

/**
 * Run the windowed query. Returns { total, rows }.
 * rows are ordered by ts DESC, id DESC (stable) and capped by limit.
 */
export async function queryLogs(db, { offset, limit, severity, q }) {
  const { where, params } = buildWhere({ severity, q });

  const totalRes = await db.query(
    `SELECT COUNT(*)::int AS total FROM logs ${where};`,
    params
  );
  const total = totalRes.rows[0].total;

  const rowsRes = await db.query(
    `SELECT id, ts, severity, service, message
       FROM logs
       ${where}
       ORDER BY ts DESC, id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2};`,
    [...params, limit, offset]
  );

  return { total, rows: rowsRes.rows };
}

/**
 * GET /api/stats -> { total, bySeverity: { debug, info, warn, error } }
 */
export async function queryStats(db) {
  const totalRes = await db.query('SELECT COUNT(*)::int AS total FROM logs;');
  const sevRes = await db.query(
    'SELECT severity, COUNT(*)::int AS c FROM logs GROUP BY severity;'
  );
  const bySeverity = { debug: 0, info: 0, warn: 0, error: 0 };
  for (const row of sevRes.rows) {
    bySeverity[row.severity] = row.c;
  }
  return { total: totalRes.rows[0].total, bySeverity };
}
