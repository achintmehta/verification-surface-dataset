// Thin wrapper around the backend REST API.

async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let message = `Request failed: ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return res.status === 204 ? null : res.json();
}

export function fetchBoard() {
  return request('/api/board');
}

export function createCard(columnId, text) {
  return request('/api/cards', {
    method: 'POST',
    body: JSON.stringify({ columnId, text }),
  });
}

export function moveCard(id, { columnId, beforeId, afterId }) {
  return request(`/api/cards/${encodeURIComponent(id)}/move`, {
    method: 'PATCH',
    body: JSON.stringify({ columnId, beforeId, afterId }),
  });
}
