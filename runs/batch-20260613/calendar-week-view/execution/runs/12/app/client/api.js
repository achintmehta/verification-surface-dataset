// Thin wrapper around the events JSON API.

async function handle(res) {
  if (res.status === 204) return null;
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const message = body && body.error ? body.error : `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return body;
}

export async function fetchEvents(startISO, endISO) {
  const url = `/api/events?start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(
    endISO
  )}`;
  return handle(await fetch(url));
}

export async function createEvent(data) {
  return handle(
    await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  );
}

export async function updateEvent(id, data) {
  return handle(
    await fetch(`/api/events/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  );
}

export async function deleteEvent(id) {
  return handle(await fetch(`/api/events/${id}`, { method: 'DELETE' }));
}
