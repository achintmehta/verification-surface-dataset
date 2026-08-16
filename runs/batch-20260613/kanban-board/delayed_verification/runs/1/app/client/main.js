/**
 * Kanban Board – Vanilla JS SPA
 *
 * Architecture:
 *  - `state`        : single source of truth (columns + cards)
 *  - `render*()`    : pure DOM builders / reconcilers
 *  - `drag*()`      : drag-and-drop handlers
 *  - `sse*()`       : SSE event handlers (authoritative reconciliation)
 *  - `api*()`       : HTTP helpers
 */

// In development the Vite proxy forwards /api → http://localhost:3001/api.
// In production (or when opening the HTML directly) we fall back to the
// absolute server URL.  Adjust SERVER_ORIGIN if your server runs elsewhere.
const SERVER_ORIGIN = typeof window !== 'undefined' && window.location.port === '5173'
  ? ''                          // use Vite proxy (relative URLs)
  : 'http://localhost:3001';    // direct access

const API = `${SERVER_ORIGIN}/api`;

/* ================================================================
   State
   ================================================================ */
const state = {
  /** @type {Array<{id:string, title:string, position:number, cards:Array}>} */
  columns: [],
};

/* ================================================================
   Utility helpers
   ================================================================ */
function $(sel, root = document) { return root.querySelector(sel); }

function cardById(id) {
  for (const col of state.columns) {
    const card = col.cards.find(c => c.id === id);
    if (card) return { card, column: col };
  }
  return null;
}

function columnById(id) {
  return state.columns.find(c => c.id === id) ?? null;
}

/** Remove a card from whichever column currently holds it in state. */
function removeCardFromState(cardId) {
  for (const col of state.columns) {
    const idx = col.cards.findIndex(c => c.id === cardId);
    if (idx !== -1) { col.cards.splice(idx, 1); return; }
  }
}

/** Insert / update a card in state, ensuring it lives in exactly one column. */
function upsertCardInState(card) {
  removeCardFromState(card.id);
  const col = columnById(card.column_id);
  if (!col) return;
  col.cards.push(card);
  col.cards.sort((a, b) => a.position - b.position);
}

/* ================================================================
   DOM rendering
   ================================================================ */

/** Build the full board from state. */
function renderBoard() {
  const board = $('#board');
  board.innerHTML = '';
  for (const col of state.columns) {
    board.appendChild(buildColumnEl(col));
  }
}

/** Build a column element (header + card list + add button). */
function buildColumnEl(col) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.colId = col.id;

  // Header
  const header = document.createElement('div');
  header.className = 'column-header';
  const titleSpan = document.createElement('span');
  titleSpan.textContent = col.title;
  const countSpan = document.createElement('span');
  countSpan.className = 'card-count';
  countSpan.textContent = col.cards.length;
  header.appendChild(titleSpan);
  header.appendChild(countSpan);

  // Card list
  const listEl = document.createElement('div');
  listEl.className = 'card-list';
  listEl.dataset.colId = col.id;
  for (const card of col.cards) {
    listEl.appendChild(buildCardEl(card));
  }

  // Add-card button
  const addBtn = document.createElement('button');
  addBtn.className = 'add-card-btn';
  addBtn.dataset.colId = col.id;
  addBtn.innerHTML = '<span class="plus">+</span> Add a card';
  addBtn.addEventListener('click', () => openModal(col.id));

  colEl.appendChild(header);
  colEl.appendChild(listEl);
  colEl.appendChild(addBtn);

  // Drop-zone events on the list
  attachDropZoneListeners(listEl);

  return colEl;
}

/** Build a single card element. */
function buildCardEl(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.cardId = card.id;
  el.draggable = true;
  el.textContent = card.text;

  el.addEventListener('dragstart', onDragStart);
  el.addEventListener('dragend',   onDragEnd);

  return el;
}

/** Update the card-count badge for a column. */
function updateColumnCount(colId) {
  const col = columnById(colId);
  if (!col) return;
  const colEl = $(`.column[data-col-id="${colId}"]`);
  if (!colEl) return;
  const badge = colEl.querySelector('.card-count');
  if (badge) badge.textContent = col.cards.length;
}

