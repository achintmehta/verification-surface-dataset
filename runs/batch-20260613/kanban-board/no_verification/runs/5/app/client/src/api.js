/**
 * API client – thin wrappers around fetch calls to the backend.
 *
 * When running through the Vite dev server the proxy forwards /api/* to the
 * backend, so we use a relative base URL.  In production the same server
 * serves both the static files and the API, so relative URLs work there too.
 * An explicit VITE_API_BASE env-var can override this for other deployments.
 */

const BASE = import.meta.env.VITE_API_BASE ?? '';

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
 * Move a card to a new column / position.
 *
 * @param {string} cardId
 * @param {string} columnId   - target column
 * @param {string|null} afterId  - card immediately ABOVE (lower position), or null
 * @param {string|null} beforeId - card immediately BELOW (higher position), or null
 * @returns {Promise<{ card: object }>}
 */
export async function moveCard(cardId, columnId, afterId, beforeId) {
  const res = await fetch(`${BASE}/api/cards/${cardId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, afterId: afterId ?? null, beforeId: beforeId ?? null }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `moveCard failed: ${res.status}`);
  }
  return res.json();
}

/**
 * Open an SSE connection to the server's stream endpoint.
 * @returns {EventSource}
 */
export function openStream() {
  return new EventSource(`${BASE}/api/stream`);
}
