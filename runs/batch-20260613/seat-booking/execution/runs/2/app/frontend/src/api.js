/**
 * Thin API client for the seat-booking backend.
 */

const BASE = '/api';

/**
 * Fetch the current seat map.
 * @returns {Promise<{seats: Array}>}
 */
export async function fetchSeats() {
  const res = await fetch(`${BASE}/seats`);
  if (!res.ok) throw new Error(`GET /api/seats failed: ${res.status}`);
  return res.json();
}

/**
 * Request a hold on the given seat IDs.
 *
 * @param {string[]} seatIds
 * @param {string}   sessionId
 * @returns {Promise<{holdId: string, seatIds: string[], expiresAt: string, ttlSeconds: number}>}
 */
export async function createHold(seatIds, sessionId) {
  const res = await fetch(`${BASE}/holds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds, sessionId }),
  });

  const data = await res.json();

  if (!res.ok) {
    const err = new Error(data.error ?? 'Hold request failed');
    err.status = res.status;
    err.conflictingSeatIds = data.conflictingSeatIds ?? [];
    throw err;
  }

  return data;
}

/**
 * Confirm an active hold.
 *
 * @param {string} holdId
 * @param {string} sessionId
 * @returns {Promise<{holdId: string, sessionId: string, seatIds: string[], alreadyConfirmed: boolean}>}
 */
export async function confirmHold(holdId, sessionId) {
  const res = await fetch(`${BASE}/holds/${holdId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });

  const data = await res.json();

  if (!res.ok) {
    const err = new Error(data.error ?? 'Confirm request failed');
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
 * @returns {Promise<{holdId: string, releasedSeatIds: string[]}>}
 */
export async function releaseHold(holdId, sessionId) {
  const res = await fetch(`${BASE}/holds/${holdId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });

  const data = await res.json();

  if (!res.ok) {
    const err = new Error(data.error ?? 'Release request failed');
    err.status = res.status;
    throw err;
  }

  return data;
}
