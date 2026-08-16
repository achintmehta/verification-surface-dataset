// Thin JSON API client. Uses relative /api paths (proxied by Vite in dev).

const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const message = (body && body.error) || `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return body;
}

export function fetchEvents(startIso, endIso) {
  const qs = new URLSearchParams({ start: startIso, end: endIso });
  return request(`/events?${qs.toString()}`);
}

export function createEvent(payload) {
  return request('/events', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updateEvent(id, payload) {
  return request(`/events/${id}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function deleteEvent(id) {
  return request(`/events/${id}`, { method: 'DELETE' });
}
