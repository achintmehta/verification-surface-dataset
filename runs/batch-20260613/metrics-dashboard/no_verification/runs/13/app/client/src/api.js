/** Thin API client. Throws on non-OK responses so callers can show errors. */

async function request(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.error || '';
    } catch {
      /* ignore */
    }
    throw new Error(`Request to ${path} failed (${res.status}). ${detail}`.trim());
  }
  return res.json();
}

export const api = {
  summary: () => request('/api/summary'),
  timeseries: () => request('/api/timeseries'),
  categories: () => request('/api/categories'),
  recent: () => request('/api/recent'),
  getSettings: () => request('/api/settings'),
  putSettings: (theme) =>
    request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme }),
    }),
};
