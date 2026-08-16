/**
 * API client for the log explorer backend.
 *
 * Uses relative URLs so the Vite dev proxy (/api → localhost:3001) works
 * in development, and the same code works in production when the frontend
 * is served from the same origin as the backend.
 */

/**
 * Fetch a window of log rows.
 *
 * @param {object} params
 * @param {number}  params.offset
 * @param {number}  params.limit
 * @param {string}  [params.severity]
 * @param {string}  [params.q]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{total: number, rows: Array}>}
 */
export async function fetchLogs({ offset = 0, limit = 100, severity = '', q = '', signal } = {}) {
  const url = new URL('/api/logs', window.location.origin);
  url.searchParams.set('offset', offset);
  url.searchParams.set('limit', limit);
  if (severity) url.searchParams.set('severity', severity);
  if (q)        url.searchParams.set('q', q);

  const res = await fetch(url.toString(), { signal });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status });
  }
  return res.json();
}

/**
 * Fetch aggregate stats (total + per-severity counts).
 * @returns {Promise<{total: number, bySeverity: object}>}
 */
export async function fetchStats() {
  const res = await fetch('/api/stats');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
