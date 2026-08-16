/**
 * Kanban Board – main entry point.
 *
 * Responsibilities:
 *  1. Fetch initial board state and render it.
 *  2. Connect to the SSE stream and apply incoming events.
 *  3. Handle card creation via the modal.
 *  4. Handle drag-and-drop: optimistic DOM update → HTTP PATCH → reconcile.
 */

import { fetchBoard, createCard, moveCard, openEventSource } from './api.js';
import { BoardStore } from './store.js';
import { DragAndDrop } from './dnd.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const store = new BoardStore();
const boardEl = document.getElementById('board');
const statusEl = document.getElementById('connection-status');

// Modal elements
const modalOverlay = document.getElementById('modal-overlay');
const cardTextInput = document.getElementById('card-text-input');
const modalCancel = document.getElementById('modal-cancel');
const modalSubmit = document.getElementById('modal-submit');

let activeColumnId = null; // column for which the modal is open

// DnD instance – callback wired after definition
const dnd = new DragAndDrop(handleDrop);

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderBoard() {
  boardEl.innerHTML = '';
  for (const col of store.getSortedColumns()) {
    boardEl.appendChild(renderColumn(col));
  }
}

function renderColumn(col) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = col.id;

  // Header
  const header = document.createElement('div');
  header.className = 'column-header';

  const title = document.createElement('span');
  title.className = 'column-title';
  title.textContent = col.title;

  const count = document.createElement('span');
  count.className = 'column-count';
  count.textContent = store.getSortedCards(col.id).length;

  header.appendChild(title);
  header.appendChild(count);

  // Card list
  const listEl = document.createElement('div');
  listEl.className = 'card-list';
  listEl.dataset.columnId = col.id;

  for (const card of store.getSortedCards(col.id)) {
    listEl.appendChild(renderCard(card));
  }

  dnd.attachList(listEl, col.id);

  // Add card button
  const addBtn = document.createElement('button');
  addBtn.className = 'add-card-btn';
  addBtn.innerHTML = '<span class="icon">＋</span> Add a card';
  addBtn.addEventListener('click', () => openModal(col.id));

  colEl.appendChild(header);
  colEl.appendChild(listEl);
  colEl.appendChild(addBtn);

  return colEl;
}

function renderCard(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.dataset.cardId = card.id;
  cardEl.textContent = card.text;

  dnd.attachCard(cardEl, card.id);
  return cardEl;
}

// ---------------------------------------------------------------------------
// Targeted DOM updates (avoid full re-render on SSE events)
// ---------------------------------------------------------------------------

/**
 * Ensure a card element exists in the correct column list at the correct
 * position, without touching unrelated cards.
 */
function reconcileCard(card) {
  const targetListEl = document.querySelector(
    `.card-list[data-column-id="${card.column_id}"]`
  );
  if (!targetListEl) return;

  // Remove the card from wherever it currently lives in the DOM
  // and track which column it was in (for count update)
  const existingEl = document.querySelector(`[data-card-id="${card.id}"]`);
  const prevColumnId = existingEl?.closest('[data-column-id]')?.dataset.columnId;
  if (existingEl) existingEl.remove();

  // Build a fresh element
  const cardEl = renderCard(card);

  // Find the correct insertion point based on sorted store state
  const sortedCards = store.getSortedCards(card.column_id);
  const idx = sortedCards.findIndex((c) => c.id === card.id);

  if (idx === -1) {
    // Shouldn't happen, but append as fallback
    targetListEl.appendChild(cardEl);
  } else {
    // Insert before the card that comes after this one in the sorted list
    const nextCard = sortedCards[idx + 1];
    if (nextCard) {
      const nextEl = targetListEl.querySelector(`[data-card-id="${nextCard.id}"]`);
      if (nextEl) {
        targetListEl.insertBefore(cardEl, nextEl);
      } else {
        targetListEl.appendChild(cardEl);
      }
    } else {
      targetListEl.appendChild(cardEl);
    }
  }

  updateColumnCount(card.column_id);
  // If the card moved from a different column, update that column's count too
  if (prevColumnId && prevColumnId !== card.column_id) {
    updateColumnCount(prevColumnId);
  }
}

/**
 * Re-render all cards in a column (used after renormalization).
 */
function reconcileColumn(columnId) {
  const listEl = document.querySelector(`.card-list[data-column-id="${columnId}"]`);
  if (!listEl) return;

  // Remove all existing card elements from this list
  listEl.querySelectorAll('.card').forEach((el) => el.remove());

  // Re-insert in sorted order
  for (const card of store.getSortedCards(columnId)) {
    listEl.appendChild(renderCard(card));
  }

  updateColumnCount(columnId);
}

