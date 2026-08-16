// Thin client over the JSON events API.

const BASE = '/api';

async function handle(res) {
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

export async function fetchEvents(startIso, endIso) {
  const url = `${BASE}/events?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`;
  return handle(await fetch(url));
}

export async function createEvent(payload) {
  return handle(
    await fetch(`${BASE}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  );
}

export async function updateEvent(id, payload) {
  return handle(
    await fetch(`${BASE}/events/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  );
}

export async function deleteEvent(id) {
  return handle(
    await fetch(`${BASE}/events/${id}`, { method: 'DELETE' })
  );
}
