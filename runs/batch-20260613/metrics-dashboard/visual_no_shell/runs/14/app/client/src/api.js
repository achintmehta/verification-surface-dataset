const BASE = '/api';

async function getJSON(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    throw new Error(`Request to ${path} failed (${res.status})`);
  }
  return res.json();
}

export const api = {
  summary: () => getJSON('/summary'),
  timeseries: () => getJSON('/timeseries'),
  categories: () => getJSON('/categories'),
  recent: () => getJSON('/recent'),
  settings: () => getJSON('/settings'),
  saveSettings: async (theme) => {
    const res = await fetch(`${BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme }),
    });
    if (!res.ok) throw new Error('Failed to save settings');
    return res.json();
  },
};
