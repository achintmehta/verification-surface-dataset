/**
 * Kanban Board – main entry point.
 *
 * Wires together:
 *  - Initial board load (GET /api/board)
 *  - DOM rendering (board.js)
 *  - Drag-and-drop (drag.js)
 *  - SSE real-time updates (sse.js)
 *  - Card creation modal
 *  - Optimistic updates + server reconciliation (state.js)
 */

import { fetchBoard, createCard, moveCard } from './api.js';
import {
  setState,
  findColumn,
  findCard,
  applyCardCreated,
  applyCardMoved,
  applyColumnReordered,
  optimisticMove,
  rollbackState,
} from './state.js';
import {
  renderBoard,
  renderColumnCards,
} from './board.js';
import { initDragAndDrop } from './drag.js';
import { connectSSE } from './sse.js';

/* ------------------------------------------------------------------ */
/*  Bootstrap                                                           */
/* ------------------------------------------------------------------ */

async function init() {
  // 1. Load initial board state
  try {
    const data = await fetchBoard();
    setState(data);
  } catch (err) {
    console.error('Failed to load board:', err);
    document.getElementById('board-loading').textContent =
      'Failed to load board. Please refresh.';
    return;
  }

  // 2. Render the board
  renderBoard();

  // 3. Wire up drag-and-drop
  initDragAndDrop(document.getElementById('board'), handleDrop);

  // 4. Wire up SSE
  connectSSE(
    {
      'card:created':      handleSSECardCreated,
      'card:moved':        handleSSECardMoved,
      'column:reordered':  handleSSEColumnReordered,
    },
    handleSSEStatus
  );

  // 5. Wire up card-creation modal
  initCardModal();
}

/* ------------------------------------------------------------------ */
/*  Drag-and-drop handler                                               */
/* ------------------------------------------------------------------ */

async function handleDrop(cardId, columnId, beforeId, afterId) {
  // Validate: if nothing changed, skip
  const found = findCard(cardId);
  if (!found) return;

  const { card, column: srcCol } = found;

  // Check if this is a no-op (same position in same column)
  if (
    card.column_id === columnId &&
    isNoOpMove(card, columnId, beforeId, afterId)
  ) {
    return;
  }

  // Optimistic update
  const snapshot = optimisticMove(cardId, columnId, beforeId, afterId);

  // Re-render affected columns
  const affectedCols = new Set([srcCol.id, columnId]);
  for (const colId of affectedCols) {
    renderColumnCards(colId);
  }

  // Send to server
  try {
    await moveCard(cardId, columnId, beforeId, afterId);
    // Server will broadcast card:moved which will reconcile the final state
  } catch (err) {
    console.error('Move failed, rolling back:', err);
    rollbackState(snapshot);
    for (const colId of affectedCols) {
      renderColumnCards(colId);
    }
  }
}

/**
 * Returns true if the move would leave the card in the same logical position.
 */
function isNoOpMove(card, columnId, beforeId, afterId) {
  if (card.column_id !== columnId) return false;

  const col = findColumn(columnId);
  if (!col) return false;

  const cards = col.cards;
  const idx   = cards.findIndex(c => c.id === card.id);

  const prevId = idx > 0 ? cards[idx - 1].id : null;
  const nextId = idx < cards.length - 1 ? cards[idx + 1].id : null;

  return prevId === beforeId && nextId === afterId;
}

/* ------------------------------------------------------------------ */
/*  SSE event handlers                                                  */
/* ------------------------------------------------------------------ */

function handleSSECardCreated({ card }) {
  // Check if we already have this card (created by this client optimistically)
  const existing = findCard(card.id);

  applyCardCreated(card);

  if (existing) {
    // Reconcile: update position if it differs
    renderColumnCards(card.column_id);
  } else {
    // New card from another client – add it to the DOM
    renderColumnCards(card.column_id);
  }
}

function handleSSECardMoved({ card }) {
  // Find where the card currently lives in our state
  const existing = findCard(card.id);
  const prevColId = existing?.column.id;

  applyCardMoved(card);

  // Re-render source column (if different from target)
  if (prevColId && prevColId !== card.column_id) {
    renderColumnCards(prevColId);
  }

  // Re-render target column
  renderColumnCards(card.column_id);
}

function handleSSEColumnReordered({ columnId, cards }) {
  applyColumnReordered(columnId, cards);
  renderColumnCards(columnId);
}

function handleSSEStatus(status) {
  const el = document.getElementById('connection-status');
  if (!el) return;
  el.className = `connection-status ${status}`;
  el.title = status === 'connected' ? 'Connected' : 'Disconnected – reconnecting…';
}

/* ------------------------------------------------------------------ */
/*  Card creation modal                                                 */
/* ------------------------------------------------------------------ */

let pendingColumnId = null;

function initCardModal() {
  const modal      = document.getElementById('card-modal');
  const form       = document.getElementById('card-form');
  const textarea   = document.getElementById('card-text');
  const cancelBtn  = document.getElementById('modal-cancel');

  // Open modal when "Add card" is clicked (event delegation)
  document.getElementById('board').addEventListener('click', (e) => {
    const btn = e.target.closest('.add-card-btn');
    if (!btn) return;
    pendingColumnId = btn.dataset.columnId;
    textarea.value = '';
    modal.showModal();
    textarea.focus();
  });

  // Submit
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textarea.value.trim();
    if (!text || !pendingColumnId) return;

    modal.close();

    try {
      const { card } = await createCard(pendingColumnId, text);
      // The SSE broadcast will handle the DOM update for all clients
      // including this one.  But if SSE is slow, apply optimistically:
      applyCardCreated(card);
      renderColumnCards(card.column_id);
    } catch (err) {
      console.error('Failed to create card:', err);
      alert(`Failed to create card: ${err.message}`);
    }

    pendingColumnId = null;
  });

  // Cancel
  cancelBtn.addEventListener('click', () => {
    modal.close();
    pendingColumnId = null;
  });

  // Close on backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.close();
      pendingColumnId = null;
    }
  });
}

/* ------------------------------------------------------------------ */
/*  Start                                                               */
/* ------------------------------------------------------------------ */

init();
