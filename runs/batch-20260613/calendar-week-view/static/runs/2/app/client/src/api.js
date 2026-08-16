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

export const api = {
  getEvents(start, end) {
    const params = new URLSearchParams({ start, end });
    return request('GET', `/events?${params}`);
  },

  createEvent(event) {
    return request('POST', '/events', event);
  },

  updateEvent(id, event) {
    return request('PUT', `/events/${id}`, event);
  },

  deleteEvent(id) {
    return request('DELETE', `/events/${id}`);
  },
};
