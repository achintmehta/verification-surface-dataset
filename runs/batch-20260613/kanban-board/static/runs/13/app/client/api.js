// Thin API client for the Kanban backend.

async function request(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
    } catch {
      /* ignore parse errors */
    }
    const err = new Error(message);
    err.status = res.status;
    throw err;
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
  return request(`/api/cards/${encodeURIComponent(cardId)}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, beforeId, afterId }),
  });
}
