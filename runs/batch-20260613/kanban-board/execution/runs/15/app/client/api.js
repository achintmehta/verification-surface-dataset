// Thin wrapper around the backend HTTP API. Uses same-origin relative URLs;
// in dev, Vite proxies /api to the backend.

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return res.json();
}

export function fetchBoard() {
  return request('GET', '/api/board');
}

export function createCard(columnId, text) {
  return request('POST', '/api/cards', { columnId, text });
}

export function moveCard(cardId, { columnId, beforeId, afterId }) {
  return request('PATCH', `/api/cards/${encodeURIComponent(cardId)}/move`, {
    columnId,
    beforeId,
    afterId,
  });
}
