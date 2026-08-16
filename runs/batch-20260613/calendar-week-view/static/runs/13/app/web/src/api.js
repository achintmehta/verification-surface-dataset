const BASE = '/api';

async function handle(res) {
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
    } catch {
      // ignore parse errors
    }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
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
