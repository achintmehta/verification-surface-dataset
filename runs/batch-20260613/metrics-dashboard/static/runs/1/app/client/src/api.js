/**
 * Thin API client — all requests go to /api/* (proxied to the backend in dev,
 * served directly in production).
 */

const BASE = '/api';

async function apiFetch(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${path} → ${res.status}: ${body}`);
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
    apiFetch('/settings', { method: 'PUT', body: JSON.stringify(body) }),
};
