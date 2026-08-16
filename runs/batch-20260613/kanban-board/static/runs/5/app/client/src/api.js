/**
 * Thin HTTP client for the Kanban API.
 *
 * All functions return the parsed JSON body on success and throw an Error
 * (with a human-readable message) on failure.
 *
 * In development, Vite proxies /api/* to the Express server, so we use
 * relative URLs.  In production (or when VITE_API_URL is set), we use the
 * configured base URL.
 */

const BASE = import.meta.env.VITE_API_URL ?? '';

async function request(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(`${BASE}${path}`, opts);

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const json = await res.json();
      if (json.error) message = json.error;
    } catch {
      // ignore parse errors
    }
    throw new Error(message);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Fetch the full board state. */
export function fetchBoard() {
  return request('GET', '/api/board');
}

/**
 * Create a new card in a column.
 * @param {string} columnId
 * @param {string} text
 */
export function createCard(columnId, text) {
  return request('POST', '/api/cards', { columnId, text });
}

/**
 * Move / reorder a card.
 *
 * @param {string}      cardId
 * @param {string}      columnId  – target column
 * @param {string|null} beforeId  – card immediately before (lower position), or null
 * @param {string|null} afterId   – card immediately after (higher position), or null
 */
export function moveCard(cardId, columnId, beforeId, afterId) {
  return request('PATCH', `/api/cards/${cardId}/move`, {
    columnId,
    beforeId,
    afterId,
  });
}
