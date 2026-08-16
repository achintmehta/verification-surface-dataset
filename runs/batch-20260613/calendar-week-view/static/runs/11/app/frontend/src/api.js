// Thin client over the JSON HTTP API.

const BASE = '/api';

async function handle(res) {
  if (res.status === 204) return null;
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text };
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

export async function fetchEvents(startIso, endIso) {
  const url = `${BASE}/events?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`;
  const res = await fetch(url);
  return handle(res);
}

export async function createEvent(payload) {
  const res = await fetch(`${BASE}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handle(res);
}

export async function updateEvent(id, payload) {
  const res = await fetch(`${BASE}/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handle(res);
}

export async function deleteEvent(id) {
  const res = await fetch(`${BASE}/events/${id}`, { method: 'DELETE' });
  return handle(res);
}
