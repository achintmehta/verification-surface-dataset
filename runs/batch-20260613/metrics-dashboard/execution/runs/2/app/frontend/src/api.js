/**
 * api.js — thin fetch wrappers for every backend endpoint.
 *
 * All functions throw on network error or non-2xx response so callers
 * can catch and show an error state.
 */

const BASE = '/api';

async function fetchJSON(path, options) {
  const res = await fetch(`${BASE}${path}`, options);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

export const api = {
  /** Four headline numbers */
  getSummary:    () => fetchJSON('/summary'),

  /** 30-day time-series */
  getTimeseries: () => fetchJSON('/timeseries'),

  /** Category breakdown */
  getCategories: () => fetchJSON('/categories'),

  /** 20 most-recent items */
  getRecent:     () => fetchJSON('/recent'),

  /** Current theme preference */
  getSettings:   () => fetchJSON('/settings'),

  /** Persist theme preference */
  putSettings: (theme) =>
    fetchJSON('/settings', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ theme }),
    }),
};
