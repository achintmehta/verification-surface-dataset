const BASE = '/api';

async function handle(res) {
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function fetchEvents(startIso, endIso) {
  const res = await fetch(
    `${BASE}/events?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`
  );
  return handle(res);
}

export async function createEvent(payload) {
  const res = await fetch(`${BASE}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return handle(res);
}

export async function updateEvent(id, payload) {
  const res = await fetch(`${BASE}/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return handle(res);
}

export async function deleteEvent(id) {
  const res = await fetch(`${BASE}/events/${id}`, { method: 'DELETE' });
  return handle(res);
}
