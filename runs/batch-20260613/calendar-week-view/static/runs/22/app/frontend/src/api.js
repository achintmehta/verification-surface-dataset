/**
 * API client for calendar events.
 */

const BASE = '/api';

/**
 * Fetch events overlapping the given date range.
 * @param {Date} start
 * @param {Date} end
 * @returns {Promise<Array>}
 */
export async function fetchEvents(start, end) {
  const url = `${BASE}/events?start=${start.toISOString()}&end=${end.toISOString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch events');
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
    body: JSON.stringify(data)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || 'Failed to create event');
  }
  return res.json();
}

/**
 * Update an event.
 * @param {number} id
 * @param {{ title: string, start_at: string, end_at: string }} data
 * @returns {Promise<Object>}
 */
export async function updateEvent(id, data) {
  const res = await fetch(`${BASE}/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || 'Failed to update event');
  }
  return res.json();
}

/**
 * Delete an event.
 * @param {number} id
 * @returns {Promise<void>}
 */
export async function deleteEvent(id) {
  const res = await fetch(`${BASE}/events/${id}`, {
    method: 'DELETE'
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || 'Failed to delete event');
  }
}
