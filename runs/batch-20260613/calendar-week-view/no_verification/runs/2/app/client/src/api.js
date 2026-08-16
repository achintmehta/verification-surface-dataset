const BASE = 'http://localhost:3001';

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

export const api = {
  /** Fetch events overlapping [start, end) */
  getEvents(start, end) {
    const s = encodeURIComponent(start);
    const e = encodeURIComponent(end);
    return request('GET', `/api/events?start=${s}&end=${e}`);
  },

  createEvent(title, start_at, end_at) {
    return request('POST', '/api/events', { title, start_at, end_at });
  },

  updateEvent(id, title, start_at, end_at) {
    return request('PUT', `/api/events/${id}`, { title, start_at, end_at });
  },

  deleteEvent(id) {
    return request('DELETE', `/api/events/${id}`);
  },
};
