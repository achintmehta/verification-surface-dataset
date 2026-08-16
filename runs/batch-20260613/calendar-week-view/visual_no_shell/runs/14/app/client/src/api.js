const BASE = '/api';

async function handle(res) {
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function fetchEvents(startISO, endISO) {
  const url = `${BASE}/events?start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`;
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
