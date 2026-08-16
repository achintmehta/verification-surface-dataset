/**
 * SSE client module.
 *
 * Connects to /api/stream and dispatches incoming events to registered handlers.
 * Automatically reconnects on connection loss with exponential back-off.
 */

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS  = 30_000;

let es = null;
let reconnectDelay = RECONNECT_BASE_MS;
let reconnectTimer = null;

const handlers = {};

/**
 * Register a handler for a named SSE event.
 * @param {string}   eventName
 * @param {Function} fn  - called with the parsed JSON data object
 */
export function on(eventName, fn) {
  if (!handlers[eventName]) handlers[eventName] = [];
  handlers[eventName].push(fn);
}

/** Status change callback (optional) */
let statusCallback = null;
export function onStatusChange(fn) { statusCallback = fn; }

function setStatus(connected) {
  if (statusCallback) statusCallback(connected);
}

/**
 * Open the SSE connection.
 */
export function connect() {
  if (es) {
    es.close();
    es = null;
  }

  es = new EventSource('/api/stream');

  es.addEventListener('connected', () => {
    console.log('[sse] connected');
    reconnectDelay = RECONNECT_BASE_MS;
    setStatus(true);
  });

  // Register all named event handlers
  for (const [eventName, fns] of Object.entries(handlers)) {
    for (const fn of fns) {
      es.addEventListener(eventName, (e) => {
        try {
          const data = JSON.parse(e.data);
          fn(data);
        } catch (err) {
          console.error(`[sse] error handling event "${eventName}":`, err);
        }
      });
    }
  }

  es.onerror = () => {
    console.warn('[sse] connection error, will reconnect…');
    setStatus(false);
    es.close();
    es = null;
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    connect();
  }, reconnectDelay);
}

export function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (es) {
    es.close();
    es = null;
  }
  setStatus(false);
}
