// Thin wrapper around the backend HTTP API.

async function request(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let message = `Request failed: ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
    } catch {
      /* ignore */
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text }),
  });
}

/**
 * Sends a move intent. The server computes the canonical position.
 * @param {string} cardId
 * @param {{columnId: string, beforeId: string|null, afterId: string|null}} intent
 */
export function moveCard(cardId, intent) {
  return request(`/api/cards/${encodeURIComponent(cardId)}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(intent),
  });
}
