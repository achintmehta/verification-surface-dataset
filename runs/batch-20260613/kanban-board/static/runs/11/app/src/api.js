// Thin wrapper around the backend HTTP API.

async function request(path, options = {}) {
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
      // ignore parse errors
    }
    throw new Error(message);
  }
  return res.json();
}

export function fetchBoard() {
  return request('/api/board');
}

export function createCard(columnId, text) {
  return request('/api/cards', {
    method: 'POST',
    body: JSON.stringify({ columnId, text }),
  });
}

/**
 * Move a card.
 * @param {string} cardId
 * @param {{columnId:string, beforeId:string|null, afterId:string|null}} target
 */
export function moveCard(cardId, { columnId, beforeId, afterId }) {
  return request(`/api/cards/${encodeURIComponent(cardId)}/move`, {
    method: 'PATCH',
    body: JSON.stringify({ columnId, beforeId, afterId }),
  });
}
