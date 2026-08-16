/**
 * api.js – Thin HTTP client for the Kanban backend.
 *
 * In development, Vite proxies /api/* to the Express server so we use a
 * relative base.  In production (or when VITE_API_BASE is set explicitly),
 * we use the configured origin.
 *
 * All functions return the parsed JSON body on success and throw on HTTP
 * errors so callers can handle them uniformly.
 */

const BASE = import.meta.env.VITE_API_BASE ?? '';

async function request(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res  = await fetch(`${BASE}${path}`, opts);
  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = json?.error ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

/**
 * Fetch the full board state.
 * @returns {Promise<{ columns: Array }>}
 */
export function fetchBoard() {
  return request('GET', '/api/board');
}

/**
 * Create a new card in a column.
 * @param {string} columnId
 * @param {string} text
 * @returns {Promise<{ card: object }>}
 */
export function createCard(columnId, text) {
  return request('POST', '/api/cards', { columnId, text });
}

/**
 * Move a card to a new position.
 *
 * @param {string}      cardId
 * @param {string}      columnId   target column
 * @param {string|null} beforeId   card immediately before (lower position), or null
 * @param {string|null} afterId    card immediately after  (higher position), or null
 * @returns {Promise<{ card: object }>}
 */
export function moveCard(cardId, columnId, beforeId, afterId) {
  return request('PATCH', `/api/cards/${cardId}/move`, {
    columnId,
    beforeId: beforeId ?? null,
    afterId:  afterId  ?? null,
  });
}
