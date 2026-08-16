/**
 * API client – thin wrappers around fetch() for all backend endpoints.
 */

const BASE = '/api';

/**
 * Fetch the full board state.
 * @returns {Promise<{ columns: Array }>}
 */
export async function fetchBoard() {
  const res = await fetch(`${BASE}/board`);
  if (!res.ok) throw new Error(`GET /api/board failed: ${res.status}`);
  return res.json();
}

/**
 * Create a new card at the end of a column.
 *
 * @param {string} columnId
 * @param {string} text
 * @returns {Promise<{ card: object }>}
 */
export async function createCard(columnId, text) {
  const res = await fetch(`${BASE}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `POST /api/cards failed: ${res.status}`);
  }
  return res.json();
}

/**
 * Move / reorder a card.
 *
 * @param {string}      cardId
 * @param {string}      columnId   – target column
 * @param {string|null} afterId    – card immediately above the new position (or null)
 * @param {string|null} beforeId   – card immediately below the new position (or null)
 * @returns {Promise<{ card: object }>}
 */
export async function moveCard(cardId, columnId, afterId, beforeId) {
  const res = await fetch(`${BASE}/cards/${cardId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, afterId, beforeId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `PATCH /api/cards/${cardId}/move failed: ${res.status}`);
  }
  return res.json();
}
