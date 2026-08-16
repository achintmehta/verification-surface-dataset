const BASE = 'http://localhost:3001';

async function apiFetch(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${path} returned ${res.status}: ${text}`);
  }
  return res.json();
}

export const api = {
  getSummary:    () => apiFetch('/api/summary'),
  getTimeseries: () => apiFetch('/api/timeseries'),
  getCategories: () => apiFetch('/api/categories'),
  getRecent:     () => apiFetch('/api/recent'),
  getSettings:   () => apiFetch('/api/settings'),
  putSettings:   (body) =>
    apiFetch('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
};
