import { getDb } from './db.js';

export const MAX_LIMIT = 200;
export const VALID_SEVERITIES = ['debug', 'info', 'warn', 'error'];

/**
 * Validate & normalize incoming query params.
 * Returns { ok: true, params } or { ok: false, error }.
 */
export function parseLogParams(raw) {
  const offset = raw.offset === undefined ? 0 : Number(raw.offset);
  const limit = raw.limit === undefined ? 100 : Number(raw.limit);
  const severity = raw.severity === undefined || raw.severity === '' ? null : String(raw.severity);
  const q = raw.q === undefined || raw.q === '' ? null : String(raw.q);

  if (!Number.isInteger(offset) || offset < 0) {
    return { ok: false, error: 'offset must be a non-negative integer' };
  }
  if (!Number.isInteger(limit) || limit < 1) {
    return { ok: false, error: 'limit must be a positive integer' };
  }
  if (limit > MAX_LIMIT) {
    return { ok: false, error: `limit must not exceed ${MAX_LIMIT}` };
  }
  if (severity !== null && !VALID_SEVERITIES.includes(severity)) {
    return { ok: false, error: `severity must be one of ${VALID_SEVERITIES.join(', ')}` };
  }

  return { ok: true, params: { offset, limit, severity, q } };
}

/**
 * Execute a windowed, filtered query. Returns { total, rows }.
 * Ordering: ts DESC, id DESC (stable). The window is applied by the DB with
 * LIMIT/OFFSET backed by the ordering indexes, so no more than `limit` rows
 * are ever materialized into the response.
 */
export async function queryLogs({ offset, limit, severity, q }) {
  const db = getDb();

  const where = [];
  const params = [];
  let p = 1;

  if (severity !== null) {
    where.push(`severity = $${p++}`);
    params.push(severity);
  }
  if (q !== null) {
    // Case-insensitive substring. lower(message) LIKE lower(%q%) is what the
    // trigram index on lower(message) accelerates.
    where.push(`lower(message) LIKE $${p++}`);
    params.push('%' + q.toLowerCase() + '%');
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Count and page. The count is exact for the filter combination.
  const countRes = await db.query(
    `SELECT COUNT(*)::int AS total FROM logs ${whereSql};`,
    params
  );
  const total = countRes.rows[0].total;

  const pageParams = params.slice();
  const limitIdx = p++;
  const offsetIdx = p++;
  pageParams.push(limit, offset);

  const rowsRes = await db.query(
    `SELECT id, ts, severity, service, message
     FROM logs
     ${whereSql}
     ORDER BY ts DESC, id DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx};`,
    pageParams
  );

  return { total, rows: rowsRes.rows };
}

/**
 * Global stats for the filter bar: total count + per-severity counts.
 */
export async function queryStats() {
  const db = getDb();
  const totalRes = await db.query('SELECT COUNT(*)::int AS total FROM logs;');
  const bySevRes = await db.query(
    `SELECT severity, COUNT(*)::int AS n FROM logs GROUP BY severity;`
  );
  const bySeverity = {};
  for (const s of VALID_SEVERITIES) bySeverity[s] = 0;
  for (const row of bySevRes.rows) bySeverity[row.severity] = row.n;
  return { total: totalRes.rows[0].total, bySeverity };
}
