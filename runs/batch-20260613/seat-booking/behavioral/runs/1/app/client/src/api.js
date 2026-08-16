/**
 * API client for the seat-booking backend.
 */

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

async function apiFetch(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export const api = {
  getSeats: () => apiFetch('/api/seats'),

  createHold: (seatIds, sessionId) =>
    apiFetch('/api/holds', {
      method: 'POST',
      body: JSON.stringify({ seatIds, sessionId }),
    }),

  confirmHold: (holdId, sessionId) =>
    apiFetch(`/api/holds/${holdId}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    }),

  releaseHold: (holdId, sessionId) =>
    apiFetch(`/api/holds/${holdId}`, {
      method: 'DELETE',
      body: JSON.stringify({ sessionId }),
    }),
};
