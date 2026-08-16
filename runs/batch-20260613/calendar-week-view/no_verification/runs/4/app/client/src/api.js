// Use relative URLs so Vite's dev proxy forwards /api → http://localhost:3001
// and production builds can be served from the same origin.
const API_BASE = '';

async function request(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res  = await fetch(API_BASE + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error || ('HTTP ' + res.status);
    throw Object.assign(new Error(msg), { status: res.status, data });
  }
  return data;
}

export const api = {
  getEvents(start, end) {
    const params = new URLSearchParams({
      start: start.toISOString(),
      end:   end.toISOString(),
    });
    return request('GET', '/api/events?' + params);
  },
  createEvent(title, start_at, end_at) {
    return request('POST', '/api/events', { title, start_at, end_at });
  },
  updateEvent(id, title, start_at, end_at) {
    return request('PUT', '/api/events/' + id, { title, start_at, end_at });
  },
  deleteEvent(id) {
    return request('DELETE', '/api/events/' + id);
  },
};
