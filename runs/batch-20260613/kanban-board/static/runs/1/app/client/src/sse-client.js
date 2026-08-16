/**
 * SSE client module.
 *
 * Connects to GET /api/stream and dispatches incoming events to the
 * appropriate state + DOM update functions.
 *
 * Reconnection is handled automatically by the browser's EventSource
 * implementation.
 */

import {
  applyCardCreated,
  applyCardMoved,
  applyRenorm,
} from './state.js';

import {
  reconcileCard,
  reconcileColumn,
} from './board.js';

/** @type {EventSource | null} */
let es = null;

/** @param {HTMLElement} statusEl */
export function connectSSE(statusEl) {
  if (es) {
    es.close();
  }

  es = new EventSource('/api/stream');

  es.addEventListener('open', () => {
    console.log('[sse] Connected');
    statusEl.classList.add('connected');
    statusEl.title = 'Connected';
  });

  es.addEventListener('error', () => {
    console.warn('[sse] Connection error / reconnecting…');
    statusEl.classList.remove('connected');
    statusEl.title = 'Reconnecting…';
  });

  /* ---- card:created -------------------------------------------- */
  es.addEventListener('card:created', (e) => {
    const { card } = JSON.parse(e.data);
    console.log('[sse] card:created', card.id);

    // Apply to state first, then reconcile DOM.
    applyCardCreated(card);
    reconcileCard(card);
  });

  /* ---- card:moved ---------------------------------------------- */
  es.addEventListener('card:moved', (e) => {
    const { card, sourceColumnId } = JSON.parse(e.data);
    console.log('[sse] card:moved', card.id, '→', card.column_id);

    applyCardMoved(card, sourceColumnId);
    reconcileCard(card, sourceColumnId);
  });

  /* ---- renorm -------------------------------------------------- */
  es.addEventListener('renorm', (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    console.log('[sse] renorm column', columnId);

    applyRenorm(columnId, cards);
    reconcileColumn(columnId);
  });
}
