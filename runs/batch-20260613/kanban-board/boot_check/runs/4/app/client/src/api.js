const BASE = 'http://localhost:3001/api';

export async function fetchBoard() {
  const res = await fetch(`${BASE}/board`);
  if (!res.ok) throw new Error(`fetchBoard failed: ${res.status}`);
  return res.json(); // { columns: [...] }
}

/**
 * Create a new card.
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
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `createCard failed: ${res.status}`);
  }
  return res.json();
}

/**
 * Move a card.
 * @param {string} cardId
 * @param {string} columnId   - target column
 * @param {string|null} beforeId - card that should come before (lower position)
 * @param {string|null} afterId  - card that should come after  (higher position)
 * @returns {Promise<{card: object}>}
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
  return res.json();
}
