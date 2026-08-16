/**
 * API client for the log-explorer backend.
 * Handles request cancellation via AbortController to prevent stale responses.
 */

const BASE_URL = '/api';

/**
 * Fetch a window of log entries.
 * @param {Object} params
 * @param {number} params.offset
 * @param {number} params.limit
 * @param {string|null} params.severity
 * @param {string|null} params.q
 * @param {AbortSignal} [signal]
 * @returns {Promise<{total: number, rows: Array}>}
 */
export async function fetchLogs({ offset = 0, limit = 100, severity = null, q = null }, signal) {
  const url = new URL(`${BASE_URL}/logs`, window.location.origin);
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('limit', String(limit));
  if (severity) url.searchParams.set('severity', severity);
  if (q && q.trim()) url.searchParams.set('q', q.trim());

  const response = await fetch(url.toString(), { signal });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Fetch global stats (total count + per-severity counts).
 * @param {AbortSignal} [signal]
 * @returns {Promise<{total: number, bySeverity: Object}>}
 */
export async function fetchStats(signal) {
  const response = await fetch(`${BASE_URL}/stats`, { signal });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${response.status}`);
  }

  return response.json();
}
