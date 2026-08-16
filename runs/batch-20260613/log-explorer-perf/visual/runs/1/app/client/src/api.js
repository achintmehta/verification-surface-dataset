// Use relative URLs so the Vite proxy handles routing to the backend.
// This also avoids CORS preflight overhead.
const BASE_URL = '';

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
  const url = new URL(`${BASE_URL}/api/logs`);
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('limit', String(limit));
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
 * Fetch per-severity stats.
 * @returns {Promise<{total: number, bySeverity: Object}>}
 */
export async function fetchStats() {
  const res = await fetch(`/api/stats`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
