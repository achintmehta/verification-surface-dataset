/**
 * SSE connection manager.
 *
 * Connects to GET /api/stream and dispatches incoming events to registered
 * handlers.  Automatically reconnects with exponential back-off on failure.
 *
 * Supported server events:
 *   board:init     – full board state (sent once on connect)
 *   card:created   – a new card was created
 *   card:moved     – a card was moved / reordered
 *   column:reorder – a column's cards were renormalised
 */

import { openStream } from './api.js';

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS  = 30_000;

let es = null;
let reconnectDelay = RECONNECT_BASE_MS;
let reconnectTimer = null;

const handlers = {
  'board:init':     [],
  'card:created':   [],
  'card:moved':     [],
  'column:reorder': [],
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a handler for a specific event type.
 * @param {keyof handlers} eventType
 * @param {(payload: object) => void} fn
 */
export function on(eventType, fn) {
  if (handlers[eventType]) handlers[eventType].push(fn);
}

/**
 * Open the SSE connection.
 * @param {(connected: boolean) => void} onStatusChange
 */
export function connect(onStatusChange) {
  if (es) return;
  _open(onStatusChange);
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function _open(onStatusChange) {
  es = openStream();

  es.onopen = () => {
    reconnectDelay = RECONNECT_BASE_MS;
    onStatusChange(true);
  };

  es.onerror = () => {
    onStatusChange(false);
    es.close();
    es = null;
    _scheduleReconnect(onStatusChange);
  };

  // Register named event listeners for each event type.
  for (const [type, fns] of Object.entries(handlers)) {
    es.addEventListener(type, (e) => {
      try {
        const { payload } = JSON.parse(e.data);
        for (const fn of fns) fn(payload);
      } catch (err) {
        console.error(`[stream] Failed to parse event "${type}":`, err);
      }
    });
  }
}

function _scheduleReconnect(onStatusChange) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    console.log(`[stream] Reconnecting… (delay ${reconnectDelay}ms)`);
    _open(onStatusChange);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  }, reconnectDelay);
}
