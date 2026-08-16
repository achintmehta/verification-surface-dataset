/**
 * API client – thin wrappers around fetch calls to the backend.
 */

// In dev, Vite proxies /api → http://localhost:3001/api.
// In production (or when VITE_API_URL is set), use the explicit URL.
const BASE = import.meta.env.VITE_API_URL ?? '/api';

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

/**
 * Move a card.
 * @param {string} cardId
 * @param {string} columnId  - target column
 * @param {string|null} beforeId - card above the moved card (null = top)
 * @param {string|null} afterId  - card below the moved card (null = bottom)
 */
export async function moveCard(cardId, columnId, beforeId, afterId) {
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

export function openEventSource() {
  return new EventSource(`${BASE}/stream`);
}
