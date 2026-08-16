/**
 * API client with request cancellation support.
 * All fetch calls go through here so we can cancel stale in-flight requests.
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
  if (q && q.trim()) params.set('q', q.trim());

  const url = `${BASE}/logs?${params.toString()}`;
  const res = await fetch(url, { signal });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json();
}

/**
 * Fetch global stats (total + per-severity counts).
 */
export async function fetchStats(signal) {
  const res = await fetch(`${BASE}/stats`, { signal });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}
