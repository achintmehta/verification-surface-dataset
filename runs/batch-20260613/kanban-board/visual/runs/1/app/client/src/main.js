import { fetchBoard, createCard, moveCard, openEventStream } from './api.js';
import {
  setBoard,
  upsertCard,
  replaceColumnCards,
  optimisticMove,
  rollbackMove,
  getColumns,
} from './state.js';
import { renderBoard, renderColumnCards, renderCardUpdate, boardEl } from './render.js';
import { initDragAndDrop } from './drag.js';

// ─── Connection badge ─────────────────────────────────────────────────────────
const badge = document.getElementById('connection-badge');
const badgeLabel = badge.querySelector('.badge-label');

function setConnected() {
  badge.className = 'connection-badge connected';
  badgeLabel.textContent = 'Live';
}
function setConnecting() {
  badge.className = 'connection-badge';
  badgeLabel.textContent = 'Connecting…';
}
function setError() {
  badge.className = 'connection-badge error';
  badgeLabel.textContent = 'Disconnected';
}

// ─── Toast ────────────────────────────────────────────────────────────────────
let toastContainer = null;

function toast(msg, duration = 3000) {
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  }
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ─── Modal ────────────────────────────────────────────────────────────────────
const modalOverlay = document.getElementById('modal-overlay');
const cardTextInput = document.getElementById('card-text-input');
const modalCancel = document.getElementById('modal-cancel');
const modalSubmit = document.getElementById('modal-submit');

let pendingColumnId = null;

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
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitCard();
  }
  if (e.key === 'Escape') closeModal();
});
modalSubmit.addEventListener('click', submitCard);

async function submitCard() {
  const text = cardTextInput.value.trim();
  if (!text || !pendingColumnId) return;

  closeModal();

  try {
    await createCard(pendingColumnId, text);
    // SSE will deliver the card:created event → no need to update state here
  } catch (err) {
    console.error('[createCard]', err);
    toast('Failed to create card. Please try again.');
  }
}

// ─── Board click delegation ───────────────────────────────────────────────────
boardEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-add-col]');
  if (btn) openModal(btn.dataset.addCol);
});

// ─── Drag-and-drop ────────────────────────────────────────────────────────────
initDragAndDrop(boardEl);

boardEl.addEventListener('card-drop', async (e) => {
  const { cardId, targetColumnId, afterId, beforeId } = e.detail;

  // Find the card's current column before the optimistic move
  let previousColumnId = null;
  for (const col of getColumns()) {
    if (col.cards.some((c) => c.id === cardId)) {
      previousColumnId = col.id;
      break;
    }
  }

  // Optimistic update
  const snapshot = optimisticMove(cardId, targetColumnId, afterId, beforeId);

  // Re-render affected columns
  const affectedCols = new Set([targetColumnId]);
  if (previousColumnId) affectedCols.add(previousColumnId);
  for (const colId of affectedCols) renderColumnCards(colId);

  try {
    const canonical = await moveCard(cardId, targetColumnId, afterId, beforeId);
    // Reconcile: apply the server's authoritative position
    upsertCard(canonical);
    renderCardUpdate(canonical, previousColumnId);
  } catch (err) {
    console.error('[moveCard]', err);
    // Roll back optimistic update
    rollbackMove(snapshot);
    for (const colId of affectedCols) renderColumnCards(colId);
    toast('Move failed. Board restored.');
  }
});

// ─── SSE event handlers ───────────────────────────────────────────────────────

function handleCardCreated({ card }) {
  // Find if we already have this card (e.g. from our own optimistic create)
  let existingColId = null;
  for (const col of getColumns()) {
    if (col.cards.some((c) => c.id === card.id)) {
      existingColId = col.id;
      break;
    }
  }
  upsertCard(card);
  renderCardUpdate(card, existingColId);
}

function handleCardMoved({ card }) {
  let previousColumnId = null;
  for (const col of getColumns()) {
    if (col.cards.some((c) => c.id === card.id)) {
      previousColumnId = col.id;
      break;
    }
  }
  upsertCard(card);
  renderCardUpdate(card, previousColumnId);
}

function handleColumnReordered({ columnId, cards }) {
  replaceColumnCards(columnId, cards);
  renderColumnCards(columnId);
}

// ─── SSE connection ───────────────────────────────────────────────────────────

let es = null;
let reconnectTimer = null;

function connectSSE() {
  if (es) {
    es.close();
    es = null;
  }

  setConnecting();

  es = openEventStream({
    onCardCreated: handleCardCreated,
    onCardMoved: handleCardMoved,
    onColumnReordered: handleColumnReordered,
    onOpen: () => {
      setConnected();
      clearTimeout(reconnectTimer);
    },
    onError: () => {
      setError();
      // Reconnect after 3 s
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        connectSSE();
      }, 3000);
    },
  });
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function init() {
  try {
    const board = await fetchBoard();
    setBoard(board);
    renderBoard();
  } catch (err) {
    console.error('[init] failed to load board:', err);
    toast('Could not load board. Is the server running?');
  }

  connectSSE();
}

init();
