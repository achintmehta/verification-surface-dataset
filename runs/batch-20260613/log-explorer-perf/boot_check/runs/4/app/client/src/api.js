const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';

/**
 * Fetch a window of log rows.
 * Returns { total, rows } or throws on error.
 * Accepts an AbortSignal for cancellation.
 */
export async function fetchLogs({ offset = 0, limit = 100, severity = '', q = '' } = {}, signal) {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  if (severity) params.set('severity', severity);
  if (q && q.trim()) params.set('q', q.trim());

  const url = `${API_BASE}/api/logs?${params}`;
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
export async function fetchStats() {
  const res = await fetch(`${API_BASE}/api/stats`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
