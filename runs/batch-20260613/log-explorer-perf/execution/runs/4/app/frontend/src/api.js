/**
 * API client with request cancellation support.
 * Ensures stale responses never overwrite newer results.
 */

const BASE = '/api';

/**
 * Fetch a window of logs.
 * Returns { total, rows } or throws on error.
 * Pass an AbortSignal to cancel stale requests.
 */
export async function fetchLogs({ offset = 0, limit = 100, severity = '', q = '' } = {}, signal) {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  if (severity) params.set('severity', severity);
  if (q) params.set('q', q);

  const url = `${BASE}/logs?${params}`;
  const res = await fetch(url, { signal });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json();
}

/**
 * Fetch stats (total + per-severity counts).
 */
export async function fetchStats(signal) {
  const res = await fetch(`${BASE}/stats`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
