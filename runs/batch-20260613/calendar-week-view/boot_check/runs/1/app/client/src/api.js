/**
 * Thin API client for the calendar backend.
 */

const BASE = '/api';

/**
 * Fetch events overlapping the given range.
 * @param {string} start  ISO string
 * @param {string} end    ISO string
 * @returns {Promise<Array>}
 */
export async function fetchEvents(start, end) {
  const url = `${BASE}/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Create a new event.
 * @param {{ title: string, start_at: string, end_at: string }} data
 * @returns {Promise<Object>}
 */
export async function createEvent(data) {
  const res = await fetch(`${BASE}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

/**
 * Update an existing event.
 * @param {number} id
 * @param {{ title: string, start_at: string, end_at: string }} data
 * @returns {Promise<Object>}
 */
export async function updateEvent(id, data) {
  const res = await fetch(`${BASE}/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

/**
 * Delete an event.
 * @param {number} id
 * @returns {Promise<Object>}
 */
export async function deleteEvent(id) {
  const res = await fetch(`${BASE}/events/${id}`, { method: 'DELETE' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}
