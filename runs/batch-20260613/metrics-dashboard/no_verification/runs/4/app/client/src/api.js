const BASE = '/api';

async function apiFetch(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${path} returned ${res.status}: ${body}`);
  }
  return res.json();
}

export function fetchSummary()    { return apiFetch('/summary'); }
export function fetchTimeseries() { return apiFetch('/timeseries'); }
export function fetchCategories() { return apiFetch('/categories'); }
export function fetchRecent()     { return apiFetch('/recent'); }
export function fetchSettings()   { return apiFetch('/settings'); }

export function putSettings(body) {
  return apiFetch('/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
