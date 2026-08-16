// Windowed, filterable queries against the logs table.
//
// Ordering is always ts DESC, id DESC (id as a stable tiebreaker so equal
// timestamps produce a total order and windows never overlap or skip rows).
import { MAX_LIMIT, SEVERITIES } from './config.js';

/**
 * Validate and normalize query parameters. Returns { ok, value, error }.
 */
export function parseLogParams(query) {
  const offset = parseIntStrict(query.offset, 0);
  const limit = parseIntStrict(query.limit, 100);
  const severity = query.severity === undefined ? null : String(query.severity);
  const q = query.q === undefined ? null : String(query.q);

  if (offset === null || offset < 0) {
    return { ok: false, error: 'offset must be a non-negative integer' };
  }
  if (limit === null || limit < 1) {
    return { ok: false, error: 'limit must be a positive integer' };
  }
  if (limit > MAX_LIMIT) {
    return { ok: false, error: `limit must not exceed ${MAX_LIMIT}` };
  }
  if (severity !== null && !SEVERITIES.includes(severity)) {
    return {
      ok: false,
      error: `severity must be one of: ${SEVERITIES.join(', ')}`,
    };
  }

  return {
    ok: true,
    value: {
      offset,
      limit,
      severity,
      q: q && q.trim() !== '' ? q : null,
    },
  };
}

function parseIntStrict(raw, fallback) {
  if (raw === undefined) return fallback;
  const s = String(raw).trim();
  if (!/^-?\d+$/.test(s)) return null;
  return Number(s);
}

/**
 * Build the shared WHERE clause and parameter list for filters.
 */
function buildWhere(severity, q) {
  const clauses = [];
  const params = [];
  if (severity !== null) {
    params.push(severity);
    clauses.push(`severity = $${params.length}`);
  }
  if (q !== null) {
    // Case-insensitive substring match. ILIKE with %term% is accelerated by the
    // trigram GIN index when the search term is >= 3 chars.
    params.push(`%${escapeLike(q)}%`);
    clauses.push(`message ILIKE $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { where, params };
}

function escapeLike(s) {
  // Escape LIKE wildcards so user input is treated literally.
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Execute the windowed query, returning { total, rows }.
 * `total` is the exact count for the given filters.
 */
export async function queryLogs(db, { offset, limit, severity, q }) {
  const { where, params } = buildWhere(severity, q);

  const countSql = `SELECT COUNT(*)::int AS total FROM logs ${where};`;
  const countRes = await db.query(countSql, params);
  const total = countRes.rows[0]?.total ?? 0;

  // Window slice. LIMIT/OFFSET is index-backed by the (ts DESC, id DESC)
  // ordering indexes, so deep offsets remain fast.
  const rowsSql = `
    SELECT id, ts, severity, service, message
    FROM logs
    ${where}
    ORDER BY ts DESC, id DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2};
  `;
  const rowsRes = await db.query(rowsSql, [...params, limit, offset]);

  return { total, rows: rowsRes.rows };
}

/**
 * Stats for the filter bar: total and per-severity counts.
 */
export async function queryStats(db) {
  const totalRes = await db.query('SELECT COUNT(*)::int AS total FROM logs;');
  const bySevRes = await db.query(
    'SELECT severity, COUNT(*)::int AS c FROM logs GROUP BY severity;'
  );
  const bySeverity = {};
  for (const sev of SEVERITIES) bySeverity[sev] = 0;
  for (const row of bySevRes.rows) bySeverity[row.severity] = row.c;
  return { total: totalRes.rows[0]?.total ?? 0, bySeverity };
}
