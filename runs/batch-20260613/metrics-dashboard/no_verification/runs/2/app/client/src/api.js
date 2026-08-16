/**
 * API client.
 *
 * In development, Vite proxies /api → http://localhost:3001/api.
 * In production (served by Express), /api is on the same origin.
 * Using a relative base means no hardcoded port in the client bundle.
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
