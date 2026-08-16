const BASE = '/api';

async function jsonFetch(url, options) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
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
  return jsonFetch(`${BASE}/board`);
}

export function createCard(columnId, text) {
  return jsonFetch(`${BASE}/cards`, {
    method: 'POST',
    body: JSON.stringify({ columnId, text }),
  });
}

export function moveCard(cardId, { columnId, beforeId, afterId }) {
  return jsonFetch(`${BASE}/cards/${cardId}/move`, {
    method: 'PATCH',
    body: JSON.stringify({ columnId, beforeId, afterId }),
  });
}

export function openStream() {
  return new EventSource(`${BASE}/stream`);
}