/* ================================================================
   Reconciliation helpers
   ================================================================ */

/**
 * Reconcile a single card in the DOM after an SSE event.
 * Ensures the card element exists in exactly one column's list,
 * in the correct sorted position.
 */
function reconcileCard(card) {
  upsertCardInState(card);

  // Remove the card element from wherever it currently is in the DOM
  const existing = document.querySelector(`.card[data-card-id="${card.id}"]`);
  if (existing) existing.remove();

  // Find the target list
  const targetList = $(`.card-list[data-col-id="${card.column_id}"]`);
  if (!targetList) return;

  // Build fresh element
  const newEl = buildCardEl(card);

  // Insert at the correct position (sorted by state)
  const col = columnById(card.column_id);
  const idx = col.cards.findIndex(c => c.id === card.id);
  const children = [...targetList.querySelectorAll('.card')];

  if (idx >= children.length) {
    targetList.appendChild(newEl);
  } else {
    targetList.insertBefore(newEl, children[idx]);
  }

  // Update counts for all columns (card may have moved between columns)
  for (const c of state.columns) updateColumnCount(c.id);
}

/**
 * Reconcile an entire column's card order (after renormalisation).
 */
function reconcileColumnOrder(columnId, cards) {
  const col = columnById(columnId);
  if (!col) return;

  // Replace column's cards in state
  col.cards = [...cards].sort((a, b) => a.position - b.position);

  // Re-render just this column's list
  const listEl = $(`.card-list[data-col-id="${columnId}"]`);
  if (!listEl) return;

  // Remove all card elements from the list (keep drop-indicator if present)
  listEl.querySelectorAll('.card').forEach(el => el.remove());

  for (const card of col.cards) {
    listEl.appendChild(buildCardEl(card));
  }

  updateColumnCount(columnId);
}

/* ================================================================
   Drag-and-drop
   ================================================================ */

let dragState = null;
/*
  dragState = {
    cardId      : string,
    srcColId    : string,
    cardEl      : HTMLElement,
    placeholder : HTMLElement,   // the .dragging ghost left in place
  }
*/

function onDragStart(e) {
  const cardEl = e.currentTarget;
  const cardId = cardEl.dataset.cardId;
  const listEl = cardEl.closest('.card-list');
  const srcColId = listEl.dataset.colId;

  dragState = { cardId, srcColId, cardEl };

  // Mark the card as dragging (visual fade)
  requestAnimationFrame(() => cardEl.classList.add('dragging'));

  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', cardId);
}

function onDragEnd(e) {
  if (!dragState) return;
  dragState.cardEl.classList.remove('dragging');
  removeAllDropIndicators();
  removeAllDragOverHighlights();
  dragState = null;
}

function attachDropZoneListeners(listEl) {
  listEl.addEventListener('dragover',  onDragOver);
  listEl.addEventListener('dragleave', onDragLeave);
  listEl.addEventListener('drop',      onDrop);
}

function onDragOver(e) {
  if (!dragState) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  const listEl = e.currentTarget;
  const colEl  = listEl.closest('.column');
  colEl.classList.add('drag-over');

  // Determine where the drop indicator should go
  const { afterEl, beforeEl } = getDropNeighbours(listEl, e.clientY);
  placeDropIndicator(listEl, afterEl);
}

function onDragLeave(e) {
  const listEl = e.currentTarget;
  // Only remove highlight if we're truly leaving the list (not entering a child)
  if (!listEl.contains(e.relatedTarget)) {
    listEl.closest('.column').classList.remove('drag-over');
    removeDropIndicatorFrom(listEl);
  }
}

