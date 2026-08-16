/**
 * main.js – Application bootstrap.
 *
 * Responsibilities:
 *  1. Fetch initial board state and render it.
 *  2. Open the SSE stream and handle incoming events.
 *  3. Handle user actions (add card, move card) with optimistic updates.
 *  4. Reconcile optimistic state against canonical server state.
 */

import { fetchBoard, createCard, moveCard } from './api.js';
import { state, setBoard, upsertCard, applyReorder, optimisticMove, rollbackMove } from './state.js';
import { renderBoard, upsertCardEl, reorderColumnEl, setCallbacks } from './board.js';
import { on, connect } from './sse.js';

// ---------------------------------------------------------------------------
// Connection status indicator
// ---------------------------------------------------------------------------
const statusEl = document.getElementById('connection-status');

function setStatus(status) {
  statusEl.className = `connection-status ${status}`;
  const labels = {
    connecting:   'Connecting…',
    connected:    'Connected',
    disconnected: 'Disconnected – reconnecting…',
  };
  statusEl.title = labels[status] ?? status;
}

// ---------------------------------------------------------------------------
// SSE event handlers
// ---------------------------------------------------------------------------

/**
 * card:created – a new card was created by any client.
 * We upsert it into state and the DOM.  If this client created it we already
 * have it (from the POST response), so upsertCard is idempotent.
 */
on('card:created', ({ card }) => {
  upsertCard(card);
  upsertCardEl(card, false);
});

/**
 * card:moved – a card was moved by any client.
 *
 * Strategy:
 *  - Always apply the canonical server state.
 *  - If the card being reconciled is the one we just moved optimistically,
 *    the server's position may differ from our guess → snap to server order.
 *  - Flash the card to signal reconciliation only when the position changed.
 */
on('card:moved', ({ card }) => {
  // Check whether our optimistic state already matches.
  let flash = false;
  for (const col of state.columns) {
    const existing = col.cards.find(c => c.id === card.id);
    if (existing) {
      flash = existing.column_id !== card.column_id ||
              Math.abs(existing.position - card.position) > 1e-9;
      break;
    }
  }

  upsertCard(card);
  upsertCardEl(card, flash);
});

/**
 * board:reorder – the server renormalised one or more columns.
 * Replace the affected columns' card arrays and re-render them.
 */
on('board:reorder', ({ columns }) => {
  applyReorder(columns);
  for (const { columnId } of columns) {
    reorderColumnEl(columnId);
  }
});

// ---------------------------------------------------------------------------
// User action handlers (passed to board.js via setCallbacks)
// ---------------------------------------------------------------------------

/**
 * Handle "add card" form submission.
 * We let the server create the card and rely on the SSE broadcast to render
 * it (which is idempotent with the POST response).
 */
async function onAddCard(columnId, text) {
  const { card } = await createCard(columnId, text);
  // Eagerly add to state + DOM so the creating client doesn't wait for SSE.
  upsertCard(card);
  upsertCardEl(card, false);
}

/**
 * Handle a drag-and-drop move intent.
 *
 * 1. Apply an optimistic update immediately.
 * 2. Send the PATCH request.
 * 3. On success: the SSE broadcast will reconcile (idempotent if positions match).
 * 4. On failure: roll back the optimistic update and re-render.
 */
async function onMoveCard({ cardId, columnId, beforeId, afterId }) {
  // 1. Optimistic update.
  const prev = optimisticMove(cardId, columnId, beforeId, afterId);

  // Re-render the affected columns immediately.
  const affectedColumns = new Set([columnId]);
  if (prev?.prevColumnId && prev.prevColumnId !== columnId) {
    affectedColumns.add(prev.prevColumnId);
  }
  for (const colId of affectedColumns) {
    reorderColumnEl(colId);
  }

  // 2. Send to server.
  try {
    const { card } = await moveCard(cardId, columnId, beforeId, afterId);
    // 3. Apply canonical state (may differ from optimistic guess).
    upsertCard(card);
    upsertCardEl(card, false);
  } catch (err) {
    console.error('[move] failed, rolling back:', err);
    // 4. Roll back.
    if (prev) {
      rollbackMove(cardId, prev.prevColumnId, prev.prevPosition);
      for (const colId of affectedColumns) {
        reorderColumnEl(colId);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

setCallbacks({ onAddCard, onMoveCard });

// Register SSE handlers before connecting so we don't miss events.
// (Handlers are registered above via `on()`.)

// Connect to SSE stream.
connect(setStatus);

// Fetch initial board state and render.
(async () => {
  try {
    const board = await fetchBoard();
    setBoard(board);
    renderBoard();
  } catch (err) {
    console.error('[boot] failed to load board:', err);
    const loadingEl = document.getElementById('board-loading');
    if (loadingEl) {
      loadingEl.textContent = 'Failed to load board. Please refresh.';
      loadingEl.style.color = '#de350b';
    }
  }
})();
