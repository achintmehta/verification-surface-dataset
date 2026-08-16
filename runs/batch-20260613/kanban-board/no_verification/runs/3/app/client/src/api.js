/**
 * Thin HTTP client for the Kanban backend API.
 */

// In development the Vite dev-server proxies /api → http://localhost:3001.
// In production (or when VITE_API_URL is set) use the explicit base URL.
const BASE = import.meta.env.VITE_API_URL ?? '';

/**
 * Fetch the full board state.
 * @returns {Promise<{ columns: Array }>}
 */
export async function fetchBoard() {
  const res = await fetch(`${BASE}/api/board`);
  if (!res.ok) throw new Error(`fetchBoard failed: ${res.status}`);
  return res.json();
}

/**
 * Create a new card in a column.
 * @param {string} columnId
 * @param {string} text
 * @returns {Promise<{ card: object }>}
 */
export async function createCard(columnId, text) {
  const res = await fetch(`${BASE}/api/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `createCard failed: ${res.status}`);
  }
  return res.json();
}

/**
 * Move a card to a new position.
 * @param {string} cardId
 * @param {string} columnId   – target column
 * @param {string|null} beforeId – card immediately before the target slot
 * @param {string|null} afterId  – card immediately after the target slot
 * @returns {Promise<{ card: object }>}
 */
export async function moveCard(cardId, columnId, beforeId, afterId) {
  const res = await fetch(`${BASE}/api/cards/${cardId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, beforeId, afterId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `moveCard failed: ${res.status}`);
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
