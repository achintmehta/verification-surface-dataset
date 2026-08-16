// Thin API client. Requests are cancelable via AbortController so stale
// in-flight requests can be aborted when filters change or windows advance.

const MAX_LIMIT = 200;

export async function fetchLogs({ offset, limit, severity, q, signal }) {
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('limit', String(Math.min(limit, MAX_LIMIT)));
  if (severity) params.set('severity', severity);
  if (q) params.set('q', q);

  const res = await fetch(`/api/logs?${params.toString()}`, { signal });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `request failed: ${res.status}`);
  }
  return res.json(); // { total, rows }
}

export async function fetchStats({ signal } = {}) {
  const res = await fetch('/api/stats', { signal });
  if (!res.ok) throw new Error(`stats failed: ${res.status}`);
  return res.json(); // { total, bySeverity }
}
