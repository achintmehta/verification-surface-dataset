const BASE = '/api';

/**
 * Fetch a window of log rows.
 * @param {Object} params
 * @param {number} params.offset
 * @param {number} params.limit
 * @param {string} [params.severity]
 * @param {string} [params.q]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{total: number, rows: Array}>}
 */
export async function fetchLogs({ offset, limit, severity, q }, signal) {
  const url = new URL(`${BASE}/logs`, window.location.origin);
  url.searchParams.set('offset', offset);
  url.searchParams.set('limit', limit);
  if (severity) url.searchParams.set('severity', severity);
  if (q) url.searchParams.set('q', q);

  const res = await fetch(url.toString(), { signal });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Fetch stats (total + per-severity counts).
 * @returns {Promise<{total: number, bySeverity: Object}>}
 */
export async function fetchStats() {
  const res = await fetch(`${BASE}/stats`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
