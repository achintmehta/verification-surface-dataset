/**
 * API client module.
 * All fetch calls to the backend go through here.
 */

// Empty string = use Vite proxy (relative URLs); set VITE_API_BASE for production
const BASE = import.meta.env.VITE_API_BASE ?? '';

async function request(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  getSeats: () => request('GET', '/api/seats'),

  createHold: (seatIds, sessionId) =>
    request('POST', '/api/holds', { seatIds, sessionId }),

  confirmHold: (holdId, sessionId) =>
    request('POST', `/api/holds/${holdId}/confirm`, { sessionId }),

  releaseHold: (holdId, sessionId) =>
    request('DELETE', `/api/holds/${holdId}`, { sessionId }),
};
