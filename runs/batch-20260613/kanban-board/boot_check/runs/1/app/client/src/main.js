/**
 * Kanban Board – main entry point.
 *
 * Responsibilities:
 *  1. Load initial board state from the server.
 *  2. Render the board.
 *  3. Wire up drag-and-drop.
 *  4. Wire up the "add card" form.
 *  5. Connect to SSE and reconcile incoming events.
 */

import { fetchBoard, createCard, moveCard } from './api.js';
import {
  initState, upsertCard, replaceColumnCards,
  getColumnById, optimisticMove,
} from './state.js';
import {
  renderBoard, buildCard, reconcileCard, reconcileColumn,
  updateColumnCount, clearDropIndicators, showDropIndicator,
} from './board.js';
import { connectSSE } from './sse.js';

const boardEl = document.getElementById('board');

/* ─────────────────────────────────────────────────────────────
   Drag state
───────────────────────────────────────────────────────────── */
let draggingCardId   = null;
let dropTarget       = { afterId: null, beforeId: null, columnId: null };

/* ─────────────────────────────────────────────────────────────
   Drag handlers
───────────────────────────────────────────────────────────── */
function handleDragStart(e, cardId) {
  draggingCardId = cardId;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', cardId);

  // Mark the card as dragging after a tick so the ghost image is clean
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-card-id="${cardId}"]`);
    if (el) el.classList.add('dragging');
  });
}

function handleDragOver(e, columnId) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  const listEl = document.querySelector(`.card-list[data-column-id="${columnId}"]`);
  if (!listEl) return;

  const { afterId, beforeId } = showDropIndicator(listEl, e.clientY);
  dropTarget = { afterId, beforeId, columnId };
}

function handleDrop(e, columnId) {
  e.preventDefault();
  clearDropIndicators();

  const cardId = draggingCardId ?? e.dataTransfer.getData('text/plain');
  if (!cardId) return;

  const { afterId, beforeId } = dropTarget;

  // Optimistic update
  optimisticMove(cardId, columnId, afterId, beforeId);

  // Re-render affected columns
  const card = document.querySelector(`[data-card-id="${cardId}"]`);
  const sourceColumnId = card?.dataset.columnId;

  reconcileColumn(columnId, handleDragStart, handleDragEnd);
  if (sourceColumnId && sourceColumnId !== columnId) {
    reconcileColumn(sourceColumnId, handleDragStart, handleDragEnd);
  }

  // Send to server
  moveCard(cardId, { columnId, beforeId, afterId })
    .then(serverCard => {
      // Server is authoritative – reconcile
      upsertCard(serverCard);
      reconcileCard(serverCard, handleDragStart, handleDragEnd);

      // Also update the source column count if it changed
      if (sourceColumnId && sourceColumnId !== serverCard.column_id) {
        updateColumnCount(sourceColumnId);
      }
    })
    .catch(err => {
      console.error('[move] server error', err);
      // On error, reload the board to get back to a consistent state
      loadBoard();
    });

  draggingCardId = null;
  dropTarget = { afterId: null, beforeId: null, columnId: null };
}

function handleDragEnd(_e) {
  clearDropIndicators();
  document.querySelectorAll('.card.dragging').forEach(el => el.classList.remove('dragging'));
  draggingCardId = null;
}

/* ─────────────────────────────────────────────────────────────
   Add card
───────────────────────────────────────────────────────────── */
async function handleAddCard(columnId, text) {
  try {
    // Optimistic: add a temporary card element
    const tempId = `temp-${Date.now()}`;
    const listEl = document.querySelector(`.card-list[data-column-id="${columnId}"]`);
    if (listEl) {
      const tempEl = document.createElement('div');
      tempEl.className = 'card optimistic';
      tempEl.dataset.cardId = tempId;
      tempEl.textContent = text;
      listEl.appendChild(tempEl);
    }

    const card = await createCard(columnId, text);

    // Remove temp element
    document.querySelector(`[data-card-id="${tempId}"]`)?.remove();

    // State + DOM update handled by SSE event (card:created broadcast)
    // But if SSE is slow, also handle it here to avoid duplication
    // The SSE handler is idempotent (upsertCard + reconcileCard)
  } catch (err) {
    console.error('[addCard] error', err);
    // Remove any temp element
    document.querySelectorAll('.card.optimistic').forEach(el => el.remove());
  }
}

/* ─────────────────────────────────────────────────────────────
   SSE event handlers
───────────────────────────────────────────────────────────── */
function onCardCreated(card) {
  // Remove any optimistic temp card for this column (we can't match by id,
  // but the server card will be inserted at the right position)
  upsertCard(card);
  reconcileCard(card, handleDragStart, handleDragEnd);
}

function onCardMoved(card) {
  // Find the card's current column in the DOM before state update
  const existingEl = document.querySelector(`[data-card-id="${card.id}"]`);
  const prevColumnId = existingEl?.dataset.columnId;

  upsertCard(card);
  reconcileCard(card, handleDragStart, handleDragEnd);

  // Update source column count if card moved columns
  if (prevColumnId && prevColumnId !== card.column_id) {
    updateColumnCount(prevColumnId);
  }
}

function onColumnReordered({ columnId, cards }) {
  replaceColumnCards(columnId, cards);
  reconcileColumn(columnId, handleDragStart, handleDragEnd);
}

/* ─────────────────────────────────────────────────────────────
   Initial load
───────────────────────────────────────────────────────────── */
async function loadBoard() {
  boardEl.innerHTML = '<div class="board-loading"><div class="spinner"></div> Loading board…</div>';

  try {
    const boardData = await fetchBoard();
    initState(boardData);
    renderBoard(handleAddCard, handleDragStart, handleDragOver, handleDrop, handleDragEnd);
  } catch (err) {
    console.error('[loadBoard]', err);
    boardEl.innerHTML = `<div class="board-loading">Failed to load board: ${err.message}</div>`;
  }
}

/* ─────────────────────────────────────────────────────────────
   Bootstrap
───────────────────────────────────────────────────────────── */
(async () => {
  await loadBoard();

  connectSSE({
    onCardCreated,
    onCardMoved,
    onColumnReordered,
  });
})();