function updateColumnCount(columnId) {
  const colEl = document.querySelector(`.column[data-column-id="${columnId}"]`);
  if (!colEl) return;
  const countEl = colEl.querySelector('.column-count');
  if (countEl) countEl.textContent = store.getSortedCards(columnId).length;
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

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
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitCard();
  }
  if (e.key === 'Escape') closeModal();
});

modalSubmit.addEventListener('click', submitCard);

async function submitCard() {
  const text = cardTextInput.value.trim();
  if (!text || !activeColumnId) return;

  modalSubmit.disabled = true;
  try {
    await createCard(activeColumnId, text);
    // The SSE event will update the UI; close the modal immediately for UX
    closeModal();
  } catch (err) {
    console.error('[createCard]', err);
    alert(`Failed to create card: ${err.message}`);
  } finally {
    modalSubmit.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Drag-and-drop handler
// ---------------------------------------------------------------------------

async function handleDrop({ cardId, targetColumnId, beforeId, afterId }) {
  // Determine the source column before we mutate the store
  const sourceCard = store.getCard(cardId);
  if (!sourceCard) return;

  const sourceColumnId = sourceCard.column_id;

  // --- Optimistic update ---------------------------------------------------
  // Compute an optimistic position locally so the card snaps immediately.
  const targetCards = store.getSortedCards(targetColumnId).filter((c) => c.id !== cardId);

  const beforePos = beforeId ? targetCards.find((c) => c.id === beforeId)?.position ?? null : null;
  const afterPos  = afterId  ? targetCards.find((c) => c.id === afterId)?.position  ?? null : null;

  let optimisticPosition;
  if (beforeId === null && afterId === null) {
    // Append to end of target column
    const maxPos = targetCards.length > 0
      ? Math.max(...targetCards.map((c) => c.position))
      : 0;
    optimisticPosition = maxPos + 1000;
  } else if (beforePos === null) {
    // Insert before the first card
    optimisticPosition = afterPos / 2;
  } else if (afterPos === null) {
    // Insert after the last card
    optimisticPosition = beforePos + 1000;
  } else {
    optimisticPosition = (beforePos + afterPos) / 2;
  }

  const optimisticCard = {
    ...sourceCard,
    column_id: targetColumnId,
    position: optimisticPosition,
  };

  store.upsertCard(optimisticCard);
  reconcileCard(optimisticCard);

  // Update source column count if cross-column move
  if (sourceColumnId !== targetColumnId) {
    updateColumnCount(sourceColumnId);
  }

  // --- Server request -------------------------------------------------------
  try {
    const { card: canonicalCard } = await moveCard(cardId, targetColumnId, beforeId, afterId);
    // The SSE broadcast will arrive and reconcile; but also apply directly
    // in case this client's SSE event arrives after the response.
    store.upsertCard(canonicalCard);
    reconcileCard(canonicalCard);
  } catch (err) {
    console.error('[moveCard]', err);
    // Revert: re-fetch the full board and re-render
    try {
      const { columns } = await fetchBoard();
      store.load(columns);
      renderBoard();
    } catch (fetchErr) {
      console.error('[revert fetchBoard]', fetchErr);
    }
  }
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function connectSSE() {
  const es = openEventSource();

  es.addEventListener('open', () => {
    statusEl.classList.add('connected');
    statusEl.title = 'Connected';
  });

  es.addEventListener('error', () => {
    statusEl.classList.remove('connected');
    statusEl.title = 'Disconnected – reconnecting…';
  });

  // card-created: a new card was added
  es.addEventListener('card-created', (e) => {
    const { card } = JSON.parse(e.data);
    store.upsertCard(card);
    reconcileCard(card);
  });

  // card-moved: a card was moved/reordered
  es.addEventListener('card-moved', (e) => {
    const { card } = JSON.parse(e.data);
    const prevColumnId = store.getCard(card.id)?.column_id;
    store.upsertCard(card);
    reconcileCard(card);
    // Update old column count if cross-column
    if (prevColumnId && prevColumnId !== card.column_id) {
      updateColumnCount(prevColumnId);
    }
  });

  // column-renormalized: positions were rewritten for a whole column
  es.addEventListener('column-renormalized', (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    store.replaceColumnCards(columnId, cards);
    reconcileColumn(columnId);
  });
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function init() {
  boardEl.innerHTML = `
    <div class="board-loading">
      <div class="spinner"></div>
      Loading board…
    </div>
  `;

  try {
    const { columns } = await fetchBoard();
    store.load(columns);
    renderBoard();
    connectSSE();
  } catch (err) {
    console.error('[init]', err);
    boardEl.innerHTML = `
      <div class="board-loading" style="color:#de350b">
        Failed to load board: ${err.message}
      </div>
    `;
  }
}

init();
