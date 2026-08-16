// Data access for the logs corpus. All filtering, ordering, counting and
// slicing happens in SQL so the application layer never materializes the whole
// corpus.
import { getDb } from './db.js';
import { SEVERITIES } from './config.js';

/**
 * Build the shared WHERE clause + params for a set of filters.
 * @param {{severity?: string, q?: string}} filters
 * @returns {{clause: string, params: any[]}}
 */
function buildWhere(filters) {
  const conds = [];
  const params = [];
  let p = 1;

  if (filters.severity) {
    conds.push(`severity = $${p++}`);
    params.push(filters.severity);
  }
  if (filters.q) {
    // Case-insensitive substring. lower(message) LIKE lower('%q%') is exactly
    // what the trigram GIN index on lower(message) accelerates.
    conds.push(`lower(message) LIKE '%' || lower($${p++}) || '%'`);
    params.push(filters.q);
  }

  const clause = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  return { clause, params };
}

/**
 * Exact total row count for the given filters.
 * @param {{severity?: string, q?: string}} filters
 * @returns {Promise<number>}
 */
export async function countLogs(filters) {
  const db = getDb();
  const { clause, params } = buildWhere(filters);
  const res = await db.query(`SELECT COUNT(*)::int AS total FROM logs ${clause}`, params);
  return res.rows[0].total;
}

/**
 * One window of rows, ordered by ts DESC (id DESC as a stable tiebreaker).
 * @param {{severity?: string, q?: string, offset: number, limit: number}} args
 */
export async function queryLogs({ severity, q, offset, limit }) {
  const db = getDb();
  const { clause, params } = buildWhere({ severity, q });
  const sql = `
    SELECT id, ts, severity, service, message
    FROM logs
    ${clause}
    ORDER BY ts DESC, id DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `;
  const res = await db.query(sql, [...params, limit, offset]);
  return res.rows;
}

/**
 * Global stats for the filter bar: total + per-severity counts.
 * @returns {Promise<{total:number, bySeverity: Record<string, number>}>}
 */
export async function getStats() {
  const db = getDb();
  const res = await db.query(
    'SELECT severity, COUNT(*)::int AS count FROM logs GROUP BY severity'
  );
  const bySeverity = {};
  for (const s of SEVERITIES) bySeverity[s] = 0;
  let total = 0;
  for (const row of res.rows) {
    bySeverity[row.severity] = row.count;
    total += row.count;
  }
  return { total, bySeverity };
}
