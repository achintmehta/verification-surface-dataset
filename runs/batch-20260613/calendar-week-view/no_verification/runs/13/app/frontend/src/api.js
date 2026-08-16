// api.js — thin client for the events JSON API.

const BASE = '/api';

async function request(url, options) {
  const res = await fetch(url, options);
  if (res.status === 204) return null;
  let body = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const message = body && body.error ? body.error : `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return body;
}

export function fetchEvents(startISO, endISO) {
  const params = new URLSearchParams({ start: startISO, end: endISO });
  return request(`${BASE}/events?${params.toString()}`);
}

export function createEvent({ title, start_at, end_at }) {
  return request(`${BASE}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, start_at, end_at }),
  });
}

export function updateEvent(id, { title, start_at, end_at }) {
  return request(`${BASE}/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, start_at, end_at }),
  });
}

export function deleteEvent(id) {
  return request(`${BASE}/events/${id}`, { method: 'DELETE' });
}
