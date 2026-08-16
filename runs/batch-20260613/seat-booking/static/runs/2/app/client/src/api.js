/**
 * Thin API client – all fetch calls to the backend.
 */

const BASE = '/api';

/** @returns {Promise<import('./types').Seat[]>} */
export async function fetchSeats() {
  const res = await fetch(`${BASE}/seats`);
  if (!res.ok) throw new Error(`GET /api/seats failed: ${res.status}`);
  return res.json();
}

/**
 * @param {string[]} seatIds
 * @param {string}   sessionId
 * @returns {Promise<import('./types').HoldResponse>}
 */
export async function createHold(seatIds, sessionId) {
  const res = await fetch(`${BASE}/holds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds, sessionId }),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error ?? 'Failed to create hold');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * @param {string} holdId
 * @param {string} sessionId
 * @returns {Promise<import('./types').ConfirmResponse>}
 */
export async function confirmHold(holdId, sessionId) {
  const res = await fetch(`${BASE}/holds/${holdId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error ?? 'Failed to confirm hold');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * @param {string} holdId
 * @param {string} sessionId
 */
export async function releaseHold(holdId, sessionId) {
  const res = await fetch(`${BASE}/holds/${holdId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error ?? 'Failed to release hold');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
