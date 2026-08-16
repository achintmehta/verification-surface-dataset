/**
 * API client for the log explorer backend.
 * All requests are cancellable via AbortSignal.
 *
 * Uses relative URLs so the Vite dev proxy (/api → localhost:3001) works
 * transparently in development, and the same code works in production.
 */

const API_BASE = '/api';

/**
 * Fetch a window of log rows.
 * @param {object} params
 * @param {number} params.offset
 * @param {number} params.limit
 * @param {string} [params.severity]
 * @param {string} [params.q]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{ total: number, rows: object[] }>}
 */
export async function fetchLogs({ offset = 0, limit = 100, severity = '', q = '', signal } = {}) {
  const url = new URL(`${API_BASE}/logs`, window.location.href);
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('limit',  String(limit));
  if (severity) url.searchParams.set('severity', severity);
  if (q)        url.searchParams.set('q', q);

  const response = await fetch(url.toString(), { signal });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Fetch global stats (total count + per-severity counts).
 * @returns {Promise<{ total: number, bySeverity: object }>}
 */
export async function fetchStats() {
  const response = await fetch(`${API_BASE}/stats`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
