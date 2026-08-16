/**
 * API client — all fetch calls go through here so error handling is uniform.
 */

const BASE = '/api';

async function apiFetch(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${path} returned ${res.status}: ${text}`);
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
