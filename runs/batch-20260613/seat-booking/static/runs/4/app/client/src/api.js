/**
 * Thin API client for the seat-booking backend.
 */

const BASE = '/api';

/**
 * @returns {Promise<{ seats: Seat[] }>}
 */
export async function fetchSeats() {
  const res = await fetch(`${BASE}/seats`);
  if (!res.ok) throw new Error(`GET /api/seats failed: ${res.status}`);
  return res.json();
}

/**
 * @param {{ seatIds: string[], sessionId: string }} body
 * @returns {Promise<HoldResponse>}
 */
export async function createHold(body) {
  const res = await fetch(`${BASE}/holds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error ?? 'Hold failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * @param {string} holdId
 * @param {{ sessionId: string }} body
 * @returns {Promise<BookingResponse>}
 */
export async function confirmHold(holdId, body) {
  const res = await fetch(`${BASE}/holds/${holdId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error ?? 'Confirm failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * @param {string} holdId
 * @param {{ sessionId: string }} body
 * @returns {Promise<{ holdId: string, seatIds: string[], released: boolean }>}
 */
export async function releaseHold(holdId, body) {
  const res = await fetch(`${BASE}/holds/${holdId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error ?? 'Release failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * @typedef {{ id: string, rowLabel: string, seatNumber: number, status: 'available'|'held'|'booked', holdId: string|null, holdExpiresAt: string|null, bookedBy: string|null }} Seat
 * @typedef {{ holdId: string, seatIds: string[], sessionId: string, expiresAt: string, ttlSeconds: number }} HoldResponse
 * @typedef {{ holdId: string, seatIds: string[], sessionId: string, booked: boolean }} BookingResponse
 */
