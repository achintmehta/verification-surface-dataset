import { fetchBoard, createCard, moveCard, openEventStream } from './api.js';
import {
  createState,
  applyBoard,
  applyCardCreated,
  applyCardMoved,
  applyColumnReordered,
  optimisticMove,
} from './state.js';
import { renderBoard, reconcileColumn } from './render.js';
import { initDnd } from './dnd.js';

/* ------------------------------------------------------------------ */
/*  Bootstrap                                                           */
/* ------------------------------------------------------------------ */
const boardEl = document.getElementById('board');
const badge   = document.getElementById('connection-badge');

let state = createState();
let dndInitialized = false;

/* ------------------------------------------------------------------ */
/*  Initial load                                                        */
/* ------------------------------------------------------------------ */
async function loadBoard() {
  try {
    const data = await fetchBoard();
    state = applyBoard(state, data);
    renderBoard(boardEl, state);

    if (!dndInitialized) {
      initDnd(boardEl);
      bindBoardEvents();
      dndInitialized = true;
    }
  } catch (err) {
    console.error('[main] loadBoard failed:', err);
    setTimeout(loadBoard, 2000);
  }
}

/* ------------------------------------------------------------------ */
/*  SSE                                                                 */
/* ------------------------------------------------------------------ */
let eventSource = null;

function connectSSE() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  eventSource = openEventStream({
    onOpen() {
      badge.textContent = 'live';
      badge.className = 'header-badge connected';
    },
    onError() {
      badge.textContent = 'reconnecting…';
      badge.className = 'header-badge disconnected';
      // EventSource auto-reconnects; we just update the badge
    },

    onCardCreated({ card }) {
      // Idempotent: if we already have this card, reconcile position
      state = applyCardCreated(state, { card });
      reconcileColumn(boardEl, card.column_id, state.cards[card.column_id]);
    },

    onCardMoved({ card }) {
      const prevColumnId = findCardColumn(state, card.id);
      state = applyCardMoved(state, { card });

      // Reconcile both source and target columns
      if (prevColumnId && prevColumnId !== card.column_id) {
        reconcileColumn(boardEl, prevColumnId, state.cards[prevColumnId] || []);
      }
      reconcileColumn(boardEl, card.column_id, state.cards[card.column_id]);
    },

    onColumnReordered({ columnId, cards }) {
      state = applyColumnReordered(state, { columnId, cards });
      reconcileColumn(boardEl, columnId, state.cards[columnId]);
    },
  });

  return eventSource;
}

/* ------------------------------------------------------------------ */
/*  Board event bindings (called once after initial render)            */
/* ------------------------------------------------------------------ */
function bindBoardEvents() {
  // "Add card" button – delegated
  boardEl.addEventListener('click', e => {
    const btn = e.target.closest('.btn-add-card');
    if (btn) openModal(btn.dataset.columnId);
  });

  // Drag-and-drop result
  boardEl.addEventListener('card-drop', async e => {
    const { cardId, targetColumnId, afterId, beforeId } = e.detail;

    // Skip no-op drops (same position)
    const currentColumn = findCardColumn(state, cardId);
    const currentCards  = state.cards[currentColumn] || [];
    const currentIndex  = currentCards.findIndex(c => c.id === cardId);
    const afterIndex    = afterId  ? currentCards.findIndex(c => c.id === afterId)  : -1;
    const beforeIndex   = beforeId ? currentCards.findIndex(c => c.id === beforeId) : currentCards.length;

    if (
      currentColumn === targetColumnId &&
      (currentIndex === afterIndex + 1 || currentIndex === beforeIndex - 1) &&
      (afterIndex === currentIndex - 1 || beforeIndex === currentIndex + 1)
    ) {
      // Card didn't actually move
      reconcileColumn(boardEl, targetColumnId, state.cards[targetColumnId]);
      return;
    }

    // Optimistic update
    const prevColumnId = findCardColumn(state, cardId);
    state = optimisticMove(state, cardId, targetColumnId, afterId, beforeId);

    if (prevColumnId && prevColumnId !== targetColumnId) {
      reconcileColumn(boardEl, prevColumnId, state.cards[prevColumnId] || []);
    }
    reconcileColumn(boardEl, targetColumnId, state.cards[targetColumnId]);

    try {
      await moveCard(cardId, targetColumnId, afterId, beforeId);
      // SSE event will arrive and reconcile canonical state
    } catch (err) {
      console.error('[main] moveCard failed:', err);
      // Reload board to recover from failed move
      const data = await fetchBoard();
      state = applyBoard(state, data);
      renderBoard(boardEl, state);
    }
  });
}

/* ------------------------------------------------------------------ */
/*  Modal                                                               */
/* ------------------------------------------------------------------ */
const overlay   = document.getElementById('modal-overlay');
const textarea  = document.getElementById('card-text-input');
const cancelBtn = document.getElementById('modal-cancel');
const submitBtn = document.getElementById('modal-submit');

let activeColumnId = null;

function openModal(columnId) {
  activeColumnId = columnId;
  textarea.value = '';
  overlay.hidden = false;
  // Small delay so the modal animation completes before focusing
  requestAnimationFrame(() => textarea.focus());
}

function closeModal() {
  overlay.hidden = true;
  activeColumnId = null;
}

cancelBtn.addEventListener('click', closeModal);

overlay.addEventListener('click', e => {
  if (e.target === overlay) closeModal();
});

textarea.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitCard();
  if (e.key === 'Escape') closeModal();
});

submitBtn.addEventListener('click', submitCard);

async function submitCard() {
  const text = textarea.value.trim();
  if (!text || !activeColumnId) return;

  // Disable button to prevent double-submit
  submitBtn.disabled = true;
  closeModal();

  try {
    await createCard(activeColumnId, text);
    // SSE will deliver the card:created event and update the DOM
  } catch (err) {
    console.error('[main] createCard failed:', err);
    // Show error feedback
    badge.textContent = 'error – retry';
    badge.className = 'header-badge disconnected';
    setTimeout(() => {
      badge.textContent = 'live';
      badge.className = 'header-badge connected';
    }, 3000);
  } finally {
    submitBtn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */
function findCardColumn(state, cardId) {
  for (const [colId, cards] of Object.entries(state.cards)) {
    if (cards.find(c => c.id === cardId)) return colId;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Start                                                               */
/* ------------------------------------------------------------------ */
loadBoard().then(() => connectSSE());