async function onDrop(e) {
  if (!dragState) return;
  e.preventDefault();

  const listEl  = e.currentTarget;
  const colId   = listEl.dataset.colId;
  const colEl   = listEl.closest('.column');

  colEl.classList.remove('drag-over');

  const { afterEl, beforeEl } = getDropNeighbours(listEl, e.clientY);
  removeAllDropIndicators();
  removeAllDragOverHighlights();

  const { cardId } = dragState;

  // Ignore drop onto itself with no movement
  const afterId  = afterEl  ? afterEl.dataset.cardId  : null;
  const beforeId = beforeEl ? beforeEl.dataset.cardId : null;

  // Don't move if dropped in the same spot
  if (colId === dragState.srcColId && afterId === null && beforeId === cardId) {
    dragState = null;
    return;
  }

  // ---- Optimistic update ----
  optimisticallyMove(cardId, colId, afterEl, beforeEl);

  dragState = null;

  // ---- Send to server ----
  try {
    await apiMoveCard(cardId, colId, afterId, beforeId);
    // Server will broadcast canonical state via SSE; reconcileCard() handles it.
  } catch (err) {
    console.error('[drop] move failed, reloading board', err);
    await loadBoard(); // fall back to authoritative state
  }
}

/**
 * Given a card-list element and a Y coordinate, return the card elements
 * that will be immediately above (afterEl) and below (beforeEl) the drop point.
 * Both may be null (empty list, or drop at start/end).
 */
function getDropNeighbours(listEl, clientY) {
  const cards = [...listEl.querySelectorAll('.card:not(.dragging)')];

  let afterEl  = null;
  let beforeEl = null;

  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    const mid  = rect.top + rect.height / 2;
    if (clientY > mid) {
      afterEl = card;
    } else {
      if (!beforeEl) beforeEl = card;
    }
  }

  return { afterEl, beforeEl };
}

/** Insert a drop-indicator line into listEl after afterEl (or at top if null). */
function placeDropIndicator(listEl, afterEl) {
  removeDropIndicatorFrom(listEl);

  const indicator = document.createElement('div');
  indicator.className = 'drop-indicator';

  if (afterEl) {
    afterEl.insertAdjacentElement('afterend', indicator);
  } else {
    listEl.insertAdjacentElement('afterbegin', indicator);
  }
}

function removeDropIndicatorFrom(listEl) {
  listEl.querySelectorAll('.drop-indicator').forEach(el => el.remove());
}

function removeAllDropIndicators() {
  document.querySelectorAll('.drop-indicator').forEach(el => el.remove());
}

function removeAllDragOverHighlights() {
  document.querySelectorAll('.column.drag-over').forEach(el => el.classList.remove('drag-over'));
}

/**
 * Optimistically move a card in both state and DOM.
 */
function optimisticallyMove(cardId, targetColId, afterEl, beforeEl) {
  // Find card in state
  const found = cardById(cardId);
  if (!found) return;
  const { card } = found;

  // Compute an optimistic position
  const col = columnById(targetColId);
  if (!col) return;

  let afterPos  = null;
  let beforePos = null;

  if (afterEl) {
    const ac = col.cards.find(c => c.id === afterEl.dataset.cardId);
    if (ac) afterPos = ac.position;
  }
  if (beforeEl) {
    const bc = col.cards.find(c => c.id === beforeEl.dataset.cardId);
    if (bc) beforePos = bc.position;
  }

  let newPos;
  if (afterPos === null && beforePos === null) {
    const positions = col.cards.filter(c => c.id !== cardId).map(c => c.position);
    newPos = positions.length ? Math.max(...positions) + 1000 : 1000;
  } else if (afterPos === null) {
    newPos = beforePos - 1;
  } else if (beforePos === null) {
    newPos = afterPos + 1;
  } else {
    newPos = (afterPos + beforePos) / 2;
  }

  // Update state
  card.column_id = targetColId;
  card.position  = newPos;
  upsertCardInState(card);

  // Update DOM
  const cardEl = document.querySelector(`.card[data-card-id="${cardId}"]`);
  if (!cardEl) return;

  const targetList = $(`.card-list[data-col-id="${targetColId}"]`);
  if (!targetList) return;

  // Re-insert at the right spot
  if (afterEl && afterEl.parentElement === targetList) {
    afterEl.insertAdjacentElement('afterend', cardEl);
  } else if (beforeEl && beforeEl.parentElement === targetList) {
    targetList.insertBefore(cardEl, beforeEl);
  } else {
    targetList.appendChild(cardEl);
  }

  // Update counts
  for (const c of state.columns) updateColumnCount(c.id);
}

