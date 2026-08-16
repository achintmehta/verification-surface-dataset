import { MAX_LIMIT, SEVERITIES } from './config.js';

export class BadRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadRequestError';
    this.status = 400;
  }
}

/**
 * Parse and validate the query-string params for GET /api/logs.
 * Throws BadRequestError (status 400) on any invalid input.
 */
export function parseLogParams(query) {
  const rawOffset = query.offset ?? '0';
  const rawLimit = query.limit ?? '100';

  if (!/^-?\d+$/.test(String(rawOffset))) {
    throw new BadRequestError('offset must be an integer');
  }
  if (!/^-?\d+$/.test(String(rawLimit))) {
    throw new BadRequestError('limit must be an integer');
  }

  const offset = Number(rawOffset);
  const limit = Number(rawLimit);

  if (offset < 0) {
    throw new BadRequestError('offset must be >= 0');
  }
  if (limit < 1) {
    throw new BadRequestError('limit must be >= 1');
  }
  if (limit > MAX_LIMIT) {
    throw new BadRequestError(`limit must be <= ${MAX_LIMIT}`);
  }

  let severity = null;
  if (query.severity != null && query.severity !== '') {
    if (!SEVERITIES.includes(query.severity)) {
      throw new BadRequestError(`severity must be one of ${SEVERITIES.join(', ')}`);
    }
    severity = query.severity;
  }

  let q = null;
  if (query.q != null && String(query.q).trim() !== '') {
    q = String(query.q);
  }

  return { offset, limit, severity, q };
}

/**
 * Build the WHERE clause and parameter list shared by the count and the window
 * queries. Filters combine with AND.
 */
function buildFilters({ severity, q }, params) {
  const clauses = [];
  if (severity) {
    params.push(severity);
    clauses.push(`severity = $${params.length}`);
  }
  if (q) {
    // Case-insensitive substring match against lower(message), which matches
    // the trigram / functional index expression so it can be used.
    params.push(`%${q.toLowerCase()}%`);
    clauses.push(`lower(message) LIKE $${params.length}`);
  }
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

/**
 * Run the windowed query: returns { total, rows } for the given filters.
 * The response never contains more than `limit` (<= MAX_LIMIT) rows.
 */
export async function queryLogs(db, opts) {
  const { offset, limit } = opts;

  // Total for the filter combination (drives the client's virtual scrollbar).
  const countParams = [];
  const countWhere = buildFilters(opts, countParams);
  const countSql = `SELECT COUNT(*)::bigint AS total FROM logs ${countWhere};`;
  const countRes = await db.query(countSql, countParams);
  const total = Number(countRes.rows[0].total);

  // Window slice, ordered by ts DESC with id DESC as a stable tiebreaker so
  // the row at any offset is well-defined and repeatable.
  const rowParams = [];
  const rowWhere = buildFilters(opts, rowParams);
  rowParams.push(limit);
  const limitIdx = rowParams.length;
  rowParams.push(offset);
  const offsetIdx = rowParams.length;

  const rowSql = `
    SELECT id, ts, severity, service, message
    FROM logs
    ${rowWhere}
    ORDER BY ts DESC, id DESC
    LIMIT $${limitIdx} OFFSET $${offsetIdx};
  `;
  const rowRes = await db.query(rowSql, rowParams);

  const rows = rowRes.rows.map((r) => ({
    id: Number(r.id),
    ts: r.ts instanceof Date ? r.ts.toISOString() : r.ts,
    severity: r.severity,
    service: r.service,
    message: r.message,
  }));

  return { total, rows };
}

/**
 * GET /api/stats: total row count and per-severity counts.
 */
export async function queryStats(db) {
  const totalRes = await db.query(`SELECT COUNT(*)::bigint AS total FROM logs;`);
  const bySevRes = await db.query(`
    SELECT severity, COUNT(*)::bigint AS c
    FROM logs
    GROUP BY severity;
  `);

  const bySeverity = {};
  for (const s of SEVERITIES) bySeverity[s] = 0;
  for (const row of bySevRes.rows) {
    bySeverity[row.severity] = Number(row.c);
  }

  return {
    total: Number(totalRes.rows[0].total),
    bySeverity,
  };
}
