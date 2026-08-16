/**
 * Kanban Board – Vanilla JS SPA
 *
 * Architecture:
 *  - `state`  : single source of truth (columns + cards)
 *  - `render` : full re-render from state (fast enough for this scale)
 *  - Drag-and-drop via HTML5 drag events
 *  - Optimistic updates: apply locally, then reconcile on SSE event
 *  - SSE: EventSource on /api/stream
 */

/* ============================================================
   State
   ============================================================ */
/** @type {{ id: string, title: string, position: number, cards: Card[] }[]} */
let columns = [];

/** @type {{ id: string, column_id: string, text: string, position: number, created_at: string } | null} */
let dragCard = null;
let dragSourceColumnId = null;

// Modal state
let pendingColumnId = null;

/* ============================================================
   DOM refs
   ============================================================ */
const boardEl        = document.getElementById('board');
const statusEl       = document.getElementById('connection-status');
const modalOverlay   = document.getElementById('modal-overlay');
const cardTextArea   = document.getElementById('card-text');
const modalCancel    = document.getElementById('modal-cancel');
const modalSubmit    = document.getElementById('modal-submit');

/* ============================================================
   Utility helpers
   ============================================================ */
function setStatus(state) {
  statusEl.className = `connection-status ${state}`;
  statusEl.title = `SSE: ${state}`;
}

function getColumn(id) {
  return columns.find(c => c.id === id);
}

function getCard(id) {
  for (const col of columns) {
    const card = col.cards.find(c => c.id === id);
    if (card) return { card, column: col };
  }
  return null;
}

/** Remove a card from wherever it currently lives in state */
function removeCardFromState(cardId) {
  for (const col of columns) {
    const idx = col.cards.findIndex(c => c.id === cardId);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      return;
    }
  }
}

/** Insert / update a card in state, ensuring it lives in exactly one column */
function upsertCardInState(card) {
  removeCardFromState(card.id);
  const col = getColumn(card.column_id);
  if (!col) return;
  col.cards.push(card);
  col.cards.sort((a, b) => a.position - b.position);
}

/* ============================================================
   Render
   ============================================================ */
function render() {
  // Preserve scroll positions per column
  const scrollMap = {};
  boardEl.querySelectorAll('.column').forEach(el => {
    const list = el.querySelector('.card-list');
    if (list) scrollMap[el.dataset.colId] = list.scrollTop;
  });

  boardEl.innerHTML = '';

  for (const col of columns) {
    boardEl.appendChild(buildColumnEl(col));
  }

  // Restore scroll positions
  boardEl.querySelectorAll('.column').forEach(el => {
    const list = el.querySelector('.card-list');
    if (list && scrollMap[el.dataset.colId] != null) {
      list.scrollTop = scrollMap[el.dataset.colId];
    }
  });
}

function buildColumnEl(col) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.colId = col.id;

  // Header
  const header = document.createElement('div');
  header.className = 'column-header';
  header.innerHTML = `
    <span class="column-title">${escHtml(col.title)}</span>
    <span class="column-count">${col.cards.length}</span>
  `;
  colEl.appendChild(header);

  // Card list
  const listEl = document.createElement('div');
  listEl.className = 'card-list';
  listEl.dataset.colId = col.id;

  for (const card of col.cards) {
    listEl.appendChild(buildCardEl(card));
  }

  // Drag-over events on the list
  listEl.addEventListener('dragover',  onListDragOver);
  listEl.addEventListener('dragleave', onListDragLeave);
  listEl.addEventListener('drop',      onListDrop);

  colEl.appendChild(listEl);

  // Add-card button
  const addBtn = document.createElement('button');
  addBtn.className = 'add-card-btn';
  addBtn.innerHTML = `<span class="plus">＋</span> Add a card`;
  addBtn.addEventListener('click', () => openModal(col.id));
  colEl.appendChild(addBtn);

  return colEl;
}

function buildCardEl(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.dataset.cardId = card.id;
  el.dataset.colId  = card.column_id;
  el.textContent = card.text;

  el.addEventListener('dragstart', onCardDragStart);
  el.addEventListener('dragend',   onCardDragEnd);

  return el;
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ============================================================
   Drag-and-drop
   ============================================================ */
let dropIndicatorEl = null;
let dropBeforeId    = null; // card id that will come BEFORE the dragged card
let dropAfterId     = null; // card id that will come AFTER  the dragged card
let dropColumnId    = null;

function onCardDragStart(e) {
  const cardId = e.currentTarget.dataset.cardId;
  const found  = getCard(cardId);
  if (!found) return;

  dragCard           = found.card;
  dragSourceColumnId = found.column.id;

  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', cardId);
}

function onCardDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  removeDropIndicator();
  dragCard           = null;
  dragSourceColumnId = null;
  dropBeforeId       = null;
  dropAfterId        = null;
  dropColumnId       = null;

  // Remove drag-over highlights
  document.querySelectorAll('.column.drag-over').forEach(el => el.classList.remove('drag-over'));
}

