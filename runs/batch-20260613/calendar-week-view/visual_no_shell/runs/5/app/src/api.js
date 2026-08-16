import { toLocalISOString } from './dates.js';

const API_BASE = '/api';

/**
 * Fetch events overlapping the given range.
 * @param {string} start - wall-clock ISO string (no Z)
 * @param {string} end   - wall-clock ISO string (no Z)
 */
export async function fetchEvents(start, end) {
  const url = `${API_BASE}/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Failed to fetch events');
  }
  return res.json();
}

/**
 * Create a new event.
 * @param {{ title: string, start_at: string, end_at: string }} data
 *   start_at and end_at are wall-clock ISO strings.
 */
export async function createEvent(data) {
  const res = await fetch(`${API_BASE}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to create event');
  return json;
}

/**
 * Update an existing event.
 * @param {number|string} id
 * @param {{ title: string, start_at: string, end_at: string }} data
 */
export async function updateEvent(id, data) {
  const res = await fetch(`${API_BASE}/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to update event');
  return json;
}

/**
 * Delete an event.
 * @param {number|string} id
 */
export async function deleteEvent(id) {
  const res = await fetch(`${API_BASE}/events/${id}`, {
    method: 'DELETE',
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to delete event');
  return json;
}
