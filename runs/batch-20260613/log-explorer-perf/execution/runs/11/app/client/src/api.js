// Thin API client. All windowing/filtering happens server-side; the client
// only ever asks for a single window of rows.

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
  return res.json(); // { total, rows }
}

export async function fetchStats() {
  const res = await fetch('/api/stats');
  if (!res.ok) throw new Error(`stats failed: ${res.status}`);
  return res.json(); // { total, bySeverity }
}
