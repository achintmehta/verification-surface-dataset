/**
 * api.js – Thin wrapper around the backend REST API.
 */

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

/**
 * Fetch all seats.
 * @returns {Promise<Array>}
 */
export async function fetchSeats() {
  const res = await fetch(`${BASE}/api/seats`);
  if (!res.ok) throw new Error(`GET /api/seats failed: ${res.status}`);
  return res.json();
}

/**
 * Place a hold on a set of seats.
 *
 * @param {string[]} seatIds
 * @param {string}   sessionId
 * @returns {Promise<{id, sessionId, expiresAt, seats}>}
 * @throws {ConflictError} when one or more seats are unavailable
 */
export async function createHold(seatIds, sessionId) {
  const res = await fetch(`${BASE}/api/holds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds, sessionId }),
  });

  const data = await res.json();

  if (res.status === 409) {
    const err = new Error(data.error || 'Seats unavailable');
    err.type = 'conflict';
    err.conflictSeatIds = data.conflictSeatIds || [];
    throw err;
  }

  if (!res.ok) {
    throw new Error(data.error || `POST /api/holds failed: ${res.status}`);
  }

  return data;
}

/**
 * Confirm a hold.
 *
 * @param {string} holdId
 * @param {string} sessionId
 * @returns {Promise<{holdId, sessionId, seats}>}
 */
export async function confirmHold(holdId, sessionId) {
  const res = await fetch(`${BASE}/api/holds/${holdId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });

  const data = await res.json();

  if (!res.ok) {
    const err = new Error(data.error || `Confirm failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }

  return data;
}

/**
 * Release a hold early.
 *
 * @param {string} holdId
 * @param {string} sessionId
 * @returns {Promise<{released: string[]}>}
 */
export async function releaseHold(holdId, sessionId) {
  const res = await fetch(`${BASE}/api/holds/${holdId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || `DELETE /api/holds/${holdId} failed: ${res.status}`);
  }

  return data;
}

/**
 * Open an SSE stream.
 *
 * @param {string} BASE_URL
 * @returns {EventSource}
 */
export function openStream() {
  return new EventSource(`${BASE}/api/stream`);
}
