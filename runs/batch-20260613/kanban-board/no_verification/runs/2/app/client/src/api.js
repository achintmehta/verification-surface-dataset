/**
 * API client – thin wrappers around fetch for all backend calls.
 *
 * In development, Vite proxies /api/* to the backend server, so we use
 * relative URLs. In production, set VITE_API_BASE to the backend origin.
 */

const BASE = import.meta.env.VITE_API_BASE ?? '';

export async function fetchBoard() {
  const res = await fetch(`${BASE}/api/board`);
  if (!res.ok) throw new Error(`fetchBoard failed: ${res.status}`);
  return res.json();
}

/**
 * Create a new card in a column.
 * @param {string} columnId
 * @param {string} text
 * @returns {Promise<object>} canonical card
 */
export async function createCard(columnId, text) {
  const res = await fetch(`${BASE}/api/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `createCard failed: ${res.status}`);
  }
  return res.json();
}

/**
 * Move a card to a new column/position.
 * @param {string} cardId
 * @param {string} columnId   - target column
 * @param {string|null} beforeId - card immediately above the drop slot (smaller pos)
 * @param {string|null} afterId  - card immediately below the drop slot (larger pos)
 * @returns {Promise<object>} canonical card
 */
export async function moveCard(cardId, columnId, beforeId, afterId) {
  const res = await fetch(`${BASE}/api/cards/${cardId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, beforeId, afterId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `moveCard failed: ${res.status}`);
  }
  return res.json();
}

/**
 * Open an SSE connection to the server.
 * @returns {EventSource}
 */
export function openStream() {
  return new EventSource(`${BASE}/api/stream`);
}
