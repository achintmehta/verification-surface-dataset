// Query building and validation for the windowed log API.
import { MAX_LIMIT, SEVERITIES } from './config.js';

/**
 * Parse and validate query parameters.
 * @returns {{ok: true, value: {offset:number, limit:number, severity:?string, q:?string}} | {ok:false, error:string}}
 */
export function parseParams(query) {
  const raw = query || {};

  // offset
  let offset = 0;
  if (raw.offset !== undefined && raw.offset !== '') {
    offset = Number(raw.offset);
    if (!Number.isInteger(offset) || offset < 0) {
      return { ok: false, error: 'offset must be a non-negative integer' };
    }
  }

  // limit
  let limit = 100;
  if (raw.limit !== undefined && raw.limit !== '') {
    limit = Number(raw.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      return { ok: false, error: 'limit must be a positive integer' };
    }
    if (limit > MAX_LIMIT) {
      return { ok: false, error: `limit must not exceed ${MAX_LIMIT}` };
    }
  }

  // severity (optional exact filter)
  let severity = null;
  if (raw.severity !== undefined && raw.severity !== '') {
    severity = String(raw.severity);
    if (!SEVERITIES.includes(severity)) {
      return {
        ok: false,
        error: `severity must be one of: ${SEVERITIES.join(', ')}`,
      };
    }
  }

  // q (optional case-insensitive substring)
  let q = null;
  if (raw.q !== undefined && raw.q !== '') {
    q = String(raw.q);
    if (q.length > 200) {
      return { ok: false, error: 'q must be at most 200 characters' };
    }
  }

  return { ok: true, value: { offset, limit, severity, q } };
}

// Escape special LIKE metacharacters so the substring is treated literally.
function escapeLike(term) {
  return term.replace(/([\\%_])/g, '\\$1');
}

/**
 * Build the WHERE clause + params shared by count and window queries.
 */
function buildWhere({ severity, q }) {
  const clauses = [];
  const params = [];
  let p = 1;

  if (severity) {
    clauses.push(`severity = $${p++}`);
    params.push(severity);
  }
  if (q) {
    // Case-insensitive substring, accelerated by the trigram index on
    // lower(message).
    clauses.push(`lower(message) LIKE $${p++}`);
    params.push('%' + escapeLike(q.toLowerCase()) + '%');
  }

  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  return { where, params };
}

/**
 * Run the windowed query. Returns { total, rows }.
 * Rows are ordered by ts DESC, id DESC and never exceed `limit`.
 */
export async function runLogQuery(pg, { offset, limit, severity, q }) {
  const { where, params } = buildWhere({ severity, q });

  const countSql = `SELECT COUNT(*)::int AS total FROM logs ${where};`;
  const countRes = await pg.query(countSql, params);
  const total = countRes.rows[0]?.total ?? 0;

  // Window query: index-backed ordering + limit/offset.
  const windowParams = params.slice();
  let pp = params.length + 1;
  const limitParam = pp++;
  const offsetParam = pp++;
  windowParams.push(limit, offset);

  const windowSql = `
    SELECT id, ts, severity, service, message
    FROM logs
    ${where}
    ORDER BY ts DESC, id DESC
    LIMIT $${limitParam} OFFSET $${offsetParam};
  `;
  const rowsRes = await pg.query(windowSql, windowParams);

  return { total, rows: rowsRes.rows };
}

/**
 * Total count + per-severity counts for filter-bar badges.
 */
export async function runStatsQuery(pg) {
  const res = await pg.query(`
    SELECT severity, COUNT(*)::int AS n
    FROM logs
    GROUP BY severity;
  `);

  const bySeverity = { debug: 0, info: 0, warn: 0, error: 0 };
  let total = 0;
  for (const row of res.rows) {
    bySeverity[row.severity] = row.n;
    total += row.n;
  }
  return { total, bySeverity };
}
