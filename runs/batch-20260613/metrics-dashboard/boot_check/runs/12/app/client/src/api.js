async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

export function fetchSummary() {
  return getJson('/api/summary');
}
export function fetchTimeseries() {
  return getJson('/api/timeseries');
}
export function fetchCategories() {
  return getJson('/api/categories');
}
export function fetchRecent() {
  return getJson('/api/recent');
}
export function fetchSettings() {
  return getJson('/api/settings');
}
export async function saveSettings(theme) {
  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme }),
  });
  if (!res.ok) throw new Error(`Failed to save settings: ${res.status}`);
  return res.json();
}
