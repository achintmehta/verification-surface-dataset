/**
 * api.js – Thin wrapper around the calendar JSON API.
 */

const BASE = '/api';

/**
 * Fetch all events overlapping the given date range.
 * @param {Date} start
 * @param {Date} end
 * @returns {Promise<Array<object>>}
 */
export async function fetchEvents(start, end) {
  const url = `${BASE}/events?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Create a new event.
 * @param {{ title: string, start_at: string, end_at: string }} data
 * @returns {Promise<object>}
 */
export async function createEvent(data) {
  const res = await fetch(`${BASE}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

/**
 * Update an existing event.
 * @param {number} id
 * @param {{ title: string, start_at: string, end_at: string }} data
 * @returns {Promise<object>}
 */
export async function updateEvent(id, data) {
  const res = await fetch(`${BASE}/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

/**
 * Delete an event.
 * @param {number} id
 * @returns {Promise<void>}
 */
export async function deleteEvent(id) {
  const res = await fetch(`${BASE}/events/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
}
