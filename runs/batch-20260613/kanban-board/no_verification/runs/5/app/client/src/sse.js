/**
 * SSE client module.
 *
 * Connects to the server's /api/stream endpoint and dispatches
 * incoming events to the store + renderer.
 */

import { openStream } from './api.js';
import { upsertCard, applyRenorm } from './store.js';
import { reconcileCard, reconcileColumn } from './render.js';

const statusEl = () => document.getElementById('connection-status');

let es = null;
let reconnectTimer = null;
let reconnectDelay = 1000;

export function connectSSE() {
  if (es) {
    es.close();
    es = null;
  }

  setStatus('connecting');

  es = openStream();

  es.addEventListener('open', () => {
    setStatus('connected');
    reconnectDelay = 1000; // reset backoff
    console.log('[sse] Connected.');
  });

  es.addEventListener('error', () => {
    setStatus('disconnected');
    es.close();
    es = null;
    scheduleReconnect();
  });

  // ── card:created ────────────────────────────────────────────────────────────
  es.addEventListener('card:created', (e) => {
    const { card } = JSON.parse(e.data);
    console.log('[sse] card:created', card.id);
    upsertCard(card);
    reconcileCard(card);
  });

  // ── card:moved ──────────────────────────────────────────────────────────────
  es.addEventListener('card:moved', (e) => {
    const { card } = JSON.parse(e.data);
    console.log('[sse] card:moved', card.id, '→', card.column_id, '@', card.position);
    upsertCard(card);
    reconcileCard(card);
  });

  // ── column:renormalized ─────────────────────────────────────────────────────
  es.addEventListener('column:renormalized', (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    console.log('[sse] column:renormalized', columnId, `(${cards.length} cards)`);
    applyRenorm(columnId, cards);
    reconcileColumn(columnId);
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  console.log(`[sse] Reconnecting in ${reconnectDelay}ms…`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSSE();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
}

function setStatus(state) {
  const el = statusEl();
  if (!el) return;
  el.className = `connection-status ${state}`;
  el.title =
    state === 'connected'
      ? 'Connected – real-time updates active'
      : state === 'connecting'
      ? 'Connecting…'
      : 'Disconnected – attempting to reconnect';
}
