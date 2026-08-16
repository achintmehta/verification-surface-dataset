/**
 * API client for the calendar backend.
 * All timestamps are ISO 8601 strings.
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
    const msg = data?.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

/**
 * Fetch all events overlapping [startISO, endISO).
 * @param {string} startISO
 * @param {string} endISO
 * @returns {Promise<Array>}
 */
export function fetchEvents(startISO, endISO) {
  const params = new URLSearchParams({ start: startISO, end: endISO });
  return request('GET', `/events?${params}`);
}

/**
 * Create a new event.
 * @param {{ title: string, start_at: string, end_at: string }} event
 * @returns {Promise<Object>}
 */
export function createEvent(event) {
  return request('POST', '/events', event);
}

/**
 * Update an existing event.
 * @param {number} id
 * @param {{ title: string, start_at: string, end_at: string }} event
 * @returns {Promise<Object>}
 */
export function updateEvent(id, event) {
  return request('PUT', `/events/${id}`, event);
}

/**
 * Delete an event.
 * @param {number} id
 * @returns {Promise<Object>}
 */
export function deleteEvent(id) {
  return request('DELETE', `/events/${id}`);
}
