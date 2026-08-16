const BASE = '/api';

async function get(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`Request failed: ${path} (${res.status})`);
  return res.json();
}

export const api = {
  summary: () => get('/summary'),
  timeseries: () => get('/timeseries'),
  categories: () => get('/categories'),
  recent: () => get('/recent'),
  settings: () => get('/settings'),
  async saveSettings(theme) {
    const res = await fetch(BASE + '/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme }),
    });
    if (!res.ok) throw new Error('Failed to save settings');
    return res.json();
  },
};
