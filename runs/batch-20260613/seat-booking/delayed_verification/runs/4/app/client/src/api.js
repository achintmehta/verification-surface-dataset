/**
 * API client module.
 *
 * Thin wrappers around fetch() for each backend endpoint.
 * All functions return { data, error } so callers never need try/catch.
 */

const BASE = '/api';

async function request(method, path, body) {
  try {
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
      return { data: null, error: data, status: res.status };
    }
    return { data, error: null, status: res.status };
  } catch (err) {
    return { data: null, error: { error: err.message }, status: 0 };
  }
}

/** Fetch all seats. */
export function getSeats() {
  return request('GET', '/seats');
}

/**
 * Place a hold on the given seat ids.
 * @param {string[]} seatIds
 * @param {string}   sessionId
 */
export function createHold(seatIds, sessionId) {
  return request('POST', '/holds', { seatIds, sessionId });
}

/**
 * Confirm a hold.
 * @param {string} holdId
 * @param {string} sessionId
 */
export function confirmHold(holdId, sessionId) {
  return request('POST', `/holds/${holdId}/confirm`, { sessionId });
}

/**
 * Release a hold early.
 * @param {string} holdId
 * @param {string} sessionId
 */
export function releaseHold(holdId, sessionId) {
  return request('DELETE', `/holds/${holdId}`, { sessionId });
}
