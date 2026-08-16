// Thin client over the events JSON API.

const BASE = '/api';

async function request(path, options) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
    } catch {
      /* ignore */
    }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

/** Fetch events overlapping [start, end). Dates are Date objects. */
export async function fetchEvents(start, end) {
  const qs = new URLSearchParams({
    start: start.toISOString(),
    end: end.toISOString(),
  });
  const rows = await request(`/events?${qs.toString()}`, { method: 'GET' });
  return rows.map(rowToEvent);
}

export async function createEvent({ title, start, end }) {
  const row = await request('/events', {
    method: 'POST',
    body: JSON.stringify({
      title,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
    }),
  });
  return rowToEvent(row);
}

export async function updateEvent(id, { title, start, end }) {
  const row = await request(`/events/${id}`, {
    method: 'PUT',
    body: JSON.stringify({
      title,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
    }),
  });
  return rowToEvent(row);
}

export async function deleteEvent(id) {
  await request(`/events/${id}`, { method: 'DELETE' });
}

function rowToEvent(row) {
  return {
    id: row.id,
    title: row.title,
    start: new Date(row.start_at),
    end: new Date(row.end_at),
  };
}
