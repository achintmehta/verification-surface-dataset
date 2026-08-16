const API_BASE = '/api';

/**
 * Fetch a window of logs from the server.
 * Returns { total, rows } or throws on error.
 * Supports AbortSignal for request cancellation.
 */
export async function fetchLogs({ offset = 0, limit = 50, severity = '', q = '' } = {}, signal) {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  if (severity) params.set('severity', severity);
  if (q) params.set('q', q);

  const url = `${API_BASE}/logs?${params.toString()}`;
  const res = await fetch(url, { signal });
  
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json();
}

/**
 * Fetch aggregate stats (total count and per-severity counts).
 */
export async function fetchStats() {
  const res = await fetch(`${API_BASE}/stats`);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}
