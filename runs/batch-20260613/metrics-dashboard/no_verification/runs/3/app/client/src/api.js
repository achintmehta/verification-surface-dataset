const BASE = '/api';

async function apiFetch(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  getSummary:    () => apiFetch('/summary'),
  getTimeseries: () => apiFetch('/timeseries'),
  getCategories: () => apiFetch('/categories'),
  getRecent:     () => apiFetch('/recent'),
  getSettings:   () => apiFetch('/settings'),
  putSettings:   (body) =>
    apiFetch('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
};
