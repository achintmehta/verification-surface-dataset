/**
 * Kanban Board – main application entry point.
 *
 * Wires together:
 *  - API calls (initial load, create, move)
 *  - Client-side state store
 *  - DOM renderer
 *  - Drag-and-drop controller
 *  - SSE real-time sync
 *  - Card-creation modal
 */

import { fetchBoard, createCard, moveCard } from './api.js';
import {
  initState,
  upsertCard,
  replaceColumnCards,
  optimisticMove,
  onChange,
} from './store.js';
import { render } from './render.js';
import { initDragDrop } from './dragdrop.js';
import * as sse from './sse.js';

/* ── Connection status indicator ─────────────────────────────────────────── */

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

/* ── Render ──────────────────────────────────────────────────────────────── */

/** Re-render the board whenever state changes. */
function scheduleRender() {
  render({ onAddCard: openModal });
}

// Register the render callback with the store so any state mutation
// automatically triggers a re-render.
onChange(scheduleRender);

/* ── Card-creation modal ─────────────────────────────────────────────────── */

const modalOverlay  = /** @type {HTMLElement} */ (document.getElementById('modal-overlay'));
const cardTextInput = /** @type {HTMLTextAreaElement} */ (document.getElementById('card-text-input'));
const modalCancel   = document.getElementById('modal-cancel');
const modalSubmit   = /** @type {HTMLButtonElement} */ (document.getElementById('modal-submit'));

let pendingColumnId = /** @type {string|null} */ (null);

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

  modalSubmit.disabled = true;

  try {
    await createCard(pendingColumnId, text);
    // The SSE `card-created` event will update the store and re-render.
    closeModal();
  } catch (err) {
    console.error('Failed to create card:', err);
    alert(`Could not create card: ${err.message}`);
  } finally {
    modalSubmit.disabled = false;
  }
}

/* ── Drag-and-drop ───────────────────────────────────────────────────────── */

initDragDrop({
  onDrop: async (cardId, targetColumnId, afterId, beforeId) => {
    // 1. Optimistic update – move the card in the local store immediately
    optimisticMove(cardId, targetColumnId, afterId, beforeId);
    // scheduleRender is called by the store's onChange listener

    // 2. Send the move to the server
    try {
      await moveCard(cardId, targetColumnId, afterId, beforeId);
      // The SSE `card-moved` event will reconcile the canonical position.
    } catch (err) {
      console.error('Failed to move card:', err);
      // On error, reload the board to restore a consistent state
      await loadBoard();
    }
  },
});

/* ── SSE event handlers ──────────────────────────────────────────────────── */

sse.on('card-created', ({ card }) => {
  upsertCard(card);
  // onChange listener triggers scheduleRender
});

sse.on('card-moved', ({ card }) => {
  upsertCard(card);
});

sse.on('column-reordered', ({ columnId, cards }) => {
  replaceColumnCards(columnId, cards);
});

sse.onStatus(setStatus);

/* ── Initial load ────────────────────────────────────────────────────────── */

async function loadBoard() {
  try {
    const data = await fetchBoard();
    initState(data);
    // onChange listener triggers scheduleRender
  } catch (err) {
    console.error('Failed to load board:', err);
    const loadingEl = document.getElementById('board-loading');
    if (loadingEl) {
      loadingEl.textContent = 'Failed to load board. Is the server running?';
    }
  }
}

/* ── Bootstrap ───────────────────────────────────────────────────────────── */

await loadBoard();

// Connect SSE after initial load so we don't miss events during startup
sse.connect();
