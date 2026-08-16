/**
 * SSE client.
 *
 * Connects to GET /api/stream and dispatches custom DOM events on the
 * provided target element so the main module can react to server pushes.
 *
 * Dispatched events:
 *   'sse:card:created'       detail: card
 *   'sse:card:moved'         detail: card
 *   'sse:column:reordered'   detail: { columnId, cards }
 *   'sse:connected'
 *   'sse:disconnected'
 */

const RECONNECT_DELAY_MS = 3_000;

/**
 * @param {EventTarget} target  element that receives the custom events
 * @param {HTMLElement}  statusEl  the connection-status indicator
 */
export function connectSSE(target, statusEl) {
  let es;

  function setStatus(state) {
    statusEl.className = `connection-status ${state}`;
    statusEl.title = `SSE: ${state}`;
  }

  function connect() {
    setStatus('connecting');
    es = new EventSource('/api/stream');

    es.addEventListener('connected', () => {
      setStatus('connected');
      target.dispatchEvent(new CustomEvent('sse:connected'));
    });

    es.addEventListener('card:created', (e) => {
      const card = JSON.parse(e.data);
      target.dispatchEvent(new CustomEvent('sse:card:created', { detail: card }));
    });

    es.addEventListener('card:moved', (e) => {
      const card = JSON.parse(e.data);
      target.dispatchEvent(new CustomEvent('sse:card:moved', { detail: card }));
    });

    es.addEventListener('column:reordered', (e) => {
      const payload = JSON.parse(e.data);
      target.dispatchEvent(new CustomEvent('sse:column:reordered', { detail: payload }));
    });

    es.onerror = () => {
      setStatus('disconnected');
      target.dispatchEvent(new CustomEvent('sse:disconnected'));
      es.close();
      setTimeout(connect, RECONNECT_DELAY_MS);
    };
  }

  connect();

  return {
    close() { es?.close(); },
  };
}
