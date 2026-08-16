/**
 * API client for the log explorer backend.
 * Handles request cancellation to prevent stale responses from overwriting newer ones.
 */

const API_BASE = '/api';

/**
 * Fetch a window of log rows.
 * Returns { total, rows } or throws on error.
 * Pass an AbortSignal to cancel in-flight requests.
 */
export async function fetchLogs({ offset = 0, limit = 100, severity = '', q = '' } = {}, signal) {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  if (severity) params.set('severity', severity);
  if (q) params.set('q', q);

  const url = `${API_BASE}/logs?${params.toString()}`;
  const response = await fetch(url, { signal });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Fetch stats (total count + per-severity counts).
 */
export async function fetchStats(signal) {
  const response = await fetch(`${API_BASE}/stats`, { signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}
