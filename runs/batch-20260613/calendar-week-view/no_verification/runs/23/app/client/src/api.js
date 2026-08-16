import { toLocalISOString } from './dateUtils.js';

const API_BASE = '/api';

export async function fetchEvents(start, end) {
  const params = new URLSearchParams({
    start: toLocalISOString(start),
    end: toLocalISOString(end)
  });
  const res = await fetch(`${API_BASE}/events?${params}`);
  if (!res.ok) throw new Error('Failed to fetch events');
  return res.json();
}

export async function createEvent(data) {
  const res = await fetch(`${API_BASE}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'Failed to create event');
  return body;
}

export async function updateEvent(id, data) {
  const res = await fetch(`${API_BASE}/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'Failed to update event');
  return body;
}

export async function deleteEvent(id) {
  const res = await fetch(`${API_BASE}/events/${id}`, {
    method: 'DELETE'
  });
  if (!res.ok) {
    const body = await res.json();
    throw new Error(body.error || 'Failed to delete event');
  }
  return true;
}
