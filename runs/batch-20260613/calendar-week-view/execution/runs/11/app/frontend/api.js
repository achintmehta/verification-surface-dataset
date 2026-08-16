// Thin JSON HTTP client for the events API.

const BASE = '/api';

async function request(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (res.status === 204) return null;
  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) {
    const message = (data && data.error) || `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function fetchEvents(startISO, endISO) {
  const u = `${BASE}/events?start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`;
  return request('GET', u);
}

export function createEvent(event) {
  return request('POST', `${BASE}/events`, event);
}

export function updateEvent(id, event) {
  return request('PUT', `${BASE}/events/${id}`, event);
}

export function deleteEvent(id) {
  return request('DELETE', `${BASE}/events/${id}`);
}
