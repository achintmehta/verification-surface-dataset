// SSE client connection

let eventSource = null;
let reconnectTimeout = null;

export function connectSSE(handlers) {
  if (eventSource) {
    eventSource.close();
  }

  const statusEl = document.getElementById('connection-status');

  function connect() {
    eventSource = new EventSource('/api/stream');

    eventSource.onopen = () => {
      if (statusEl) {
        statusEl.textContent = 'Connected';
        statusEl.className = 'status connected';
      }
    };

    eventSource.onerror = () => {
      if (statusEl) {
        statusEl.textContent = 'Disconnected';
        statusEl.className = 'status disconnected';
      }
      eventSource.close();
      eventSource = null;
      // Reconnect after a delay
      reconnectTimeout = setTimeout(connect, 2000);
    };

    eventSource.addEventListener('card-created', (e) => {
      try {
        const data = JSON.parse(e.data);
        handlers.onCardCreated(data);
      } catch (err) {
        console.error('SSE card-created parse error:', err);
      }
    });

    eventSource.addEventListener('card-moved', (e) => {
      try {
        const data = JSON.parse(e.data);
        handlers.onCardMoved(data);
      } catch (err) {
        console.error('SSE card-moved parse error:', err);
      }
    });

    eventSource.addEventListener('card-deleted', (e) => {
      try {
        const data = JSON.parse(e.data);
        handlers.onCardDeleted(data);
      } catch (err) {
        console.error('SSE card-deleted parse error:', err);
      }
    });
  }

  connect();
}

export function disconnectSSE() {
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}
