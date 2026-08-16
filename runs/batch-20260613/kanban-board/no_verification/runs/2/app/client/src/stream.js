/**
 * SSE stream manager.
 *
 * Connects to /api/stream, handles reconnection with exponential back-off,
 * and dispatches incoming events to the provided handlers.
 */

import { openStream } from './api.js';

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;

let es = null;
let backoff = BASE_BACKOFF_MS;
let reconnectTimer = null;

/**
 * @typedef {Object} StreamHandlers
 * @property {(card: object) => void} onCardCreated
 * @property {(card: object) => void} onCardMoved
 * @property {(columnId: string, cards: object[]) => void} onColumnReorder
 * @property {(status: 'connected'|'disconnected'|'reconnecting') => void} onStatusChange
 */

/**
 * Start the SSE connection.
 * @param {StreamHandlers} handlers
 */
export function startStream(handlers) {
  connect(handlers);
}

function connect(handlers) {
  if (es) {
    es.close();
    es = null;
  }

  handlers.onStatusChange('reconnecting');

  try {
    es = openStream();
  } catch (err) {
    console.error('[stream] Failed to open EventSource:', err);
    scheduleReconnect(handlers);
    return;
  }

  es.addEventListener('open', () => {
    backoff = BASE_BACKOFF_MS;
    handlers.onStatusChange('connected');
  });

  es.addEventListener('card-created', (e) => {
    try {
      const { card } = JSON.parse(e.data);
      handlers.onCardCreated(card);
    } catch (err) {
      console.error('[stream] card-created parse error', err);
    }
  });

  es.addEventListener('card-moved', (e) => {
    try {
      const { card } = JSON.parse(e.data);
      handlers.onCardMoved(card);
    } catch (err) {
      console.error('[stream] card-moved parse error', err);
    }
  });

  es.addEventListener('column-reorder', (e) => {
    try {
      const { columnId, cards } = JSON.parse(e.data);
      handlers.onColumnReorder(columnId, cards);
    } catch (err) {
      console.error('[stream] column-reorder parse error', err);
    }
  });

  es.addEventListener('error', () => {
    handlers.onStatusChange('disconnected');
    es.close();
    es = null;
    scheduleReconnect(handlers);
  });
}

function scheduleReconnect(handlers) {
  if (reconnectTimer) return;
  console.log(`[stream] Reconnecting in ${backoff}ms…`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    connect(handlers);
  }, backoff);
}
