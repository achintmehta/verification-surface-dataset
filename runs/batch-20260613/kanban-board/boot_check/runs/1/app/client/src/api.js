/**
 * Thin HTTP client for the Kanban API.
 */

const BASE = '/api';

export async function fetchBoard() {
  const res = await fetch(`${BASE}/board`);
  if (!res.ok) throw new Error(`fetchBoard: ${res.status}`);
  return res.json();
}

/**
 * @param {string} columnId
 * @param {string} text
 */
export async function createCard(columnId, text) {
  const res = await fetch(`${BASE}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text }),
  });
  if (!res.ok) throw new Error(`createCard: ${res.status}`);
  return res.json();
}

/**
 * @param {string} cardId
 * @param {{ columnId: string, beforeId?: string|null, afterId?: string|null }} opts
 */
export async function moveCard(cardId, { columnId, beforeId = null, afterId = null }) {
  const res = await fetch(`${BASE}/cards/${cardId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, beforeId, afterId }),
  });
  if (!res.ok) throw new Error(`moveCard: ${res.status}`);
  return res.json();
}
