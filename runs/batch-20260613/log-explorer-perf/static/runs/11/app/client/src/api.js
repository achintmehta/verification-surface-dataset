// Thin API client with support for cancellation (AbortController) so stale
// in-flight requests can be dropped when filters or scroll position change.

/**
 * Fetch a window of logs.
 * @param {{offset:number, limit:number, severity?:string, q?:string, signal?:AbortSignal}} args
 * @returns {Promise<{total:number, rows:Array}>}
 */
export async function fetchLogs({ offset, limit, severity, q, signal }) {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  if (severity) params.set('severity', severity);
  if (q) params.set('q', q);

  const res = await fetch(`/api/logs?${params.toString()}`, { signal });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `request failed: ${res.status}`);
  }
  return res.json();
}

/**
 * Fetch corpus stats (total + per-severity counts).
 * @returns {Promise<{total:number, bySeverity:Record<string,number>}>}
 */
export async function fetchStats() {
  const res = await fetch('/api/stats');
  if (!res.ok) throw new Error(`stats failed: ${res.status}`);
  return res.json();
}
