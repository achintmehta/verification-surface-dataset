/**
 * SSE client – connects to /api/stream and handles incoming events.
 *
 * Events:
 *   card:created      { card }
 *   card:moved        { card }
 *   column:reordered  { columnId, cards }
 */

import { upsertCard, replaceColumnCards } from './store.js';
import { renderBoard } from './render.js';

const SSE_URL = 'http://localhost:3001/api/stream';

let es = null;
let reconnectTimer = null;
const RECONNECT_DELAY_MS = 3000;

const statusEl = () => document.getElementById('connection-status');

function setStatus(state, label) {
  const el = statusEl();
  if (!el) return;
  el.className = `connection-status ${state}`;
  el.querySelector('.label').textContent = label;
}

/**
 * Connect (or reconnect) to the SSE stream.
 */
export function connectSSE() {
  if (es) {
    es.close();
    es = null;
  }

  setStatus('', 'Connecting…');

  es = new EventSource(SSE_URL);

  es.addEventListener('open', () => {
    setStatus('connected', 'Live');
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  });

  es.addEventListener('error', () => {
    setStatus('error', 'Reconnecting…');
    es.close();
    es = null;
    reconnectTimer = setTimeout(connectSSE, RECONNECT_DELAY_MS);
  });

  /* ── card:created ─────────────────────────────────────────── */
  es.addEventListener('card:created', (e) => {
    try {
      const { card } = JSON.parse(e.data);
      upsertCard(card);
      renderBoard();
    } catch (err) {
      console.error('[sse] card:created parse error', err);
    }
  });

  /* ── card:moved ───────────────────────────────────────────── */
  es.addEventListener('card:moved', (e) => {
    try {
      const { card } = JSON.parse(e.data);
      upsertCard(card);
      renderBoard();
    } catch (err) {
      console.error('[sse] card:moved parse error', err);
    }
  });

  /* ── column:reordered ─────────────────────────────────────── */
  es.addEventListener('column:reordered', (e) => {
    try {
      const { columnId, cards } = JSON.parse(e.data);
      replaceColumnCards(columnId, cards);
      renderBoard();
    } catch (err) {
      console.error('[sse] column:reordered parse error', err);
    }
  });
}
