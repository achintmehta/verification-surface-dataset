/**
 * Kanban Board – main entry point.
 *
 * Responsibilities:
 *  - Bootstrap: fetch board state, render, connect SSE.
 *  - Handle drag-and-drop drops: optimistic update + server PATCH.
 *  - Handle SSE events: reconcile state + DOM.
 *  - Handle card creation modal.
 */

import { fetchBoard, createCard, moveCard } from './api.js';
import {
  initState,
  upsertCard,
  replaceColumnCards,
  getAllColumns,
  getColumn,
} from './state.js';
import {
  renderBoard,
  reconcileColumn,
  reconcileAll,
  markCardOptimistic,
  clearCardOptimistic,
} from './render.js';
import { initDnD } from './dnd.js';

/* ------------------------------------------------------------------ */
/*  DOM refs                                                            */
/* ------------------------------------------------------------------ */
const boardEl         = document.getElementById('board');
const statusEl        = document.getElementById('connection-status');
const modalOverlay    = document.getElementById('modal-overlay');
const cardTextArea    = document.getElementById('card-text');
const modalSubmitBtn  = document.getElementById('modal-submit');
const modalCancelBtn  = document.getElementById('modal-cancel');

let pendingColumnId = null; // column for the open "add card" modal

/* ------------------------------------------------------------------ */
/*  Bootstrap                                                           */
/* ------------------------------------------------------------------ */
async function bootstrap() {
  boardEl.innerHTML = `
    <div class="board-loading">
      <div class="spinner"></div>
      Loading board…
    </div>
  `;

  try {
    const data = await fetchBoard();
    initState(data);
    renderBoard(boardEl, openAddCardModal);
    initDnD(boardEl);
    boardEl.addEventListener('card-drop', handleCardDrop);
    connectSSE();
  } catch (err) {
    boardEl.innerHTML = `<div class="board-loading" style="color:#de350b">
      Failed to load board: ${err.message}
    </div>`;
    console.error('[bootstrap]', err);
  }
}

/* ------------------------------------------------------------------ */
/*  SSE                                                                 */
/* ------------------------------------------------------------------ */
let sse = null;
let sseRetryTimeout = null;

function connectSSE() {
  if (sse) {
    sse.close();
  }

  sse = new EventSource('/api/stream');

  sse.addEventListener('open', () => {
    setStatus('connected');
    console.log('[sse] connected');
  });

  sse.addEventListener('error', () => {
    setStatus('disconnected');
    console.warn('[sse] connection error – retrying in 3 s');
    sse.close();
    clearTimeout(sseRetryTimeout);
    sseRetryTimeout = setTimeout(connectSSE, 3000);
  });

  /* card-created ---------------------------------------------------- */
  sse.addEventListener('card-created', (e) => {
    const { card } = JSON.parse(e.data);
    console.log('[sse] card-created', card.id);

    const prevCol = findCardColumn(card.id);

    upsertCard(card);

    // Reconcile affected columns
    if (prevCol && prevCol !== card.column_id) reconcileColumn(prevCol);
    reconcileColumn(card.column_id);

    clearCardOptimistic(card.id);
  });

  /* card-moved ------------------------------------------------------ */
  sse.addEventListener('card-moved', (e) => {
    const { card } = JSON.parse(e.data);
    console.log('[sse] card-moved', card.id, '→', card.column_id);

    const prevCol = findCardColumn(card.id);

    upsertCard(card);

    if (prevCol && prevCol !== card.column_id) reconcileColumn(prevCol);
    reconcileColumn(card.column_id);

    clearCardOptimistic(card.id);
  });

  /* column-reorder -------------------------------------------------- */
  sse.addEventListener('column-reorder', (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    console.log('[sse] column-reorder', columnId, `(${cards.length} cards)`);

    replaceColumnCards(columnId, cards);
    reconcileColumn(columnId);
  });
}