function onListDragOver(e) {
  if (!dragCard) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  const listEl = e.currentTarget;
  const colId  = listEl.dataset.colId;
  const colEl  = listEl.closest('.column');
  colEl.classList.add('drag-over');

  // Determine insertion point
  const col = getColumn(colId);
  if (!col) return;

  const cardEls = [...listEl.querySelectorAll('.card:not(.dragging)')];
  let insertBefore = null; // DOM element to insert indicator before

  for (const cardEl of cardEls) {
    const rect = cardEl.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY < midY) {
      insertBefore = cardEl;
      break;
    }
  }

  // Compute beforeId / afterId from the insertion point
  // We work with the ordered list excluding the dragged card itself
  const otherCards = col.cards.filter(c => c.id !== dragCard.id);

  if (insertBefore) {
    const afterCardId = insertBefore.dataset.cardId;
    // afterCardId might be the dragged card itself if it's still in the DOM
    if (afterCardId === dragCard.id) {
      // Inserting at the dragged card's current position – treat as no-op
      dropAfterId  = null;
      dropBeforeId = null;
    } else {
      const afterIdx = otherCards.findIndex(c => c.id === afterCardId);
      dropAfterId  = afterCardId;
      dropBeforeId = afterIdx > 0 ? otherCards[afterIdx - 1].id : null;
    }
  } else {
    // Insert at end
    const lastCard = otherCards.at(-1);
    dropBeforeId = lastCard ? lastCard.id : null;
    dropAfterId  = null;
  }

  dropColumnId = colId;

  // Render drop indicator
  removeDropIndicator();
  dropIndicatorEl = document.createElement('div');
  dropIndicatorEl.className = 'drop-indicator';
  if (insertBefore) {
    listEl.insertBefore(dropIndicatorEl, insertBefore);
  } else {
    listEl.appendChild(dropIndicatorEl);
  }
}

function onListDragLeave(e) {
  const listEl = e.currentTarget;
  // Only remove if we're truly leaving the list (not entering a child)
  if (!listEl.contains(e.relatedTarget)) {
    listEl.closest('.column')?.classList.remove('drag-over');
    removeDropIndicator();
  }
}

function onListDrop(e) {
  if (!dragCard) return;
  e.preventDefault();

  const targetColId = e.currentTarget.dataset.colId;
  const cardId      = dragCard.id;
  const beforeId    = dropBeforeId;
  const afterId     = dropAfterId;
  const colId       = dropColumnId ?? targetColId;

  removeDropIndicator();
  document.querySelectorAll('.column.drag-over').forEach(el => el.classList.remove('drag-over'));

  // Skip if dropped in the same logical position (same column, same neighbours)
  const found = getCard(cardId);
  if (found) {
    const col = getColumn(colId);
    if (col && found.column.id === colId) {
      const otherCards = col.cards.filter(c => c.id !== cardId);
      const currentIdx = col.cards.findIndex(c => c.id === cardId);
      const prevCard   = currentIdx > 0 ? col.cards[currentIdx - 1] : null;
      const nextCard   = currentIdx < col.cards.length - 1 ? col.cards[currentIdx + 1] : null;
      const samePos    = (beforeId ?? null) === (prevCard?.id ?? null) &&
                         (afterId  ?? null) === (nextCard?.id ?? null);
      if (samePos) {
        render(); // just re-render to remove drag styling
        return;
      }
    }
  }

  // Optimistic update
  applyOptimisticMove(cardId, colId, beforeId, afterId);
  render();

  // Send to server
  moveCard(cardId, colId, beforeId, afterId);
}

function removeDropIndicator() {
  if (dropIndicatorEl) {
    dropIndicatorEl.remove();
    dropIndicatorEl = null;
  }
}

/* ============================================================
   Optimistic update helpers
   ============================================================ */
function applyOptimisticMove(cardId, colId, beforeId, afterId) {
  const found = getCard(cardId);
  if (!found) return;

  const card = { ...found.card };

  // Compute optimistic position
  const targetCol = getColumn(colId);
  if (!targetCol) return;

  let beforePos = null;
  let afterPos  = null;

  if (beforeId) {
    const b = targetCol.cards.find(c => c.id === beforeId);
    if (b) beforePos = b.position;
  }
  if (afterId) {
    const a = targetCol.cards.find(c => c.id === afterId);
    if (a) afterPos = a.position;
  }

  card.column_id = colId;
  card.position  = computeOptimisticPosition(beforePos, afterPos, targetCol.cards, cardId);

  upsertCardInState(card);
}

