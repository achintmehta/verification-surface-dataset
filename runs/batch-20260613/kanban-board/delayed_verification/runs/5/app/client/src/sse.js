/**
 * sse.js – EventSource connection and event dispatch.
 *
 * Connects to GET /api/stream and dispatches incoming events to registered
 * handlers.  Implements exponential-backoff reconnection on error.
 *
 * In development, Vite proxies /api/stream to the Express server so we use a
 * relative URL.  Set VITE_API_BASE to override (e.g. in production).
 */

const BASE = import.meta.env.VITE_API_BASE ?? '';

/** @type {EventSource|null} */
let es = null;

/** @type {Map<string, (data: unknown) => void>} */
const handlers = new Map();

/** Callback to report connection status changes. */
let statusCallback = (_status) => {};

let retryDelay = 1_000; // ms, doubles on each failure up to MAX_RETRY
const MAX_RETRY = 30_000;

/** @type {ReturnType<typeof setTimeout>|null} */
let retryTimer = null;

/**
 * Register a handler for a named SSE event.
 * Must be called before `connect()`.
 *
 * @param {string}   event
 * @param {(data: unknown) => void} handler
 */
export function on(event, handler) {
  handlers.set(event, handler);
}

/**
 * Open the SSE connection (or reconnect after a failure).
 *
 * @param {(status: 'connecting'|'connected'|'disconnected') => void} onStatus
 */
export function connect(onStatus) {
  statusCallback = onStatus;

  if (es) {
    es.close();
    es = null;
  }

  onStatus('connecting');
  es = new EventSource(`${BASE}/api/stream`);

  es.addEventListener('open', () => {
    retryDelay = 1_000;
    onStatus('connected');
  });

  es.addEventListener('error', () => {
    es?.close();
    es = null;
    onStatus('disconnected');

    // Exponential backoff reconnect.
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => connect(statusCallback), retryDelay);
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY);
  });

  // Wire up all registered named-event handlers.
  for (const [event, handler] of handlers) {
    es.addEventListener(event, (e) => {
      try {
        handler(JSON.parse(e.data));
      } catch (err) {
        console.error(`[sse] failed to handle event "${event}":`, err);
      }
    });
  }
}

/**
 * Close the SSE connection permanently (e.g. on page unload).
 */
export function disconnect() {
  if (retryTimer) clearTimeout(retryTimer);
  es?.close();
  es = null;
}