/* ------------------------------------------------------------------ */
/*  Drag-and-drop handler                                               */
/* ------------------------------------------------------------------ */
async function handleCardDrop(e) {
  const { cardId, sourceColumnId, targetColumnId, beforeId, afterId } = e.detail;

  console.log('[dnd] drop', { cardId, targetColumnId, beforeId, afterId });

  // --- Optimistic update ---
  // Build a fake card with an estimated position so the UI snaps immediately.
  const sourceCol = getColumn(sourceColumnId);
  const targetCol = getColumn(targetColumnId);
  if (!sourceCol || !targetCol) return;

  const card = findCardById(cardId);
  if (!card) return;

  // Compute optimistic position
  const beforeCard = beforeId ? findCardInColumn(targetColumnId, beforeId) : null;
  const afterCard  = afterId  ? findCardInColumn(targetColumnId, afterId)  : null;

  let optimisticPos;
  if (!beforeCard && !afterCard) {
    optimisticPos = 1000;
  } else if (!beforeCard) {
    optimisticPos = (afterCard.position) / 2;
  } else if (!afterCard) {
    optimisticPos = beforeCard.position + 1000;
  } else {
    optimisticPos = (beforeCard.position + afterCard.position) / 2;
  }

  const optimisticCard = { ...card, column_id: targetColumnId, position: optimisticPos };
  upsertCard(optimisticCard);

  if (sourceColumnId !== targetColumnId) reconcileColumn(sourceColumnId);
  reconcileColumn(targetColumnId);
  markCardOptimistic(cardId);

  // --- Server request ---
  try {
    const { card: canonical } = await moveCard(cardId, targetColumnId, beforeId, afterId);
    // The SSE broadcast will reconcile; but also apply immediately in case
    // this client's SSE event arrives late or is the same client.
    upsertCard(canonical);
    if (sourceColumnId !== targetColumnId) reconcileColumn(sourceColumnId);
    reconcileColumn(canonical.column_id);
    clearCardOptimistic(cardId);
  } catch (err) {
    console.error('[dnd] move failed – reverting', err);
    // Revert: put the card back where it was
    upsertCard(card);
    if (sourceColumnId !== targetColumnId) reconcileColumn(targetColumnId);
    reconcileColumn(sourceColumnId);
    clearCardOptimistic(cardId);
  }
}

/* ------------------------------------------------------------------ */
/*  Add card modal                                                      */
/* ------------------------------------------------------------------ */
function openAddCardModal(columnId) {
  pendingColumnId = columnId;
  cardTextArea.value = '';
  modalOverlay.classList.remove('hidden');
  cardTextArea.focus();
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  pendingColumnId = null;
}

modalCancelBtn.addEventListener('click', closeModal);

modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

cardTextArea.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitCard();
  }
  if (e.key === 'Escape') closeModal();
});

modalSubmitBtn.addEventListener('click', submitCard);

async function submitCard() {
  const text = cardTextArea.value.trim();
  if (!text || !pendingColumnId) return;

  const columnId = pendingColumnId;
  closeModal();

  try {
    // Optimistic: add a temporary card
    const tempId = `temp-${Date.now()}`;
    const col = getColumn(columnId);
    const maxPos = col.cards.length
      ? col.cards[col.cards.length - 1].position + 1000
      : 1000;

    const tempCard = {
      id:         tempId,
      column_id:  columnId,
      text,
      position:   maxPos,
      created_at: new Date().toISOString(),
    };
    upsertCard(tempCard);
    reconcileColumn(columnId);
    markCardOptimistic(tempId);

    const { card } = await createCard(columnId, text);

    // Replace temp card with real card
    const colState = getColumn(columnId);
    if (colState) {
      colState.cards = colState.cards.filter((c) => c.id !== tempId);
    }
    upsertCard(card);
    reconcileColumn(columnId);
    clearCardOptimistic(card.id);
  } catch (err) {
    console.error('[modal] createCard failed', err);
    // Remove temp card on failure
    const colState = getColumn(columnId);
    if (colState) {
      colState.cards = colState.cards.filter((c) => !c.id.startsWith('temp-'));
    }
    reconcileColumn(columnId);
  }
}

/* ------------------------------------------------------------------ */
/*  Utilities                                                           */
/* ------------------------------------------------------------------ */
function setStatus(state) {
  statusEl.className = `connection-status ${state}`;
  statusEl.title = state === 'connected' ? 'Connected' : 'Disconnected';
}

/** Find which column currently holds a card (by DOM or state). */
function findCardColumn(cardId) {
  for (const col of getAllColumns()) {
    if (col.cards.some((c) => c.id === cardId)) return col.id;
  }
  return null;
}

function findCardById(cardId) {
  for (const col of getAllColumns()) {
    const card = col.cards.find((c) => c.id === cardId);
    if (card) return card;
  }
  return null;
}

function findCardInColumn(columnId, cardId) {
  const col = getColumn(columnId);
  return col?.cards.find((c) => c.id === cardId) ?? null;
}

/* ------------------------------------------------------------------ */
/*  Start                                                               */
/* ------------------------------------------------------------------ */
bootstrap();
