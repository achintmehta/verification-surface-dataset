/**
 * Thin API client – all fetch calls go through here.
 */

const BASE = '/api';

async function request(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(data.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  getSeats: () => request('GET', '/seats'),

  createHold: (seatIds, sessionId) =>
    request('POST', '/holds', { seatIds, sessionId }),

  confirmHold: (holdId, sessionId) =>
    request('POST', `/holds/${holdId}/confirm`, { sessionId }),

  releaseHold: (holdId, sessionId) =>
    request('DELETE', `/holds/${holdId}`, { sessionId }),
};
