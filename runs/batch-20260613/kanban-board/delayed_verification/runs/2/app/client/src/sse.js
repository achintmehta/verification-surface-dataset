/**
 * SSE client module.
 *
 * Connects to GET /api/stream and dispatches incoming events to
 * registered handlers. Automatically reconnects on error.
 */

const SSE_URL = 'http://localhost:3001/api/stream';

/** @type {EventSource | null} */
let es = null;

/** @type {Map<string, (data: object) => void>} */
const handlers = new Map();

/** @type {((status: 'connecting'|'connected'|'disconnected') => void) | null} */
let statusCallback = null;

/**
 * Register a handler for a named SSE event.
 * @param {string}   event
 * @param {(data: object) => void} handler
 */
export function on(event, handler) {
  handlers.set(event, handler);
}

/**
 * Register a callback for connection status changes.
 * @param {(status: string) => void} cb
 */
export function onStatus(cb) {
  statusCallback = cb;
}

/** Open the SSE connection. */
export function connect() {
  if (es) return;

  statusCallback?.('connecting');
  es = new EventSource(SSE_URL);

  es.addEventListener('open', () => {
    statusCallback?.('connected');
  });

  es.addEventListener('error', () => {
    statusCallback?.('disconnected');
    es?.close();
    es = null;
    // Reconnect after 3 s
    setTimeout(connect, 3000);
  });

  // Wire up all registered event handlers
  for (const [event, handler] of handlers) {
    es.addEventListener(event, (e) => {
      try {
        handler(JSON.parse(e.data));
      } catch (err) {
        console.error(`SSE handler error for event "${event}":`, err);
      }
    });
  }
}

/** Close the SSE connection (e.g. for cleanup). */
export function disconnect() {
  es?.close();
  es = null;
}
