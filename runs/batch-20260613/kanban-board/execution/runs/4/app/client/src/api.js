/**
 * Thin API client for the Kanban backend.
 */

const BASE = '/api';

export async function fetchBoard() {
  const res = await fetch(`${BASE}/board`);
  if (!res.ok) throw new Error(`fetchBoard: ${res.status}`);
  return res.json(); // { columns: [...] }
}

export async function createCard(columnId, text) {
  const res = await fetch(`${BASE}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text }),
  });
  if (!res.ok) throw new Error(`createCard: ${res.status}`);
  return res.json(); // { card }
}

/**
 * Move a card.
 * @param {string}      cardId
 * @param {string}      columnId  - target column
 * @param {string|null} beforeId  - card immediately above the target slot
 * @param {string|null} afterId   - card immediately below the target slot
 */
export async function moveCard(cardId, columnId, beforeId, afterId) {
  const res = await fetch(`${BASE}/cards/${cardId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, beforeId, afterId }),
  });
  if (!res.ok) throw new Error(`moveCard: ${res.status}`);
  return res.json(); // { card }
}
