/**
 * api.js – Thin wrappers around the backend REST API.
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
    err.data   = data;
    throw err;
  }
  return data;
}

export const api = {
  /** Fetch all seats with their current effective status. */
  getSeats() {
    return request('GET', '/seats');
  },

  /**
   * Place a hold on the given seat ids.
   * @param {string[]} seatIds
   * @param {string}   sessionId
   */
  createHold(seatIds, sessionId) {
    return request('POST', '/holds', { seatIds, sessionId });
  },

  /**
   * Confirm an active hold.
   * @param {string} holdId
   * @param {string} sessionId
   */
  confirmHold(holdId, sessionId) {
    return request('POST', `/holds/${holdId}/confirm`, { sessionId });
  },

  /**
   * Release a hold early.
   * @param {string} holdId
   * @param {string} sessionId
   */
  releaseHold(holdId, sessionId) {
    return request('DELETE', `/holds/${holdId}`, { sessionId });
  },
};
