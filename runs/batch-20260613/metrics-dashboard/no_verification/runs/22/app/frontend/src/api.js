const API_BASE = '/api';

async function fetchJSON(url) {
  const response = await fetch(`${API_BASE}${url}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json();
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

export async function updateSettings(settings) {
  const response = await fetch(`${API_BASE}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json();
}
