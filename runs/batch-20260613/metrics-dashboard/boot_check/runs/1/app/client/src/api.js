/**
 * API client — all requests go to the backend server.
 * In development, Vite proxies /api/* to localhost:3001.
 * In production, the Express server serves both API and static files.
 */

const BASE = '/api';

async function fetchJSON(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

export async function getSummary() {
  return fetchJSON('/summary');
}

export async function getTimeseries() {
  return fetchJSON('/timeseries');
}

export async function getCategories() {
  return fetchJSON('/categories');
}

export async function getRecent() {
  return fetchJSON('/recent');
}

export async function getSettings() {
  return fetchJSON('/settings');
}

export async function putSettings(settings) {
  return fetchJSON('/settings', {
    method: 'PUT',
    body: JSON.stringify(settings),
  });
}
