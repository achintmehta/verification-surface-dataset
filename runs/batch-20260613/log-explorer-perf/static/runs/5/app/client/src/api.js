/**
 * API client with request cancellation support.
 * Each call returns { data, cancelled } so callers can detect stale responses.
 */

const BASE = '/api';

/**
 * Fetch a window of logs.
 * @param {object} params
 * @param {number} params.offset
 * @param {number} params.limit
 * @param {string|null} params.severity
 * @param {string|null} params.q
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ total: number, rows: object[] }>}
 */
export async function fetchLogs({ offset, limit, severity, q }, signal) {
  const url = new URL(`${BASE}/logs`, window.location.origin);
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
 * @returns {Promise<{ total: number, bySeverity: object }>}
 */
export async function fetchStats() {
  const res = await fetch(`${BASE}/stats`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
