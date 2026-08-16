/**
 * SSE client module.
 *
 * Connects to GET /api/stream and dispatches incoming events to the
 * appropriate state + DOM update handlers.
 *
 * Reconnection is handled automatically by the browser's EventSource
 * implementation.
 *
 * In development, Vite proxies /api/* to the Express server, so we use
 * relative URLs.  In production (or when VITE_API_URL is set), we use the
 * configured base URL.
 */

import {
  state,
  applyCardCreated,
  applyCardMoved,
  applyColumnRenormed,
} from './state.js';
import { reconcileColumn } from './board.js';

const BASE = import.meta.env.VITE_API_URL ?? '';

/**
 * Open the SSE connection and wire up event handlers.
 *
 * @param {HTMLElement} statusEl  – the .connection-status element in the header
 */
export function connectSSE(statusEl) {
  const labelEl = statusEl.querySelector('.status-label');

  function setStatus(status, label) {
    statusEl.className = `connection-status ${status}`;
    if (labelEl) labelEl.textContent = label;
  }

  setStatus('connecting', 'Connecting…');

  const es = new EventSource(`${BASE}/api/stream`);

  es.addEventListener('open', () => {
    setStatus('connected', 'Live');
  });

  es.addEventListener('error', () => {
    setStatus('disconnected', 'Reconnecting…');
  });

  es.addEventListener('message', (e) => {
    let envelope;
    try {
      envelope = JSON.parse(e.data);
    } catch {
      console.warn('[SSE] Failed to parse message:', e.data);
      return;
    }

    const { type, payload } = envelope;

    switch (type) {
      case 'connected':
        // Initial handshake – nothing to do.
        break;

      case 'card:created': {
        applyCardCreated(payload.card);
        reconcileColumn(payload.card.column_id);
        break;
      }

      case 'card:moved': {
        // Capture the source column BEFORE applying the state update.
        const prevColumnId = findCardColumnId(payload.card.id);
        applyCardMoved(payload.card);
        // Reconcile both the source and target columns.
        if (prevColumnId && prevColumnId !== payload.card.column_id) {
          reconcileColumn(prevColumnId);
        }
        reconcileColumn(payload.card.column_id);
        break;
      }

      case 'column:renormed': {
        applyColumnRenormed(payload.columnId, payload.cards);
        reconcileColumn(payload.columnId);
        break;
      }

      default:
        console.warn('[SSE] Unknown event type:', type);
    }
  });

  return es;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find which column a card currently lives in (before applying the new event).
 * Used to reconcile the source column after a cross-column move.
 *
 * @param {string} cardId
 * @returns {string|null}
 */
function findCardColumnId(cardId) {
  for (const col of state.columns) {
    if (col.cards.some((c) => c.id === cardId)) {
      return col.id;
    }
  }
  return null;
}
