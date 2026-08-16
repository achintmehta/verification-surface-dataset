/**
 * Main entry point for the Kanban board SPA.
 *
 * Responsibilities:
 *  1. Fetch initial board state and render it.
 *  2. Wire up the card-creation modal.
 *  3. Initialise drag-and-drop and handle card:drop events.
 *  4. Connect to the SSE stream and reconcile incoming events.
 */

import { fetchBoard, createCard, moveCard } from './api.js';
import {
  setBoard,
  upsertCard,
  applyRenorm,
  optimisticMove,
  rollbackMove,
  getColumns,
} from './state.js';
import { renderBoard, reconcileColumn } from './render.js';
import { initDragDrop, getDraggingCardId } from './dragdrop.js';
import { connectSSE } from './sse.js';

const boardEl = /** @type {HTMLElement} */ (document.getElementById('board'));
const modalOverlay = /** @type {HTMLElement} */ (document.getElementById('modal-overlay'));
const cardForm = /** @type {HTMLFormElement} */ (document.getElementById('card-form'));
const cardTextEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('card-text'));
const cardColumnIdEl = /** @type {HTMLInputElement} */ (document.getElementById('card-column-id'));
const modalCancelBtn = document.getElementById('modal-cancel');

/* ------------------------------------------------------------------ */
/* 1. Initial load                                                      */
/* ------------------------------------------------------------------ */

async function init() {
  try {
    const { columns } = await fetchBoard();
    setBoard(columns);
    renderBoard();
  } catch (err) {
    console.error('Failed to load board:', err);
    const loadingEl = document.getElementById('board-loading');
    if (loadingEl) loadingEl.textContent = 'Failed to load board. Please refresh.';
    return;
  }

  // 2. Drag-and-drop
  initDragDrop();
  boardEl.addEventListener('card:drop', handleCardDrop);

  // 3. Modal / card creation
  boardEl.addEventListener('click', handleBoardClick);
  cardForm.addEventListener('submit', handleCardFormSubmit);
  modalCancelBtn?.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  // 4. SSE
  connectSSE({
    onCardCreated: handleSSECardCreated,
    onCardMoved: handleSSECardMoved,
    onColumnRenormalized: handleSSEColumnRenormalized,
  });
}

/* ------------------------------------------------------------------ */
/* 2. Card creation modal                                               */
/* ------------------------------------------------------------------ */

function handleBoardClick(e) {
  const btn = e.target.closest('.add-card-btn');
  if (!btn) return;
  openModal(btn.dataset.columnId);
}

function openModal(columnId) {
  cardColumnIdEl.value = columnId;
  cardTextEl.value = '';
  modalOverlay.hidden = false;
  cardTextEl.focus();
}

function closeModal() {
  modalOverlay.hidden = true;
  cardTextEl.value = '';
}

async function handleCardFormSubmit(e) {
  e.preventDefault();

  const columnId = cardColumnIdEl.value;
  const text = cardTextEl.value.trim();
  if (!text) return;

  const submitBtn = cardForm.querySelector('[type="submit"]');
  submitBtn.disabled = true;

  try {
    closeModal();
    // Optimistic: the SSE broadcast will reconcile the real card
    await createCard(columnId, text);
    // The SSE card:created event will update the board for all clients
    // including this one, so we don't need to update state here.
  } catch (err) {
    console.error('Failed to create card:', err);
    alert(`Could not create card: ${err.message}`);
  } finally {
    submitBtn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* 3. Drag-and-drop                                                     */
/* ------------------------------------------------------------------ */

async function handleCardDrop(e) {
  const { cardId, targetColumnId, afterId, beforeId } = e.detail;

  // Determine source column before optimistic update
  const columns = getColumns();
  let sourceColumnId = null;
  for (const col of columns) {
    if (col.cards.some((c) => c.id === cardId)) {
      sourceColumnId = col.id;
      break;
    }
  }

  // Optimistic update
  const snapshot = optimisticMove(cardId, targetColumnId, afterId, beforeId);

  // Reconcile affected columns in the DOM
  const affectedCols = new Set([sourceColumnId, targetColumnId].filter(Boolean));
  for (const colId of affectedCols) {
    reconcileColumn(colId, cardId);
  }

  try {
    await moveCard(cardId, targetColumnId, afterId, beforeId);
    // The SSE card:moved event will apply the canonical state for all clients.
    // For this client the SSE event will reconcile any difference between
    // the optimistic position and the server's canonical position.
  } catch (err) {
    console.error('Failed to move card:', err);
    // Roll back optimistic update
    if (snapshot) {
      rollbackMove(cardId, snapshot.prevColumnId, snapshot.prevPosition);
      for (const colId of affectedCols) {
        reconcileColumn(colId, null);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 4. SSE event handlers                                               */
/* ------------------------------------------------------------------ */

function handleSSECardCreated({ card }) {
  if (!card) return;

  // Upsert into state (handles duplicates gracefully)
  upsertCard(card);

  // Reconcile the target column
  reconcileColumn(card.column_id, getDraggingCardId());
}

function handleSSECardMoved({ card }) {
  if (!card) return;

  // Find the card's current column in state (before applying the server update)
  const columns = getColumns();
  let prevColumnId = null;
  for (const col of columns) {
    if (col.cards.some((c) => c.id === card.id)) {
      prevColumnId = col.id;
      break;
    }
  }

  // Apply canonical state
  upsertCard(card);

  // Reconcile affected columns
  const affectedCols = new Set([prevColumnId, card.column_id].filter(Boolean));
  for (const colId of affectedCols) {
    reconcileColumn(colId, getDraggingCardId());
  }
}

function handleSSEColumnRenormalized({ columnId, positions }) {
  if (!columnId || !positions) return;

  applyRenorm(columnId, positions);
  reconcileColumn(columnId, getDraggingCardId());
}

/* ------------------------------------------------------------------ */
/* Boot                                                                 */
/* ------------------------------------------------------------------ */

init();
