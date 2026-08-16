/**
 * SSE client module.
 *
 * Connects to GET /api/stream and handles incoming events:
 *   - card:created  → upsert card, re-render column
 *   - card:moved    → upsert card (canonical position), apply renorm if any,
 *                     re-render affected columns
 *
 * Implements exponential-backoff reconnection so the board stays live
 * even if the server restarts.
 */

import { openEventSource } from './api.js';
import { upsertCard, applyRenorm, getCard } from './store.js';
import { renderColumn } from './board.js';

const statusEl = document.getElementById('connection-status');
const labelEl  = statusEl.querySelector('.label');

let es = null;
let reconnectDelay = 1000; // ms
let reconnectTimer = null;

/* ── Status helpers ─────────────────────────────────────────────────── */

function setStatus(state, text) {
  statusEl.className = `connection-status ${state}`;
  labelEl.textContent = text;
}

/* ── Connect ────────────────────────────────────────────────────────── */

export function connectSSE() {
  if (es) {
    es.close();
    es = null;
  }

  setStatus('', 'Connecting…');
  es = openEventSource();

  es.addEventListener('open', () => {
    setStatus('connected', 'Live');
    reconnectDelay = 1000; // reset backoff
  });

  /* ── card:created ─────────────────────────────────────────────────── */
  es.addEventListener('card:created', (e) => {
    try {
      const { card } = JSON.parse(e.data);
      upsertCard(card);
      renderColumn(card.column_id);
    } catch (err) {
      console.error('[sse] card:created parse error', err);
    }
  });

  /* ── card:moved ───────────────────────────────────────────────────── */
  es.addEventListener('card:moved', (e) => {
    try {
      const { card, renormedCards } = JSON.parse(e.data);

      // Determine which columns need re-rendering
      const affectedColumns = new Set();

      // The card's previous column (before the server move)
      const existing = getCard(card.id);
      if (existing && existing.column_id !== card.column_id) {
        affectedColumns.add(existing.column_id);
      }
      affectedColumns.add(card.column_id);

      // Apply canonical card state
      upsertCard(card);

      // Apply renormalization if the server renormed the column
      if (renormedCards && renormedCards.length > 0) {
        applyRenorm(renormedCards, card.column_id);
      }

      // Re-render all affected columns
      for (const colId of affectedColumns) {
        renderColumn(colId);
      }
    } catch (err) {
      console.error('[sse] card:moved parse error', err);
    }
  });

  /* ── Error / reconnect ────────────────────────────────────────────── */
  es.addEventListener('error', () => {
    setStatus('error', 'Disconnected');
    es.close();
    es = null;

    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
      connectSSE();
    }, reconnectDelay);
  });
}
