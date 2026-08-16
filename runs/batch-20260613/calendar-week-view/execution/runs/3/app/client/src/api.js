const BASE = '/api';

async function request(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * Fetch events overlapping [start, end).
 * @param {Date} start
 * @param {Date} end
 */
export function fetchEvents(start, end) {
  return request('GET', `/events?start=${start.toISOString()}&end=${end.toISOString()}`);
}

/**
 * Create a new event.
 * @param {{ title: string, start_at: string, end_at: string }} event
 */
export function createEvent(event) {
  return request('POST', '/events', event);
}

/**
 * Update an existing event.
 * @param {number} id
 * @param {{ title: string, start_at: string, end_at: string }} event
 */
export function updateEvent(id, event) {
  return request('PUT', `/events/${id}`, event);
}

/**
 * Delete an event.
 * @param {number} id
 */
export function deleteEvent(id) {
  return request('DELETE', `/events/${id}`);
}
