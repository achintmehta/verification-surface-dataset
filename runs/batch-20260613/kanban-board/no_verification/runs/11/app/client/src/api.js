// Thin API client for the Kanban backend.

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
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export function fetchBoard() {
  return jsonFetch('/api/board');
}

export function createCard(columnId, text) {
  return jsonFetch('/api/cards', {
    method: 'POST',
    body: JSON.stringify({ columnId, text }),
  });
}

export function moveCard(cardId, { columnId, beforeId, afterId }) {
  return jsonFetch(`/api/cards/${encodeURIComponent(cardId)}/move`, {
    method: 'PATCH',
    body: JSON.stringify({ columnId, beforeId, afterId }),
  });
}
