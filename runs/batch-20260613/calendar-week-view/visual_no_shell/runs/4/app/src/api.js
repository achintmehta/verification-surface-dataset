const BASE = '/api';

async function request(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, opts);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

export function fetchEvents(start, end) {
  const params = new URLSearchParams({ start: start.toISOString(), end: end.toISOString() });
  return request('GET', `/events?${params}`);
}

export function createEvent(event) {
  return request('POST', '/events', event);
}

export function updateEvent(id, event) {
  return request('PUT', `/events/${id}`, event);
}

export function deleteEvent(id) {
  return request('DELETE', `/events/${id}`);
}
