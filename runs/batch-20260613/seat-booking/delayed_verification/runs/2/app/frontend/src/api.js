/**
 * api.js – Thin wrappers around the backend REST API.
 */

// In dev, Vite proxies /api → http://localhost:3001, so BASE is empty.
// In production (or when VITE_API_BASE is set), use that value.
const BASE = import.meta.env.VITE_API_BASE ?? '';

async function request(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export const api = {
  /** Fetch all seats. */
  getSeats() {
    return request('GET', '/api/seats');
  },

  /**
   * Place a hold on the given seat ids.
   * @param {string[]} seatIds
   * @param {string}   sessionId
   */
  createHold(seatIds, sessionId) {
    return request('POST', '/api/holds', { seatIds, sessionId });
  },

  /**
   * Confirm a hold.
   * @param {string} holdId
   * @param {string} sessionId
   */
  confirmHold(holdId, sessionId) {
    return request('POST', `/api/holds/${holdId}/confirm`, { sessionId });
  },

  /**
   * Release a hold early.
   * @param {string} holdId
   * @param {string} sessionId
   */
  releaseHold(holdId, sessionId) {
    return request('DELETE', `/api/holds/${holdId}`, { sessionId });
  },
};
