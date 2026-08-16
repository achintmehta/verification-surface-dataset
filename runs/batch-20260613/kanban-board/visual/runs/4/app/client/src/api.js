const BASE = 'http://localhost:3001/api';

export async function fetchBoard() {
  const res = await fetch(`${BASE}/board`);
  if (!res.ok) throw new Error(`fetchBoard: ${res.status}`);
  return res.json(); // { columns: [...] }
}

export async function createCard(columnId, text) {
  const res = await fetch(`${BASE}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text }),
  });
  if (!res.ok) throw new Error(`createCard: ${res.status}`);
  return res.json(); // { card }
}

/**
 * @param {string} id       - card being moved
 * @param {string} columnId - target column
 * @param {string|null} afterId  - card immediately above  (null = top)
 * @param {string|null} beforeId - card immediately below  (null = bottom)
 */
export async function moveCard(id, columnId, afterId, beforeId) {
  const res = await fetch(`${BASE}/cards/${id}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, afterId, beforeId }),
  });
  if (!res.ok) throw new Error(`moveCard: ${res.status}`);
  return res.json(); // { card }
}

export function openEventStream(handlers) {
  const es = new EventSource(`${BASE}/stream`);

  es.addEventListener('card:created', e => {
    handlers.onCardCreated?.(JSON.parse(e.data));
  });

  es.addEventListener('card:moved', e => {
    handlers.onCardMoved?.(JSON.parse(e.data));
  });

  es.addEventListener('column:reordered', e => {
    handlers.onColumnReordered?.(JSON.parse(e.data));
  });

  es.onopen = () => handlers.onOpen?.();
  es.onerror = () => handlers.onError?.();

  return es;
}
