/**
 * Kanban Board – main entry point.
 *
 * Responsibilities:
 *  1. Load initial board state from the server.
 *  2. Render the board.
 *  3. Connect to the SSE stream and apply incoming events.
 *  4. Handle card creation via modal.
 *  5. Handle drag-and-drop with optimistic updates + server reconciliation.
 */

import { fetchBoard, createCard, moveCard, openStream } from './api.js';
import { BoardState } from './state.js';
import { renderBoard, renderColumn } from './dom.js';
import {
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
} from './drag.js';

/* ── State ────────────────────────────────────────────────────────── */
const state = new BoardState();

/* ── DOM refs ─────────────────────────────────────────────────────── */
const statusEl = document.getElementById('connection-status');
const modalOverlay = document.getElementById('modal-overlay');
const cardTextInput = document.getElementById('card-text-input');
const modalCancel = document.getElementById('modal-cancel');
const modalSubmit = document.getElementById('modal-submit');

let pendingColumnId = null; // column for which the modal is open

/* ── Drag handlers (bound to state) ──────────────────────────────── */
const handlers = {
  onAddCard: openModal,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop: (e, listEl) => onDrop(e, listEl, handleMove),
};

/* ── Bootstrap ────────────────────────────────────────────────────── */
async function init() {
  try {
    const data = await fetchBoard();
    state.loadBoard(data);
    renderBoard(state, handlers);
  } catch (err) {
    console.error('[init] Failed to load board:', err);
    document.getElementById('board-loading').textContent =
      '⚠ Failed to load board. Please refresh.';
    return;
  }

  connectSSE();
}

/* ── SSE ──────────────────────────────────────────────────────────── */
function connectSSE() {
  const es = openStream();

  es.addEventListener('open', () => {
    setStatus('🟢 Connected');
  });

  es.addEventListener('error', () => {
    setStatus('🔴 Disconnected – reconnecting…');
  });

  /* card:created ---------------------------------------------------- */
  es.addEventListener('card:created', (e) => {
    const { card } = JSON.parse(e.data);
    state.applyCardCreated(card);
    renderColumn(card.column_id, state, handlers);
  });

  /* card:moved ------------------------------------------------------ */
  es.addEventListener('card:moved', (e) => {
    const { card } = JSON.parse(e.data);

    // Find which column currently renders this card so we can update it too
    const affectedColumns = new Set([card.column_id]);
    for (const col of state.getSortedColumns()) {
      if (col.cards.has(card.id)) affectedColumns.add(col.id);
    }

    state.applyCardMoved(card);

    for (const colId of affectedColumns) {
      renderColumn(colId, state, handlers);
    }
  });

  /* column:reordered ----------------------------------------------- */
  es.addEventListener('column:reordered', (e) => {
    const payload = JSON.parse(e.data);

    // Remove this card from all columns first (it may have moved)
    const affectedColumns = new Set([payload.columnId]);
    for (const card of payload.cards) {
      for (const col of state.getSortedColumns()) {
        if (col.cards.has(card.id)) affectedColumns.add(col.id);
      }
    }

    state.applyColumnReordered(payload);

    for (const colId of affectedColumns) {
      renderColumn(colId, state, handlers);
    }
  });
}

/* ── Card creation modal ──────────────────────────────────────────── */
function openModal(columnId) {
  pendingColumnId = columnId;
  cardTextInput.value = '';
  modalOverlay.hidden = false;
  cardTextInput.focus();
}

function closeModal() {
  modalOverlay.hidden = true;
  pendingColumnId = null;
}

modalCancel.addEventListener('click', closeModal);

modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

cardTextInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitCard();
  if (e.key === 'Escape') closeModal();
});

modalSubmit.addEventListener('click', submitCard);

async function submitCard() {
  const text = cardTextInput.value.trim();
  if (!text || !pendingColumnId) return;

  const columnId = pendingColumnId;
  closeModal();

  // Optimistic: add a temporary card to the DOM
  const tempId = `temp-${Date.now()}`;
  const tempCard = {
    id: tempId,
    column_id: columnId,
    text,
    position: Date.now(), // large number, will be replaced
    created_at: new Date().toISOString(),
  };
  state.applyCardCreated(tempCard);
  renderColumn(columnId, state, handlers);

  // Mark as optimistic
  const tempEl = document.querySelector(`.card[data-card-id="${tempId}"]`);
  if (tempEl) tempEl.classList.add('optimistic');

  try {
    await createCard(columnId, text);
    // The SSE card:created event will arrive and replace the temp card
    // with the canonical one. Remove the temp card from state now.
    const col = state.columns.get(columnId);
    if (col) col.cards.delete(tempId);
    // The SSE handler will re-render; but if SSE is slow, clean up the temp el
    if (tempEl && tempEl.parentNode) tempEl.remove();
  } catch (err) {
    console.error('[createCard]', err);
    // Roll back optimistic card
    const col = state.columns.get(columnId);
    if (col) col.cards.delete(tempId);
    renderColumn(columnId, state, handlers);
    alert(`Failed to create card: ${err.message}`);
  }
}

/* ── Card move ────────────────────────────────────────────────────── */
async function handleMove(cardId, targetColumnId, beforeId, afterId) {
  // Don't move a temp card
  if (cardId.startsWith('temp-')) return;

  // Find source column
  let sourceColumnId = null;
  for (const col of state.getSortedColumns()) {
    if (col.cards.has(cardId)) {
      sourceColumnId = col.id;
      break;
    }
  }

  // Optimistic update: move the card in local state
  const card = sourceColumnId ? state.columns.get(sourceColumnId)?.cards.get(cardId) : null;
  if (card) {
    // Compute an optimistic position
    const targetCards = state.getSortedCards(targetColumnId).filter((c) => c.id !== cardId);
    const beforeCard = beforeId ? targetCards.find((c) => c.id === beforeId) : null;
    const afterCard = afterId ? targetCards.find((c) => c.id === afterId) : null;

    const beforePos = beforeCard ? beforeCard.position : null;
    const afterPos = afterCard ? afterCard.position : null;

    let optimisticPos;
    if (beforePos === null && afterPos === null) optimisticPos = 1000;
    else if (beforePos === null) optimisticPos = afterPos - 1000;
    else if (afterPos === null) optimisticPos = beforePos + 1000;
    else optimisticPos = (beforePos + afterPos) / 2;

    const optimisticCard = { ...card, column_id: targetColumnId, position: optimisticPos };
    state.applyCardMoved(optimisticCard);

    // Re-render affected columns
    const affectedCols = new Set([targetColumnId]);
    if (sourceColumnId) affectedCols.add(sourceColumnId);
    for (const colId of affectedCols) renderColumn(colId, state, handlers);
  }

  try {
    const { card: canonical } = await moveCard(cardId, targetColumnId, beforeId, afterId);
    // The SSE event will reconcile; but apply immediately for this client
    // to avoid a flicker if SSE is slightly delayed.
    const affectedCols = new Set([canonical.column_id]);
    if (sourceColumnId) affectedCols.add(sourceColumnId);
    state.applyCardMoved(canonical);
    for (const colId of affectedCols) renderColumn(colId, state, handlers);
  } catch (err) {
    console.error('[moveCard]', err);
    // Roll back: reload board from server
    try {
      const data = await fetchBoard();
      state.loadBoard(data);
      renderBoard(state, handlers);
    } catch {
      // ignore secondary error
    }
  }
}

/* ── Helpers ──────────────────────────────────────────────────────── */
function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

/* ── Start ────────────────────────────────────────────────────────── */
init();
