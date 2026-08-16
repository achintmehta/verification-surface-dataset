const BASE = 'http://localhost:3001';

async function request(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json();
  if (!res.ok) {
    const msg = data.errors ? data.errors.join('; ') : (data.error || 'Request failed');
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * Fetch events overlapping [start, end) (ISO strings).
 * @param {string} start
 * @param {string} end
 * @returns {Promise<Array>}
 */
export function fetchEvents(start, end) {
  return request('GET', `/api/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
}

/**
 * Create a new event.
 * @param {{ title: string, start_at: string, end_at: string }} ev
 */
export function createEvent(ev) {
  return request('POST', '/api/events', ev);
}

/**
 * Update an existing event.
 * @param {number} id
 * @param {{ title: string, start_at: string, end_at: string }} ev
 */
export function updateEvent(id, ev) {
  return request('PUT', `/api/events/${id}`, ev);
}

/**
 * Delete an event.
 * @param {number} id
 */
export function deleteEvent(id) {
  return request('DELETE', `/api/events/${id}`);
}
