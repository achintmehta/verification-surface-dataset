/**
 * API client — all requests go through /api (proxied to the backend in dev,
 * served from the same origin in production).
 */

const BASE = '/api';

async function fetchJson(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} from ${path}: ${text}`);
  }
  return res.json();
}

export async function getSummary()    { return fetchJson('/summary'); }
export async function getTimeseries() { return fetchJson('/timeseries'); }
export async function getCategories() { return fetchJson('/categories'); }
export async function getRecent()     { return fetchJson('/recent'); }
export async function getSettings()   { return fetchJson('/settings'); }

export async function putSettings(body) {
  const res = await fetch(`${BASE}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} from PUT /settings: ${text}`);
  }
  return res.json();
}
