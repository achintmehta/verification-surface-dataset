const BASE = '/api';

async function apiFetch(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
  return res.json();
}

export async function fetchAll() {
  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      apiFetch('/summary'),
      apiFetch('/timeseries'),
      apiFetch('/categories'),
      apiFetch('/recent'),
    ]);
    return { summary, timeseries, categories, recent, error: null };
  } catch (err) {
    console.error('API fetch failed:', err);
    return {
      summary: null,
      timeseries: null,
      categories: null,
      recent: null,
      error: 'Unable to connect to the server. Please ensure the backend is running.',
    };
  }
}

export async function getSettings() {
  try {
    return await apiFetch('/settings');
  } catch (err) {
    console.error('Failed to fetch settings:', err);
    return { theme: 'light' };
  }
}

export async function putSettings(settings) {
  try {
    const res = await fetch(`${BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } catch (err) {
    console.error('Failed to update settings:', err);
    return null;
  }
}
