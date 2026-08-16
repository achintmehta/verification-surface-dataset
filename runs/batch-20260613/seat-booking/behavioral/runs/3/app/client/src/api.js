/**
 * API client module.
 * All fetch calls to the backend go through here.
 */

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

async function handleResponse(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export async function fetchSeats() {
  const res = await fetch(`${BASE}/api/seats`);
  return handleResponse(res);
}

export async function createHold(seatIds, sessionId) {
  const res = await fetch(`${BASE}/api/holds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds, sessionId }),
  });
  return handleResponse(res);
}

export async function confirmHold(holdId, sessionId) {
  const res = await fetch(`${BASE}/api/holds/${holdId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  return handleResponse(res);
}

export async function releaseHold(holdId, sessionId) {
  const res = await fetch(`${BASE}/api/holds/${holdId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  return handleResponse(res);
}

export function openEventStream() {
  return new EventSource(`${BASE}/api/stream`);
}
