/**
 * Thin API client – all fetch calls go through here so the base URL is
 * configured in one place.
 */

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

/**
 * @param {string} path
 * @param {RequestInit} [options]
 */
async function apiFetch(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/** Fetch all seats. */
export function fetchSeats() {
  return apiFetch('/api/seats');
}

/**
 * Place a hold on the given seat ids.
 * @param {string[]} seatIds
 * @param {string} sessionId
 */
export function createHold(seatIds, sessionId) {
  return apiFetch('/api/holds', {
    method: 'POST',
    body: JSON.stringify({ seatIds, sessionId }),
  });
}

/**
 * Confirm an existing hold.
 * @param {string} holdId
 * @param {string} sessionId
 */
export function confirmHold(holdId, sessionId) {
  return apiFetch(`/api/holds/${holdId}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  });
}

/**
 * Release a hold early.
 * @param {string} holdId
 * @param {string} sessionId
 */
export function releaseHold(holdId, sessionId) {
  return apiFetch(`/api/holds/${holdId}`, {
    method: 'DELETE',
    body: JSON.stringify({ sessionId }),
  });
}
