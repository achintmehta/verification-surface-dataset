import { getDb, SEVERITIES } from './db.js';

export const MAX_LIMIT = 200;

export class ParamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParamError';
  }
}

/**
 * Parse & validate query params. Throws ParamError on invalid input.
 * Returns { offset, limit, severity|null, q|null }.
 */
export function parseParams(raw) {
  const offsetRaw = raw.offset ?? '0';
  const limitRaw = raw.limit ?? '100';

  if (!/^-?\d+$/.test(String(offsetRaw))) {
    throw new ParamError('offset must be an integer');
  }
  if (!/^-?\d+$/.test(String(limitRaw))) {
    throw new ParamError('limit must be an integer');
  }

  const offset = parseInt(offsetRaw, 10);
  const limit = parseInt(limitRaw, 10);

  if (offset < 0) throw new ParamError('offset must be >= 0');
  if (limit < 1) throw new ParamError('limit must be >= 1');
  if (limit > MAX_LIMIT) throw new ParamError(`limit must be <= ${MAX_LIMIT}`);

  let severity = null;
  if (raw.severity !== undefined && raw.severity !== '') {
    if (!SEVERITIES.includes(raw.severity)) {
      throw new ParamError(`severity must be one of ${SEVERITIES.join(', ')}`);
    }
    severity = raw.severity;
  }

  let q = null;
  if (raw.q !== undefined && raw.q !== '') {
    q = String(raw.q);
  }

  return { offset, limit, severity, q };
}

function buildWhere(severity, q) {
  const clauses = [];
  const params = [];
  let p = 1;
  if (severity) {
    clauses.push(`severity = $${p++}`);
    params.push(severity);
  }
  if (q) {
    clauses.push(`lower(message) LIKE $${p++}`);
    params.push('%' + q.toLowerCase().replace(/[%_\\]/g, (c) => '\\' + c) + '%');
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { where, params };
}

/**
 * Windowed query. Returns { total, rows } ordered by ts DESC, id DESC.
 * The response never exceeds `limit` (<= MAX_LIMIT) rows.
 */
export async function queryLogs({ offset, limit, severity, q }) {
  const d = await getDb();
  const { where, params } = buildWhere(severity, q);

  const countSql = `SELECT COUNT(*)::int AS c FROM logs ${where}`;
  const countRes = await d.query(countSql, params);
  const total = countRes.rows[0].c;

  const rowsSql = `
    SELECT id, ts, severity, service, message
    FROM logs
    ${where}
    ORDER BY ts DESC, id DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `;
  const rowsRes = await d.query(rowsSql, [...params, limit, offset]);

  return { total, rows: rowsRes.rows };
}

/** Total + per-severity counts for the filter bar badges. */
export async function queryStats() {
  const d = await getDb();
  const res = await d.query(`
    SELECT severity, COUNT(*)::int AS c
    FROM logs
    GROUP BY severity
  `);
  const bySeverity = {};
  for (const s of SEVERITIES) bySeverity[s] = 0;
  let total = 0;
  for (const row of res.rows) {
    bySeverity[row.severity] = row.c;
    total += row.c;
  }
  return { total, bySeverity };
}
