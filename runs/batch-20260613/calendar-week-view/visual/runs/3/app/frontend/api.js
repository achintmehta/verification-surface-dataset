/**
 * API client for the calendar backend.
 */

export const API_BASE = 'http://localhost:3001';

async function handleResponse(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

/**
 * Fetch events overlapping the given range.
 * @param {string} start - ISO string
 * @param {string} end   - ISO string
 */
export async function fetchEvents(start, end) {
  const url = `${API_BASE}/api/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
  const res = await fetch(url);
  return handleResponse(res);
}

/**
 * Create a new event.
 * @param {{ title: string, start_at: string, end_at: string }} payload
 */
export async function createEvent(payload) {
  const res = await fetch(`${API_BASE}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse(res);
}

/**
 * Update an existing event.
 * @param {number|string} id
 * @param {{ title: string, start_at: string, end_at: string }} payload
 */
export async function updateEvent(id, payload) {
  const res = await fetch(`${API_BASE}/api/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse(res);
}

/**
 * Delete an event.
 * @param {number|string} id
 */
export async function deleteEvent(id) {
  const res = await fetch(`${API_BASE}/api/events/${id}`, {
    method: 'DELETE',
  });
  return handleResponse(res);
}