function computeOptimisticPosition(beforePos, afterPos, cards, excludeId) {
  const others = cards.filter(c => c.id !== excludeId);
  if (beforePos === null && afterPos === null) {
    return (others.at(-1)?.position ?? 0) + 1000;
  }
  if (beforePos === null) return afterPos - 1;
  if (afterPos  === null) return beforePos + 1;
  return (beforePos + afterPos) / 2;
}

/* ============================================================
   API calls
   ============================================================ */
async function fetchBoard() {
  const res = await fetch('/api/board');
  if (!res.ok) throw new Error(`GET /api/board → ${res.status}`);
  return res.json();
}

async function createCard(columnId, text) {
  const res = await fetch('/api/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `POST /api/cards → ${res.status}`);
  }
  return res.json();
}

async function moveCard(cardId, columnId, beforeId, afterId) {
  try {
    const res = await fetch(`/api/cards/${cardId}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('[moveCard] server error:', err.error);
      // Reload authoritative state on error
      await reloadBoard();
    }
    // Canonical state will arrive via SSE; no need to handle response here
  } catch (err) {
    console.error('[moveCard] network error:', err);
    await reloadBoard();
  }
}

async function reloadBoard() {
  try {
    const board = await fetchBoard();
    applyBoardState(board);
    render();
  } catch (err) {
    console.error('[reloadBoard]', err);
  }
}

/* ============================================================
   Apply authoritative board state
   ============================================================ */
function applyBoardState(board) {
  columns = board.map(col => ({
    ...col,
    cards: [...col.cards].sort((a, b) => a.position - b.position),
  }));
}

/* ============================================================
   SSE
   ============================================================ */
function connectSSE() {
  setStatus('connecting');
  const es = new EventSource('/api/stream');

  es.addEventListener('open', () => {
    setStatus('connected');
    console.log('[sse] connected');
  });

  es.addEventListener('error', () => {
    setStatus('disconnected');
    console.warn('[sse] connection error – will retry');
  });

  // A new card was created
  es.addEventListener('card:created', e => {
    const card = JSON.parse(e.data);
    console.log('[sse] card:created', card.id);
    upsertCardInState(card);
    render();
  });

  // A card was moved (single card canonical update)
  es.addEventListener('card:moved', e => {
    const card = JSON.parse(e.data);
    console.log('[sse] card:moved', card.id, '→ col', card.column_id);
    upsertCardInState(card);
    render();
  });

  // A column was renormalized (full column reorder)
  es.addEventListener('column:reordered', e => {
    const { columnId, cards } = JSON.parse(e.data);
    console.log('[sse] column:reordered', columnId);
    const col = getColumn(columnId);
    if (!col) return;

    // Remove all cards in this column from state, then re-add canonical set
    col.cards = [];
    for (const card of cards) {
      upsertCardInState(card);
    }
    render();
  });
}

/* ============================================================
   Modal
   ============================================================ */
function openModal(columnId) {
  pendingColumnId = columnId;
  cardTextArea.value = '';
  modalOverlay.classList.remove('hidden');
  cardTextArea.focus();
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  pendingColumnId = null;
}

modalCancel.addEventListener('click', closeModal);

modalOverlay.addEventListener('click', e => {
  if (e.target === modalOverlay) closeModal();
});

modalSubmit.addEventListener('click', async () => {
  const text = cardTextArea.value.trim();
  if (!text || !pendingColumnId) return;

  modalSubmit.disabled = true;
  try {
    await createCard(pendingColumnId, text);
    // Card will appear via SSE broadcast
    closeModal();
  } catch (err) {
    console.error('[createCard]', err);
    alert('Failed to create card: ' + err.message);
  } finally {
    modalSubmit.disabled = false;
  }
});

cardTextArea.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    modalSubmit.click();
  }
  if (e.key === 'Escape') closeModal();
});

/* ============================================================
   Bootstrap
   ============================================================ */
async function init() {
  boardEl.innerHTML = '<p class="loading-text">Loading board…</p>';
  try {
    const board = await fetchBoard();
    applyBoardState(board);
    render();
  } catch (err) {
    boardEl.innerHTML = `<p class="loading-text">Failed to load board: ${err.message}</p>`;
    console.error('[init]', err);
    return;
  }

  connectSSE();
}

init();
