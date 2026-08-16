/**
 * Thin wrapper around the calendar JSON API.
 */

const BASE = 'http://localhost:3001/api';

async function request(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status, data });
  return data;
}

export function fetchEvents(start, end) {
  return request('GET', `/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
}

export function createEvent(payload) {
  return request('POST', '/events', payload);
}

export function updateEvent(id, payload) {
  return request('PUT', `/events/${id}`, payload);
}

export function deleteEvent(id) {
  return request('DELETE', `/events/${id}`);
}
