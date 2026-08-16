/**
 * API client module – thin wrappers around fetch calls to the backend.
 */

const BASE = '/api';

export async function fetchBoard() {
  const res = await fetch(`${BASE}/board`);
  if (!res.ok) throw new Error(`fetchBoard failed: ${res.status}`);
  return res.json(); // { columns: [...] }
}

export async function createCard(columnId, text) {
  const res = await fetch(`${BASE}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `createCard failed: ${res.status}`);
  }
  return res.json(); // { card }
}

export async function moveCard(cardId, { columnId, beforeId, afterId }) {
  const res = await fetch(`${BASE}/cards/${cardId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, beforeId, afterId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `moveCard failed: ${res.status}`);
  }
  return res.json(); // { card }
}
