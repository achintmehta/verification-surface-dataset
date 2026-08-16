/**
 * SSE client module.
 *
 * Connects to GET /api/stream and dispatches incoming events to registered
 * handlers.  Automatically reconnects with exponential back-off on failure.
 */

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS  = 30_000;

let es = null;
let reconnectDelay = RECONNECT_BASE_MS;
let handlers = {};
let statusCallback = null;

/**
 * Start the SSE connection.
 *
 * @param {object}   eventHandlers  - { eventName: handlerFn(data) }
 * @param {Function} onStatus       - called with 'connecting'|'connected'|'disconnected'
 */
export function connectSSE(eventHandlers, onStatus) {
  handlers = eventHandlers;
  statusCallback = onStatus;
  connect();
}

function connect() {
  statusCallback?.('connecting');

  es = new EventSource('/api/stream');

  es.addEventListener('connected', (e) => {
    reconnectDelay = RECONNECT_BASE_MS;
    statusCallback?.('connected');
    const data = JSON.parse(e.data);
    handlers['connected']?.(data);
  });

  es.addEventListener('card:created', (e) => {
    handlers['card:created']?.(JSON.parse(e.data));
  });

  es.addEventListener('card:moved', (e) => {
    handlers['card:moved']?.(JSON.parse(e.data));
  });

  es.addEventListener('column:reordered', (e) => {
    handlers['column:reordered']?.(JSON.parse(e.data));
  });

  es.onerror = () => {
    statusCallback?.('disconnected');
    es.close();
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    connect();
  }, reconnectDelay);
}

export function disconnectSSE() {
  es?.close();
  es = null;
}
