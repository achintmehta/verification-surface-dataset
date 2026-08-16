// Thin wrapper around the backend HTTP API. Same-origin in production; the
// Vite dev server proxies /api to the backend.

async function request(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let message = `Request failed: ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
    } catch {
      /* ignore non-JSON error bodies */
    }
    throw new Error(message);
  }
  return res.json();
}

export function fetchBoard() {
  return request('/api/board', { method: 'GET' });
}

export function createCard(columnId, text) {
  return request('/api/cards', {
    method: 'POST',
    body: JSON.stringify({ columnId, text }),
  });
}

/**
 * Tell the server to move a card into `columnId` between `afterId` (the card
 * directly above) and `beforeId` (the card directly below). Either may be null.
 */
export function moveCard(cardId, { columnId, afterId, beforeId }) {
  return request(`/api/cards/${encodeURIComponent(cardId)}/move`, {
    method: 'PATCH',
    body: JSON.stringify({ columnId, afterId, beforeId }),
  });
}
