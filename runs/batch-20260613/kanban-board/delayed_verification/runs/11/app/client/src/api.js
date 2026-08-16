const BASE = '/api';

export async function fetchBoard() {
  const res = await fetch(`${BASE}/board`);
  if (!res.ok) throw new Error('Failed to load board');
  return res.json();
}

export async function createCard(columnId, text) {
  const res = await fetch(`${BASE}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text }),
  });
  if (!res.ok) throw new Error('Failed to create card');
  return res.json();
}

export async function moveCard(cardId, { columnId, beforeId, afterId }) {
  const res = await fetch(`${BASE}/cards/${cardId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, beforeId, afterId }),
  });
  if (!res.ok) throw new Error('Failed to move card');
  return res.json();
}

/**
 * Subscribe to the server SSE stream. Returns the EventSource instance.
 */
export function openStream({ onCreate, onMove, onOpen, onError }) {
  const es = new EventSource(`${BASE}/stream`);
  es.addEventListener('open', () => onOpen?.());
  es.addEventListener('error', () => onError?.());
  es.addEventListener('card:create', (e) => {
    onCreate?.(JSON.parse(e.data));
  });
  es.addEventListener('card:move', (e) => {
    onMove?.(JSON.parse(e.data));
  });
  return es;
}
