/**
 * Thin API client for the Kanban backend.
 */

const BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001';

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
 * Move a card to a column, optionally between two neighbours.
 * @param {string} cardId
 * @param {string} columnId   - target column
 * @param {string|null} beforeId - card immediately before (lower position)
 * @param {string|null} afterId  - card immediately after (higher position)
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
 * Open an EventSource to the SSE stream.
 * @returns {EventSource}
 */
export function openStream() {
  return new EventSource(`${BASE}/api/stream`);
}
