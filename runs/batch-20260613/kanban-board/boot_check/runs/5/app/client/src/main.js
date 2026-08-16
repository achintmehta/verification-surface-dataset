/**
 * Kanban Board – main entry point.
 *
 * Orchestrates:
 *  - Initial board load
 *  - SSE real-time updates
 *  - Drag-and-drop with optimistic updates + server reconciliation
 *  - Card creation modal
 */

import { fetchBoard, createCard, moveCard } from './api.js';
import {
  initState,
  getColumns,
  getColumn,
  upsertCard,
  replaceColumnCards,
  optimisticMove,
} from './state.js';
import { initRenderer, renderBoard, renderColumnCards, renderUpsertCard } from './render.js';
import { connectSSE } from './sse.js';

/* ------------------------------------------------------------------ */
/*  DOM refs                                                            */
/* ------------------------------------------------------------------ */
const boardEl        = document.getElementById('board');
const statusEl       = document.getElementById('connection-status');
const modalOverlay   = document.getElementById('modal-overlay');
const cardTextInput  = document.getElementById('card-text-input');
const modalCancel    = document.getElementById('modal-cancel');
const modalSubmit    = document.getElementById('modal-submit');

/* ------------------------------------------------------------------ */
/*  Modal state                                                         */
/* ------------------------------------------------------------------ */
let activeColumnId = null;

function openModal(columnId) {
  activeColumnId = columnId;
  cardTextInput.value = '';
  modalOverlay.classList.remove('hidden');
  cardTextInput.focus();
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  activeColumnId = null;
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
  if (!text || !activeColumnId) return;

  modalSubmit.disabled = true;
  try {
    // Optimistic: add a temporary card immediately
    const tempId = `temp-${Date.now()}`;
    const col = getColumn(activeColumnId);
    const maxPos = col?.cards.length
      ? Math.max(...col.cards.map((c) => c.position))
      : 0;

    const tempCard = {
      id:         tempId,
      column_id:  activeColumnId,
      text,
      position:   maxPos + 1,
      created_at: new Date().toISOString(),
    };
    upsertCard(tempCard);
    renderColumnCards(activeColumnId, getColumn(activeColumnId).cards);
    closeModal();

    // Persist on server
    const canonical = await createCard(activeColumnId, text);

    // Replace temp card with canonical
    // Remove temp from state
    const colState = getColumn(activeColumnId);
    if (colState) colState.cards = colState.cards.filter((c) => c.id !== tempId);
    // Remove temp from DOM
    const tempEl = boardEl.querySelector(`[data-card-id="${tempId}"]`);
    if (tempEl) tempEl.remove();

    // Upsert canonical (SSE will also arrive but upsert is idempotent)
    upsertCard(canonical);
    renderColumnCards(canonical.column_id, getColumn(canonical.column_id).cards);
  } catch (err) {
    console.error('[submitCard]', err);
    alert(`Failed to create card: ${err.message}`);
    // Rollback optimistic card
    const col = getColumn(activeColumnId);
    if (col) {
      col.cards = col.cards.filter((c) => !c.id.startsWith('temp-'));
      renderColumnCards(activeColumnId, col.cards);
    }
  } finally {
    modalSubmit.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/*  Drag-and-drop handler                                               */
/* ------------------------------------------------------------------ */

/**
 * In-flight move requests keyed by cardId.
 * Prevents stacking multiple concurrent moves for the same card.
 */
const pendingMoves = new Map();

boardEl.addEventListener('card:drop', async (e) => {
  const { cardId, targetColumnId, beforeId, afterId } = e.detail;

  // Ignore if already moving this card
  if (pendingMoves.has(cardId)) return;

  // Optimistic update
  optimisticMove(cardId, targetColumnId, beforeId, afterId);
  const targetCol = getColumn(targetColumnId);
  if (targetCol) renderColumnCards(targetColumnId, targetCol.cards);

  // Also re-render source column if different
  // (the card was removed from it by optimisticMove → upsertCard)
  for (const col of getColumns()) {
    if (col.id !== targetColumnId) {
      renderColumnCards(col.id, col.cards);
    }
  }

  const movePromise = moveCard(cardId, targetColumnId, beforeId, afterId)
    .then((canonical) => {
      // Reconcile: replace optimistic with canonical
      upsertCard(canonical);
      renderColumnCards(canonical.column_id, getColumn(canonical.column_id).cards);
    })
    .catch((err) => {
      console.error('[card:drop] move failed, reloading board', err);
      // On error, reload authoritative state
      loadBoard();
    })
    .finally(() => {
      pendingMoves.delete(cardId);
    });

  pendingMoves.set(cardId, movePromise);
});

/* ------------------------------------------------------------------ */
/*  SSE event handlers                                                  */
/* ------------------------------------------------------------------ */

function handleSSECardCreated(card) {
  // Ignore if we already have this card (e.g. we created it ourselves)
  const col = getColumn(card.column_id);
  if (col?.cards.find((c) => c.id === card.id)) return;

  upsertCard(card);
  renderUpsertCard(card, getColumn(card.column_id).cards);
  // Update all column counts
  for (const c of getColumns()) {
    renderColumnCards(c.id, c.cards);
  }
}

function handleSSECardMoved(card) {
  // If we have a pending optimistic move for this card, the reconciliation
  // will happen when the HTTP response arrives.  But we still apply the
  // server's canonical state so other clients converge.
  upsertCard(card);

  // Re-render all columns (card may have moved between columns)
  for (const col of getColumns()) {
    renderColumnCards(col.id, col.cards);
  }
}

function handleSSEColumnReordered({ columnId, cards }) {
  replaceColumnCards(columnId, cards);
  renderColumnCards(columnId, getColumn(columnId).cards);
}

/* ------------------------------------------------------------------ */
/*  Initial load                                                        */
/* ------------------------------------------------------------------ */

async function loadBoard() {
  boardEl.innerHTML = `
    <div class="board-loading">
      <div class="spinner"></div>
      Loading board…
    </div>
  `;

  try {
    const boardData = await fetchBoard();
    initState(boardData);
    initRenderer(boardEl, openModal);
    renderBoard(getColumns());
  } catch (err) {
    console.error('[loadBoard]', err);
    boardEl.innerHTML = `
      <div class="board-loading" style="color:#de350b">
        Failed to load board: ${err.message}
        <button class="btn btn-secondary" onclick="location.reload()">Retry</button>
      </div>
    `;
  }
}

/* ------------------------------------------------------------------ */
/*  Bootstrap                                                           */
/* ------------------------------------------------------------------ */

(async () => {
  await loadBoard();

  // Connect SSE after initial render
  const sseTarget = boardEl;
  connectSSE(sseTarget, statusEl);

  sseTarget.addEventListener('sse:card:created',     (e) => handleSSECardCreated(e.detail));
  sseTarget.addEventListener('sse:card:moved',       (e) => handleSSECardMoved(e.detail));
  sseTarget.addEventListener('sse:column:reordered', (e) => handleSSEColumnReordered(e.detail));
})();
