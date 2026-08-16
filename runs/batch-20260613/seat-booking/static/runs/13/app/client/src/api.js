// Thin API client for the seat-booking backend.

async function request(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = new Error(body?.message || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = body?.error;
    err.body = body;
    throw err;
  }
  return body;
}

export function fetchSeats() {
  return request('/api/seats');
}

export function fetchInventory() {
  return request('/api/inventory');
}

export function createHold(seatIds, sessionId) {
  return request('/api/holds', {
    method: 'POST',
    body: JSON.stringify({ seatIds, sessionId }),
  });
}

export function confirmHold(holdId, sessionId) {
  return request(`/api/holds/${holdId}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  });
}

export function releaseHold(holdId, sessionId) {
  return request(`/api/holds/${holdId}`, {
    method: 'DELETE',
    body: JSON.stringify({ sessionId }),
  });
}
