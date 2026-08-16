const BASE_URL = 'http://localhost:3001';

/**
 * Fetch a window of log rows.
 * @param {object} params
 * @param {number} params.offset
 * @param {number} params.limit
 * @param {string} [params.severity]
 * @param {string} [params.q]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{total: number, rows: Array}>}
 */
export async function fetchLogs({ offset, limit, severity, q }, signal) {
  const url = new URL(`${BASE_URL}/api/logs`);
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('limit', String(limit));
  if (severity) url.searchParams.set('severity', severity);
  if (q && q.trim()) url.searchParams.set('q', q.trim());

  const res = await fetch(url.toString(), { signal });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Fetch global stats (total + per-severity counts).
 * @returns {Promise<{total: number, bySeverity: object}>}
 */
export async function fetchStats() {
  const res = await fetch(`${BASE_URL}/api/stats`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
