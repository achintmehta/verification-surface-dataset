/**
 * API client — thin wrapper around fetch for the events JSON API.
 */

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

async function request(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(`${BASE_URL}${path}`, opts);
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = data.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

export const api = {
  getEvents(start, end) {
    const params = new URLSearchParams({ start, end });
    return request('GET', `/api/events?${params}`);
  },

  createEvent(payload) {
    return request('POST', '/api/events', payload);
  },

  updateEvent(id, payload) {
    return request('PUT', `/api/events/${id}`, payload);
  },

  deleteEvent(id) {
    return request('DELETE', `/api/events/${id}`);
  },
};
