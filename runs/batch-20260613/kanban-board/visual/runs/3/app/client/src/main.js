import { fetchBoard, createCard, moveCard, openStream } from './api.js';
import { BoardState } from './state.js';
import { initDragAndDrop } from './dnd.js';
import { toast } from './toast.js';

// ── State ─────────────────────────────────────────────────────────────────────
const state = new BoardState();

// Track in-flight optimistic moves so we can reconcile
// key: cardId, value: { columnId, beforeId, afterId }
const pendingMoves = new Map();

// ── DOM refs ──────────────────────────────────────────────────────────────────
const boardEl      = document.getElementById('board');
const dotEl        = document.getElementById('connection-dot');
const labelEl      = document.getElementById('connection-label');

// ── Render ────────────────────────────────────────────────────────────────────

function renderBoard() {
  boardEl.innerHTML = '';
  for (const col of state.columns) {
    boardEl.appendChild(renderColumn(col));
  }
}

function renderColumn(col) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = col.id;

  const cards = state.getColumnCards(col.id);

  colEl.innerHTML = `
    <div class="column-header">
      <span class="column-title">${escHtml(col.title)}</span>
      <span class="column-count">${cards.length}</span>
    </div>
    <div class="card-list" data-column-id="${col.id}"></div>
    <div class="add-card-area" data-column-id="${col.id}">
      <button class="add-card-btn" data-column-id="${col.id}">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
        Add a card
      </button>
    </div>
  `;

  const listEl = colEl.querySelector('.card-list');
  for (const card of cards) {
    listEl.appendChild(renderCard(card));
  }

  // Add-card button
  const addBtn = colEl.querySelector('.add-card-btn');
  addBtn.addEventListener('click', () => showAddCardForm(colEl, col.id));

  return colEl;
}

function renderCard(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.cardId = card.id;
  el.dataset.position = card.position;

  const date = new Date(card.created_at).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric',
  });

  el.innerHTML = `
    <div class="card-text">${escHtml(card.text)}</div>
    <div class="card-meta">${date}</div>
  `;
  return el;
}

// ── Incremental DOM updates ───────────────────────────────────────────────────

/**
 * Reconcile a single column's card list against the current state.
 * Only moves/adds/removes DOM nodes that differ.
 */
function reconcileColumn(columnId) {
  const colEl = boardEl.querySelector(`.column[data-column-id="${columnId}"]`);
  if (!colEl) return;

  const listEl = colEl.querySelector('.card-list');
  const cards  = state.getColumnCards(columnId);

  // Build a map of existing DOM card elements
  const existing = new Map();
  for (const el of listEl.querySelectorAll('.card')) {
    existing.set(el.dataset.cardId, el);
  }

  // Remove cards that no longer belong here
  for (const [id, el] of existing) {
    if (!cards.find(c => c.id === id)) {
      el.remove();
      existing.delete(id);
    }
  }

  // Insert / reorder
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    let el = existing.get(card.id);

    if (!el) {
      el = renderCard(card);
      existing.set(card.id, el);
    } else {
      // Update position data attribute
      el.dataset.position = card.position;
    }

    // Ensure correct order in DOM
    const children = [...listEl.querySelectorAll('.card')];
    if (children[i] !== el) {
      if (children[i]) {
        listEl.insertBefore(el, children[i]);
      } else {
        listEl.appendChild(el);
      }
    }
  }

  // Update count badge
  const countEl = colEl.querySelector('.column-count');
  if (countEl) countEl.textContent = cards.length;
}

/**
 * Ensure a card element exists in exactly one column's DOM list.
 * Called after upsertCard() updates state.
 */
function reconcileCardMove(card) {
  // Remove the card element from any column it currently appears in
  const allCardEls = boardEl.querySelectorAll(`.card[data-card-id="${card.id}"]`);
  for (const el of allCardEls) {
    el.remove();
  }

  // Reconcile the target column
  reconcileColumn(card.column_id);

  // Also reconcile the source column if different (to update count)
  // We don't know the old column here, so reconcile all columns that might
  // have changed — but that's expensive. Instead we just update counts.
  updateAllCounts();
}

function updateAllCounts() {
  for (const col of state.columns) {
    const colEl = boardEl.querySelector(`.column[data-column-id="${col.id}"]`);
    if (!colEl) continue;
    const countEl = colEl.querySelector('.column-count');
    if (countEl) countEl.textContent = state.getColumnCards(col.id).length;
  }
}

// ── Add-card form ─────────────────────────────────────────────────────────────

function showAddCardForm(colEl, columnId) {
  const area = colEl.querySelector('.add-card-area');
  area.innerHTML = `
    <div class="add-card-form">
      <textarea placeholder="Enter card text…" rows="3" autofocus></textarea>
      <div class="add-card-actions">
        <button class="btn-add">Add card</button>
        <button class="btn-cancel">Cancel</button>
      </div>
    </div>
  `;

  const textarea = area.querySelector('textarea');
  textarea.focus();

  area.querySelector('.btn-cancel').addEventListener('click', () => restoreAddBtn(colEl, columnId));

  area.querySelector('.btn-add').addEventListener('click', async () => {
    const text = textarea.value.trim();
    if (!text) return;
    await submitNewCard(columnId, text, colEl);
  });

  textarea.addEventListener('keydown', async e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = textarea.value.trim();
      if (!text) return;
      await submitNewCard(columnId, text, colEl);
    }
    if (e.key === 'Escape') restoreAddBtn(colEl, columnId);
  });
}

