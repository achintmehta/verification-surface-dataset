const API_BASE = '/api';

export async function fetchBoard() {
  const res = await fetch(`${API_BASE}/board`);
  if (!res.ok) throw new Error('Failed to fetch board');
  return res.json();
}

export async function createCard(columnId, text) {
  const res = await fetch(`${API_BASE}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text })
  });
  if (!res.ok) throw new Error('Failed to create card');
  return res.json();
}

export async function moveCard(cardId, columnId, afterId, beforeId) {
  const res = await fetch(`${API_BASE}/cards/${cardId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, afterId: afterId || null, beforeId: beforeId || null })
  });
  if (!res.ok) throw new Error('Failed to move card');
  return res.json();
}

export async function deleteCard(cardId) {
  const res = await fetch(`${API_BASE}/cards/${cardId}`, {
    method: 'DELETE'
  });
  if (!res.ok) throw new Error('Failed to delete card');
  return res.json();
}

export function connectSSE(handlers) {
  const eventSource = new EventSource(`${API_BASE}/stream`);
  
  eventSource.addEventListener('card:created', (e) => {
    const data = JSON.parse(e.data);
    handlers.onCardCreated(data);
  });

  eventSource.addEventListener('card:moved', (e) => {
    const data = JSON.parse(e.data);
    handlers.onCardMoved(data);
  });

  eventSource.addEventListener('card:deleted', (e) => {
    const data = JSON.parse(e.data);
    handlers.onCardDeleted(data);
  });

  eventSource.addEventListener('column:renormalized', (e) => {
    const data = JSON.parse(e.data);
    handlers.onColumnRenormalized(data);
  });

  eventSource.onopen = () => {
    handlers.onConnected();
  };

  eventSource.onerror = () => {
    handlers.onDisconnected();
  };

  return eventSource;
}
