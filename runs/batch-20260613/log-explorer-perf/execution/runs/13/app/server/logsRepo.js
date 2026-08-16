// Windowed, filtered query logic against the logs table.
import { SEVERITIES } from './db.js';

export const MAX_LIMIT = 200;

// Parse & validate query params. Returns { ok, error?, params? }.
export function parseQuery(raw) {
  const out = { offset: 0, limit: 100, severity: null, q: null };

  if (raw.offset !== undefined) {
    const o = Number(raw.offset);
    if (!Number.isInteger(o) || o < 0) {
      return { ok: false, error: 'offset must be a non-negative integer' };
    }
    out.offset = o;
  }

  if (raw.limit !== undefined) {
    const l = Number(raw.limit);
    if (!Number.isInteger(l) || l < 1) {
      return { ok: false, error: 'limit must be a positive integer' };
    }
    if (l > MAX_LIMIT) {
      return { ok: false, error: `limit exceeds cap of ${MAX_LIMIT}` };
    }
    out.limit = l;
  }

  if (raw.severity !== undefined && raw.severity !== '') {
    if (!SEVERITIES.includes(raw.severity)) {
      return { ok: false, error: 'unknown severity' };
    }
    out.severity = raw.severity;
  }

  if (raw.q !== undefined && raw.q !== '') {
    if (typeof raw.q !== 'string' || raw.q.length > 200) {
      return { ok: false, error: 'q too long' };
    }
    out.q = raw.q;
  }

  return { ok: true, params: out };
}

// Build WHERE clause + params array from filters.
function buildWhere({ severity, q }) {
  const clauses = [];
  const params = [];
  if (severity) {
    params.push(severity);
    clauses.push(`severity = $${params.length}`);
  }
  if (q) {
    // Case-insensitive substring. Escape LIKE metacharacters in the term.
    const escaped = q.replace(/([%_\\])/g, '\\$1');
    params.push(`%${escaped}%`);
    clauses.push(`message ILIKE $${params.length} ESCAPE '\\'`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { where, params };
}

// Cache exact totals for filter combos so repeated deep-offset windows on the
// same filter don't recount 100k rows every keystroke/scroll. Keyed by filter.
const countCache = new Map();
const COUNT_TTL_MS = 30_000;

function countKey({ severity, q }) {
  return `${severity || ''}::${q || ''}`;
}

export function invalidateCounts() {
  countCache.clear();
}

async function getTotal(db, filters) {
  const key = countKey(filters);
  const now = Date.now();
  const cached = countCache.get(key);
  if (cached && now - cached.at < COUNT_TTL_MS) return cached.total;

  const { where, params } = buildWhere(filters);
  const res = await db.query(
    `SELECT COUNT(*)::int AS total FROM logs ${where};`,
    params
  );
  const total = res.rows[0].total;
  countCache.set(key, { total, at: now });
  return total;
}

export async function queryLogs(db, { offset, limit, severity, q }) {
  const filters = { severity, q };
  const total = await getTotal(db, filters);

  const { where, params } = buildWhere(filters);
  const rowParams = params.slice();
  rowParams.push(limit);
  const limitIdx = rowParams.length;
  rowParams.push(offset);
  const offsetIdx = rowParams.length;

  const res = await db.query(
    `SELECT id, ts, severity, service, message
       FROM logs
       ${where}
       ORDER BY ts DESC, id DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx};`,
    rowParams
  );

  return { total, rows: res.rows };
}

export async function getStats(db) {
  const totalRes = await db.query('SELECT COUNT(*)::int AS total FROM logs;');
  const bySevRes = await db.query(
    `SELECT severity, COUNT(*)::int AS c FROM logs GROUP BY severity;`
  );
  const bySeverity = {};
  for (const s of SEVERITIES) bySeverity[s] = 0;
  for (const row of bySevRes.rows) bySeverity[row.severity] = row.c;
  return { total: totalRes.rows[0].total, bySeverity };
}
