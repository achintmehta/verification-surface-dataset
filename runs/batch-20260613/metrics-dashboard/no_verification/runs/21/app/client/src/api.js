/**
 * API client – thin wrappers around fetch for the metrics endpoints.
 * All functions throw on network / server errors so callers can show error state.
 */

const BASE = ''; // empty because Vite proxies /api to the backend

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} returned ${res.status}`);
  return res.json();
}

async function put(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PUT ${path} returned ${res.status}`);
  return res.json();
}

export function fetchSummary() {
  return get('/api/summary');
}

export function fetchTimeseries() {
  return get('/api/timeseries');
}

export function fetchCategories() {
  return get('/api/categories');
}

export function fetchRecent() {
  return get('/api/recent');
}

export function fetchSettings() {
  return get('/api/settings');
}

export function saveSettings(settings) {
  return put('/api/settings', settings);
}
