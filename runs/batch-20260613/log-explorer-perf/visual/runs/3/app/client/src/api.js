/**
 * API client for the log explorer backend.
 * Handles request cancellation to prevent stale responses from overwriting newer ones.
 */

const BASE_URL = '/api';
const WINDOW_SIZE = 100; // rows per fetch

let currentController = null;

/**
 * Fetch a window of logs.
 * Cancels any in-flight request before issuing a new one.
 *
 * @param {object} params
 * @param {number} params.offset
 * @param {number} params.limit
 * @param {string} [params.severity]
 * @param {string} [params.q]
 * @returns {Promise<{total: number, rows: Array}>}
 */
export async function fetchLogs({ offset = 0, limit = WINDOW_SIZE, severity = '', q = '' } = {}) {
  // Cancel previous in-flight request
  if (currentController) {
    currentController.abort();
  }
  currentController = new AbortController();
  const signal = currentController.signal;

  const url = new URL(`${BASE_URL}/logs`, window.location.origin);
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('limit', String(limit));
  if (severity) url.searchParams.set('severity', severity);
  if (q) url.searchParams.set('q', q);

  const response = await fetch(url.toString(), { signal });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Fetch stats (total count + per-severity counts).
 * @returns {Promise<{total: number, bySeverity: object}>}
 */
export async function fetchStats() {
  const response = await fetch(`${BASE_URL}/stats`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export { WINDOW_SIZE };
