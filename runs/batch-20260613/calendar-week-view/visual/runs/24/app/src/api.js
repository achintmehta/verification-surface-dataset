const API_BASE = '/api';

async function request(url, options = {}) {
  const res = await fetch(`${API_BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  return res.json();
}

export function fetchEvents(start, end) {
  const params = new URLSearchParams({
    start: start.toISOString(),
    end: end.toISOString(),
  });
  return request(`/events?${params}`);
}

export function createEvent(data) {
  return request('/events', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateEvent(id, data) {
  return request(`/events/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteEvent(id) {
  return request(`/events/${id}`, {
    method: 'DELETE',
  });
}
