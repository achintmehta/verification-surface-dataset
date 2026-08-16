/**
 * API client — all requests go to /api/* which Vite proxies to the backend
 * in development, and Express serves directly in production.
 */

const BASE = '/api';

async function fetchJSON(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} from ${path}: ${text}`);
  }
  return res.json();
}

export async function fetchSummary() {
  return fetchJSON('/summary');
}

export async function fetchTimeseries() {
  return fetchJSON('/timeseries');
}

export async function fetchCategories() {
  return fetchJSON('/categories');
}

export async function fetchRecent() {
  return fetchJSON('/recent');
}

export async function fetchSettings() {
  return fetchJSON('/settings');
}

export async function putSettings(settings) {
  const res = await fetch(`${BASE}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} from PUT /settings: ${text}`);
  }
  return res.json();
}
