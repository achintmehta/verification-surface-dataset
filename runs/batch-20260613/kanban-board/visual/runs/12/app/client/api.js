// Thin API client for the Kanban backend.

export async function fetchBoard() {
  const res = await fetch('/api/board');
  if (!res.ok) throw new Error('failed to load board');
  return res.json();
}

export async function createCard(columnId, text) {
  const res = await fetch('/api/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text }),
  });
  if (!res.ok) throw new Error('failed to create card');
  return res.json();
}

export async function moveCard(cardId, { columnId, beforeId, afterId }) {
  const res = await fetch(`/api/cards/${cardId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, beforeId, afterId }),
  });
  if (!res.ok) throw new Error('failed to move card');
  return res.json();
}
