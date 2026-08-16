/**
 * SSE client – connects to /api/stream and dispatches events.
 */

const connStatusEl = document.getElementById('conn-status');

let es = null;
let reconnectTimer = null;

/**
 * @param {{ onCardCreated, onCardMoved, onColumnReordered }} handlers
 */
export function connectSSE({ onCardCreated, onCardMoved, onColumnReordered }) {
  if (es) {
    es.close();
    es = null;
  }

  es = new EventSource('/api/stream');

  es.addEventListener('open', () => {
    console.log('[sse] connected');
    setStatus('connected');
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  });

  es.addEventListener('card:created', e => {
    try { onCardCreated(JSON.parse(e.data)); } catch (err) { console.error('[sse] card:created parse error', err); }
  });

  es.addEventListener('card:moved', e => {
    try { onCardMoved(JSON.parse(e.data)); } catch (err) { console.error('[sse] card:moved parse error', err); }
  });

  es.addEventListener('column:reordered', e => {
    try { onColumnReordered(JSON.parse(e.data)); } catch (err) { console.error('[sse] column:reordered parse error', err); }
  });

  es.addEventListener('error', () => {
    console.warn('[sse] connection error – will reconnect');
    setStatus('disconnected');
    es.close();
    es = null;
    // Exponential back-off capped at 10 s
    const delay = reconnectTimer ? 10_000 : 2_000;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectSSE({ onCardCreated, onCardMoved, onColumnReordered });
    }, delay);
  });
}

function setStatus(state) {
  if (!connStatusEl) return;
  connStatusEl.className = `connection-status ${state}`;
  connStatusEl.title = state === 'connected' ? 'Connected' : 'Disconnected – reconnecting…';
}
