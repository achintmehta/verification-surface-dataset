const BASE = (typeof window !== 'undefined' && window.location.port === '5173')
  ? 'http://localhost:3001/api'
  : '/api';

export async function fetchBoard() {
  const r = await fetch(`${BASE}/board`);
  if (!r.ok) throw new Error(`fetchBoard: ${r.status}`);
  return r.json(); // { columns: [...] }
}

export async function createCard(columnId, text) {
  const r = await fetch(`${BASE}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text }),
  });
  if (!r.ok) throw new Error(`createCard: ${r.status}`);
  return r.json(); // { card }
}

export async function moveCard(id, { columnId, beforeId, afterId }) {
  const r = await fetch(`${BASE}/cards/${id}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, beforeId: beforeId ?? null, afterId: afterId ?? null }),
  });
  if (!r.ok) throw new Error(`moveCard: ${r.status}`);
  return r.json(); // { card }
}

export function openStream() {
  return new EventSource(`${BASE}/stream`);
}
