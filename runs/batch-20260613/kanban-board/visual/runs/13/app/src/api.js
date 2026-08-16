// Thin wrapper around the backend HTTP API.

async function request(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    let message = `Request failed: ${res.status}`;
    try {
      const body = await res.json();
      if (body.error) message = body.error;
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

export function moveCard(cardId, { columnId, beforeId, afterId }) {
  return request(`/api/cards/${cardId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, beforeId, afterId }),
  });
}
