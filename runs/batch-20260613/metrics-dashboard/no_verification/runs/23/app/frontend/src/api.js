const BASE = '/api';

async function fetchJSON(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function getSummary() {
  return fetchJSON('/summary');
}

export function getTimeseries() {
  return fetchJSON('/timeseries');
}

export function getCategories() {
  return fetchJSON('/categories');
}

export function getRecent() {
  return fetchJSON('/recent');
}

export function getSettings() {
  return fetchJSON('/settings');
}

export async function putSettings(settings) {
  const res = await fetch(`${BASE}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
