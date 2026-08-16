// Thin API client. Every call hits the backend; there is no hardcoded data.

async function getJson(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Request to ${path} failed: ${res.status}`);
  }
  return res.json();
}

export function getSummary() {
  return getJson('/api/summary');
}

export function getTimeseries() {
  return getJson('/api/timeseries');
}

export function getCategories() {
  return getJson('/api/categories');
}

export function getRecent() {
  return getJson('/api/recent');
}

export function getSettings() {
  return getJson('/api/settings');
}

export async function putSettings(theme) {
  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme }),
  });
  if (!res.ok) {
    throw new Error(`Failed to save settings: ${res.status}`);
  }
  return res.json();
}