async function submitNewCard(columnId, text, colEl) {
  try {
    // Optimistic: add a temporary card immediately
    const tempId = `temp-${Date.now()}`;
    const tempCard = {
      id: tempId,
      column_id: columnId,
      text,
      position: Date.now(),
      created_at: new Date().toISOString(),
    };
    state.upsertCard(tempCard);
    reconcileColumn(columnId);
    restoreAddBtn(colEl, columnId);

    // Persist
    const { card } = await createCard(columnId, text);

    // Replace temp card with real card
    state._removeCardFromColumn(tempId, columnId);
    state.cards.delete(tempId);
    state.upsertCard(card);
    reconcileColumn(columnId);
  } catch (err) {
    console.error(err);
    toast('Failed to create card', 'error');
  }
}

function restoreAddBtn(colEl, columnId) {
  const area = colEl.querySelector('.add-card-area');
  area.innerHTML = `
    <button class="add-card-btn" data-column-id="${columnId}">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
      Add a card
    </button>
  `;
  area.querySelector('.add-card-btn').addEventListener('click', () => showAddCardForm(colEl, columnId));
}

// ── Drag-and-drop ─────────────────────────────────────────────────────────────

function setupDragAndDrop() {
  initDragAndDrop(async ({ cardId, targetColumnId, beforeId, afterId }) => {
    const card = state.cards.get(cardId);
    if (!card) return;

    const sourceColumnId = card.column_id;

    // ── Optimistic update ──────────────────────────────────────────────────
    // Compute an optimistic position
    const targetCards = state.getColumnCards(targetColumnId).filter(c => c.id !== cardId);
    let optPos;
    const beforeCard = beforeId ? state.cards.get(beforeId) : null;
    const afterCard  = afterId  ? state.cards.get(afterId)  : null;

    if (!beforeCard && !afterCard) {
      optPos = 1000;
    } else if (!beforeCard) {
      optPos = (afterCard.position) - 1000;
    } else if (!afterCard) {
      optPos = (beforeCard.position) + 1000;
    } else {
      optPos = (beforeCard.position + afterCard.position) / 2;
    }

    const optimisticCard = { ...card, column_id: targetColumnId, position: optPos };
    state.upsertCard(optimisticCard);
    reconcileCardMove(optimisticCard);

    // Track pending move
    pendingMoves.set(cardId, { targetColumnId, beforeId, afterId });

    try {
      const { card: canonical } = await moveCard(cardId, {
        columnId: targetColumnId,
        beforeId,
        afterId,
      });

      pendingMoves.delete(cardId);

      // Reconcile with canonical state
      state.upsertCard(canonical);
      reconcileCardMove(canonical);

      // If source column changed, reconcile it too
      if (sourceColumnId !== canonical.column_id) {
        reconcileColumn(sourceColumnId);
      }
    } catch (err) {
      console.error(err);
      pendingMoves.delete(cardId);
      toast('Move failed – reverting', 'error');

      // Revert: reload board
      try {
        const data = await fetchBoard();
        state.loadBoard(data);
        renderBoard();
        setupDragAndDrop();
      } catch (_) { /* ignore */ }
    }
  });
}

// ── SSE ───────────────────────────────────────────────────────────────────────

function connectSSE() {
  const es = openStream();

  es.addEventListener('open', () => {
    dotEl.className = 'dot dot--connected';
    labelEl.textContent = 'Live';
  });

  es.addEventListener('error', () => {
    dotEl.className = 'dot dot--error';
    labelEl.textContent = 'Reconnecting…';
  });

  // card:created
  es.addEventListener('card:created', e => {
    const { card } = JSON.parse(e.data);

    // Skip if this is our own optimistic card (already in state)
    if (state.cards.has(card.id)) {
      // Update with canonical data
      state.upsertCard(card);
      reconcileColumn(card.column_id);
      return;
    }

    state.upsertCard(card);
    reconcileColumn(card.column_id);
    updateAllCounts();
  });

  // card:moved
  es.addEventListener('card:moved', e => {
    const { card } = JSON.parse(e.data);

    // If we have a pending optimistic move for this card, check if it matches
    if (pendingMoves.has(card.id)) {
      // The server confirmed our move – just reconcile with canonical position
      state.upsertCard(card);
      reconcileCardMove(card);
      return;
    }

    // Another client moved this card
    const oldCard = state.cards.get(card.id);
    state.upsertCard(card);
    reconcileCardMove(card);

    // Reconcile old column if it changed
    if (oldCard && oldCard.column_id !== card.column_id) {
      reconcileColumn(oldCard.column_id);
    }
    updateAllCounts();
  });

  // column:reordered (after renormalisation)
  es.addEventListener('column:reordered', e => {
    const { columnId, cards } = JSON.parse(e.data);
    state.reorderColumn(columnId, cards);
    reconcileColumn(columnId);
  });

  return es;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function init() {
  // Show skeleton
  boardEl.innerHTML = `
    <div class="skeleton-col"></div>
    <div class="skeleton-col"></div>
    <div class="skeleton-col"></div>
  `;

  try {
    const data = await fetchBoard();
    state.loadBoard(data);
    renderBoard();
    setupDragAndDrop();
    connectSSE();
  } catch (err) {
    console.error(err);
    boardEl.innerHTML = `<p style="color:#f87171;padding:24px">Failed to load board: ${err.message}</p>`;
    toast('Could not connect to server', 'error');
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

init();
