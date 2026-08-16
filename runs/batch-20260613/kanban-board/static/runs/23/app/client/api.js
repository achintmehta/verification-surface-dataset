/**
 * API client for communicating with the Kanban server.
 */

const BASE = "/api";

/**
 * Fetch the full board state.
 * @returns {Promise<Array<{id: string, title: string, position: number, cards: Array<Card>}>>}
 */
export async function fetchBoard() {
  const res = await fetch(`${BASE}/board`);
  if (!res.ok) throw new Error(`Failed to fetch board: ${res.status}`);
  return res.json();
}

/**
 * @typedef {{ id: string, column_id: string, text: string, position: number, created_at: string }} Card
 */

/**
 * Create a new card in the specified column.
 * @param {string} columnId
 * @param {string} text
 * @returns {Promise<Card>}
 */
export async function createCard(columnId, text) {
  const res = await fetch(`${BASE}/cards`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ columnId, text }),
  });
  if (!res.ok) throw new Error(`Failed to create card: ${res.status}`);
  return res.json();
}

/**
 * Move a card to a new position.
 * @param {string} cardId
 * @param {string} columnId   – target column
 * @param {string | null} afterId   – card id after which to insert (lower position)
 * @param {string | null} beforeId  – card id before which to insert (higher position)
 * @returns {Promise<Card>}
 */
export async function moveCard(cardId, columnId, afterId, beforeId) {
  const res = await fetch(`${BASE}/cards/${cardId}/move`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ columnId, afterId, beforeId }),
  });
  if (!res.ok) throw new Error(`Failed to move card: ${res.status}`);
  return res.json();
}
