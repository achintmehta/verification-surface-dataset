/**
 * API client module.
 *
 * Thin wrappers around fetch() for all backend endpoints.
 *
 * In development the Vite dev server proxies /api/* to the backend,
 * so we use relative URLs. In production (or when VITE_API_URL is set)
 * we use the configured base URL.
 */

// Use an explicit base only when VITE_API_URL is provided (e.g. in production).
// During development the Vite proxy forwards /api/* to the backend.
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
 * Create a new card at the end of a column.
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
 *
 * @param {string}      cardId
 * @param {string}      columnId   - target column
 * @param {string|null} afterId    - card immediately above the target slot (null = top)
 * @param {string|null} beforeId   - card immediately below the target slot (null = bottom)
 * @returns {Promise<{ card: object, renormedCards: Array|null }>}
 */
export async function moveCard(cardId, columnId, afterId, beforeId) {
  const res = await fetch(`${BASE}/api/cards/${cardId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, afterId, beforeId }),
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
export function openEventSource() {
  return new EventSource(`${BASE}/api/stream`);
}
