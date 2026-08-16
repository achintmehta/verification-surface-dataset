const BASE = 'http://localhost:3001';

async function request(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json();
  if (!res.ok) {
    throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status, data });
  }
  return data;
}

export const api = {
  getEvents(start, end) {
    const params = new URLSearchParams({ start, end });
    return request('GET', `/api/events?${params}`);
  },
  createEvent(event) {
    return request('POST', '/api/events', event);
  },
  updateEvent(id, event) {
    return request('PUT', `/api/events/${id}`, event);
  },
  deleteEvent(id) {
    return request('DELETE', `/api/events/${id}`);
  },
};
