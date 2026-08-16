/**
 * Thin wrapper around the calendar JSON API.
 * All functions return the parsed JSON body on success,
 * or throw an Error with a human-readable message on failure.
 */

const BASE = '/api';

async function request(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return data;
}

/**
 * Fetch all events overlapping [start, end).
 * @param {Date} start
 * @param {Date} end
 * @returns {Promise<Array>}
 */
export function fetchEvents(start, end) {
  const params = new URLSearchParams({
    start: start.toISOString(),
    end:   end.toISOString(),
  });
  return request('GET', `/events?${params}`);
}

/**
 * Create a new event.
 * @param {{ title: string, start_at: string, end_at: string }} payload
 * @returns {Promise<Object>}
 */
export function createEvent(payload) {
  return request('POST', '/events', payload);
}

/**
 * Update an existing event.
 * @param {number|string} id
 * @param {{ title: string, start_at: string, end_at: string }} payload
 * @returns {Promise<Object>}
 */
export function updateEvent(id, payload) {
  return request('PUT', `/events/${id}`, payload);
}

/**
 * Delete an event.
 * @param {number|string} id
 * @returns {Promise<Object>}
 */
export function deleteEvent(id) {
  return request('DELETE', `/events/${id}`);
}
