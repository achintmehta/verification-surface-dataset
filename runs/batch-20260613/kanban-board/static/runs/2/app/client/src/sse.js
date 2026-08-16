/**
 * SSE client module.
 *
 * Connects to GET /api/stream and dispatches incoming events to handlers
 * provided by main.js.
 *
 * Implements exponential-backoff reconnection so the board recovers
 * automatically if the server restarts.
 */

const STATUS_EL = /** @type {HTMLElement} */ (document.getElementById('connection-status'));

let es = /** @type {EventSource|null} */ (null);
let retryDelay = 1000; // ms
let retryTimer = null;

/**
 * @typedef {Object} SSEHandlers
 * @property {function(object):void} onCardCreated
 * @property {function(object):void} onCardMoved
 * @property {function(object):void} onColumnRenormalized
 */

/**
 * Connect to the SSE stream.
 * @param {SSEHandlers} handlers
 */
export function connectSSE(handlers) {
  if (es) {
    es.close();
  }

  es = new EventSource('/api/stream');

  es.addEventListener('connected', () => {
    setStatus('connected');
    retryDelay = 1000; // reset backoff on successful connection
  });

  es.addEventListener('card:created', (e) => {
    try {
      const data = JSON.parse(e.data);
      handlers.onCardCreated(data);
    } catch (err) {
      console.error('SSE card:created parse error', err);
    }
  });

  es.addEventListener('card:moved', (e) => {
    try {
      const data = JSON.parse(e.data);
      handlers.onCardMoved(data);
    } catch (err) {
      console.error('SSE card:moved parse error', err);
    }
  });

  es.addEventListener('column:renormalized', (e) => {
    try {
      const data = JSON.parse(e.data);
      handlers.onColumnRenormalized(data);
    } catch (err) {
      console.error('SSE column:renormalized parse error', err);
    }
  });

  es.onerror = () => {
    setStatus('disconnected');
    es.close();
    es = null;

    // Exponential backoff reconnect
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryDelay = Math.min(retryDelay * 2, 30_000);
      connectSSE(handlers);
    }, retryDelay);
  };
}

function setStatus(status) {
  if (!STATUS_EL) return;
  STATUS_EL.className = `connection-status ${status}`;
  STATUS_EL.title = status === 'connected' ? 'Connected' : 'Disconnected – reconnecting…';
}
