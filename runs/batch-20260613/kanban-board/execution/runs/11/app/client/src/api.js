// Thin API client for the Kanban backend.

async function jsonOrThrow(res) {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body && body.error) msg = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json();
}

export async function fetchBoard() {
  const res = await fetch('/api/board');
  return jsonOrThrow(res);
}

export async function createCard(columnId, text) {
  const res = await fetch('/api/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text })
  });
  return jsonOrThrow(res);
}

export async function moveCard(cardId, { columnId, beforeId, afterId }) {
  const res = await fetch(`/api/cards/${encodeURIComponent(cardId)}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, beforeId, afterId })
  });
  return jsonOrThrow(res);
}