/* ================================================================
   Modal (create card)
   ================================================================ */

let pendingColumnId = null;

function openModal(colId) {
  pendingColumnId = colId;
  const overlay = $('#modal-overlay');
  const textarea = $('#card-text');
  overlay.classList.remove('hidden');
  textarea.value = '';
  textarea.focus();
}

function closeModal() {
  $('#modal-overlay').classList.add('hidden');
  pendingColumnId = null;
}

$('#modal-cancel').addEventListener('click', closeModal);

$('#modal-overlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeModal();
});

$('#card-text').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitCard();
  if (e.key === 'Escape') closeModal();
});

$('#modal-submit').addEventListener('click', submitCard);

async function submitCard() {
  const text = $('#card-text').value.trim();
  if (!text || !pendingColumnId) return;

  const btn = $('#modal-submit');
  btn.disabled = true;

  try {
    const { card } = await apiCreateCard(pendingColumnId, text);
    // SSE will deliver the canonical card; but also handle it locally in case
    // this client's SSE event arrives after the response.
    upsertCardInState(card);
    const listEl = $(`.card-list[data-col-id="${card.column_id}"]`);
    if (listEl) {
      listEl.appendChild(buildCardEl(card));
      updateColumnCount(card.column_id);
    }
    closeModal();
  } catch (err) {
    console.error('[submitCard]', err);
    alert('Failed to create card. Please try again.');
  } finally {
    btn.disabled = false;
  }
}

/* ================================================================
   SSE – real-time updates from server
   ================================================================ */

function connectSSE() {
  const statusDot = $('#connection-status');
  statusDot.className = 'status-dot connecting';

  const es = new EventSource(`${API}/stream`);

  es.addEventListener('open', () => {
    statusDot.className = 'status-dot connected';
    console.log('[sse] connected');
  });

  es.addEventListener('error', () => {
    statusDot.className = 'status-dot disconnected';
    console.warn('[sse] connection error – will retry');
  });

  /**
   * card-created: a new card was persisted on the server.
   * We must add it if we don't already have it (idempotent).
   */
  es.addEventListener('card-created', e => {
    const { card } = JSON.parse(e.data);
    // If we already have this card (optimistic insert), update it to canonical
    reconcileCard(card);
  });

  /**
   * card-moved: a card was moved/reordered.
   * Replace our optimistic state with the server's canonical position.
   */
  es.addEventListener('card-moved', e => {
    const { card } = JSON.parse(e.data);
    reconcileCard(card);
  });

  /**
   * column-reorder: the server renormalised a column's positions.
   * Replace the entire column's order with the canonical list.
   */
  es.addEventListener('column-reorder', e => {
    const { columnId, cards } = JSON.parse(e.data);
    reconcileColumnOrder(columnId, cards);
  });
}

/* ================================================================
   API helpers
   ================================================================ */

async function apiCreateCard(columnId, text) {
  const res = await fetch(`${API}/cards`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ columnId, text }),
  });
  if (!res.ok) throw new Error(`POST /api/cards ${res.status}`);
  return res.json();
}

async function apiMoveCard(cardId, columnId, afterId, beforeId) {
  const res = await fetch(`${API}/cards/${cardId}/move`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ columnId, afterId, beforeId }),
  });
  if (!res.ok) throw new Error(`PATCH /api/cards/${cardId}/move ${res.status}`);
  return res.json();
}

async function loadBoard() {
  const res = await fetch(`${API}/board`);
  if (!res.ok) throw new Error(`GET /api/board ${res.status}`);
  const { columns } = await res.json();
  state.columns = columns.map(col => ({
    ...col,
    cards: (col.cards ?? []).sort((a, b) => a.position - b.position),
  }));
  renderBoard();
}

/* ================================================================
   Bootstrap
   ================================================================ */

async function init() {
  try {
    await loadBoard();
    connectSSE();
  } catch (err) {
    console.error('[init]', err);
    $('#board').innerHTML =
      '<p style="color:red;padding:24px">Failed to load board. Is the server running?</p>';
  }
}

init();
