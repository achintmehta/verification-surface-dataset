async function getJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    throw new Error(`Request to ${url} failed: ${res.status}`);
  }
  return res.json();
}

export function fetchSummary() {
  return getJSON('/api/summary');
}
export function fetchTimeseries() {
  return getJSON('/api/timeseries');
}
export function fetchCategories() {
  return getJSON('/api/categories');
}
export function fetchRecent() {
  return getJSON('/api/recent');
}
export function fetchSettings() {
  return getJSON('/api/settings');
}
export function saveSettings(theme) {
  return getJSON('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme }),
  });
}
