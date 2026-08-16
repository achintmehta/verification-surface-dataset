// Thin wrapper around the backend HTTP API.

async function handle(res) {
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return res.json();
}

export async function fetchBoard() {
  return handle(await fetch('/api/board'));
}

export async function createCard(columnId, text) {
  return handle(
    await fetch('/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text }),
    })
  );
}

export async function moveCard(id, { columnId, beforeId, afterId }) {
  return handle(
    await fetch(`/api/cards/${encodeURIComponent(id)}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId }),
    })
  );
}
