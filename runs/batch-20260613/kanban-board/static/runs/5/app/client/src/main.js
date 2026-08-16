/**
 * Kanban Board – main entry point.
 *
 * Wires together:
 *   - Initial board load (GET /api/board)
 *   - Board rendering
 *   - Drag-and-drop (optimistic moves + server reconciliation)
 *   - Card creation modal
 *   - SSE real-time updates
 */

import { fetchBoard, createCard, moveCard } from './api.js';
import { state, initState, optimisticMove } from './state.js';
import { renderBoard, reconcileColumn, reconcileAllColumns } from './board.js';
import { initDragDrop } from './dragdrop.js';
import { connectSSE } from './sse.js';

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const boardEl = /** @type {HTMLElement} */ (document.getElementById('board'));
const boardLoadingEl = document.getElementById('board-loading');
const statusEl = /** @type {HTMLElement} */ (
  document.getElementById('connection-status')
);

// Modal elements
const modalEl = /** @type {HTMLDialogElement} */ (
  document.getElementById('card-modal')
);
const cardFormEl = /** @type {HTMLFormElement} */ (
  document.getElementById('card-form')
);
const cardTextEl = /** @type {HTMLTextAreaElement} */ (
  document.getElementById('card-text')
);
const modalCancelEl = document.getElementById('modal-cancel');

// ---------------------------------------------------------------------------
// Boot sequence
// ---------------------------------------------------------------------------

async function boot() {
  // 1. Connect SSE first so we don't miss events that arrive while loading.
  connectSSE(statusEl);

  // 2. Load the initial board state.
  try {
    const board = await fetchBoard();
    initState(board);
  } catch (err) {
    console.error('[boot] Failed to load board:', err);
    if (boardLoadingEl) {
      boardLoadingEl.textContent = 'Failed to load board. Please refresh.';
    }
    return;
  }

  // 3. Render the board.
  renderBoard(boardEl, openAddCardModal);

  // 4. Attach drag-and-drop.
  initDragDrop(boardEl, handleDrop);

  // 5. Wire up the add-card modal.
  initModal();
}

// ---------------------------------------------------------------------------
// Drag-and-drop handler
// ---------------------------------------------------------------------------

/**
 * Called by the drag-and-drop module when a card is dropped.
 *
 * @param {string}      cardId
 * @param {string}      targetColumnId
 * @param {string|null} beforeId
 * @param {string|null} afterId
 */
async function handleDrop(cardId, targetColumnId, beforeId, afterId) {
  // Find the card's current column before the optimistic update.
  let sourceColumnId = null;
  for (const col of state.columns) {
    if (col.cards.some((c) => c.id === cardId)) {
      sourceColumnId = col.id;
      break;
    }
  }

  // Apply optimistic update immediately.
  optimisticMove(cardId, targetColumnId, beforeId, afterId);

  // Re-render affected columns.
  if (sourceColumnId && sourceColumnId !== targetColumnId) {
    reconcileColumn(sourceColumnId);
  }
  reconcileColumn(targetColumnId);

  // Send the move to the server.
  try {
    await moveCard(cardId, targetColumnId, beforeId, afterId);
    // The server will broadcast a card:moved event which will reconcile the
    // canonical state.  We don't need to do anything extra here.
  } catch (err) {
    console.error('[handleDrop] Move failed:', err);
    // On failure, reload the board to restore a consistent state.
    await reloadBoard();
  }
}

// ---------------------------------------------------------------------------
// Card creation modal
// ---------------------------------------------------------------------------

/** The column id that the modal is currently targeting. */
let _pendingColumnId = null;

function openAddCardModal(columnId) {
  _pendingColumnId = columnId;
  cardTextEl.value = '';
  modalEl.showModal();
  // Focus the textarea after the dialog opens.
  requestAnimationFrame(() => cardTextEl.focus());
}

function initModal() {
  // Cancel button closes the dialog without submitting.
  modalCancelEl?.addEventListener('click', () => {
    modalEl.close();
  });

  // Close on backdrop click.
  modalEl.addEventListener('click', (e) => {
    if (e.target === modalEl) modalEl.close();
  });

  // Form submission.
  cardFormEl.addEventListener('submit', async (e) => {
    e.preventDefault();

    const text = cardTextEl.value.trim();
    if (!text || !_pendingColumnId) return;

    modalEl.close();

    try {
      await createCard(_pendingColumnId, text);
      // The server broadcasts card:created which updates the DOM via SSE.
    } catch (err) {
      console.error('[createCard] Failed:', err);
      alert(`Failed to create card: ${err.message}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Board reload (error recovery)
// ---------------------------------------------------------------------------

async function reloadBoard() {
  try {
    const board = await fetchBoard();
    initState(board);
    reconcileAllColumns();
  } catch (err) {
    console.error('[reloadBoard] Failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

boot();
