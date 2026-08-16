/**
 * Thin HTTP client for the Kanban board API.
 */

const BASE = 'http://localhost:3001/api';

/**
 * Fetch the full board state from the server.
 * Returns an array of column objects, each with a `cards` array.
 */
export async function fetchBoard() {
  const res = await fetch(`${BASE}/board`);
  if (!res.ok) throw new Error(`GET /api/board failed: ${res.status}`);
  return res.json();
}

/**
 * Create a new card in the given column.
 * @param {string} columnId
 * @param {string} text
 * @returns {Promise<{card: object}>}
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
 * Move a card to a new column and position.
 *
 * @param {string} cardId   – card being moved
 * @param {string} columnId – target column
 * @param {string|null} beforeId – card that will come AFTER the moved card
 * @param {string|null} afterId  – card that will come BEFORE the moved card
 * @returns {Promise<{card: object}>}
 */
export async function moveCard(cardId, columnId, beforeId, afterId) {
  const res = await fetch(`${BASE}/cards/${cardId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, beforeId, afterId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `PATCH /api/cards/${cardId}/move failed: ${res.status}`);
  }
  return res.json();
}
