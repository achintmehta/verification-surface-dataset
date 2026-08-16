/**
 * Thin HTTP client for the Kanban API.
 */

const BASE = '/api';

export async function fetchBoard() {
  const res = await fetch(`${BASE}/board`);
  if (!res.ok) throw new Error(`fetchBoard failed: ${res.status}`);
  return res.json();
}

/**
 * Create a new card at the end of a column.
 * @param {string} columnId
 * @param {string} text
 * @returns {Promise<object>} canonical card
 */
export async function createCard(columnId, text) {
  const res = await fetch(`${BASE}/cards`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ columnId, text }),
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
 * @param {string} columnId  target column
 * @param {string|null} beforeId  card that will be directly above (null = top)
 * @param {string|null} afterId   card that will be directly below (null = bottom)
 * @returns {Promise<object>} canonical card
 */
export async function moveCard(cardId, columnId, beforeId, afterId) {
  const res = await fetch(`${BASE}/cards/${cardId}/move`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ columnId, beforeId, afterId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `moveCard failed: ${res.status}`);
  }
  return res.json();
}
