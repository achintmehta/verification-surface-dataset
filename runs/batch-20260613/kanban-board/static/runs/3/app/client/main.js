/**
 * Kanban Board – Vanilla JS SPA
 *
 * Architecture:
 *  - `state`       : single source of truth (columns + cards)
 *  - `render()`    : full re-render from state (fast enough for this scale)
 *  - Drag-and-drop : HTML5 drag events; optimistic DOM update then server PATCH
 *  - SSE           : EventSource on /api/stream; incoming events update state + re-render
 */

const API = '/api';

/* ═══════════════════════════════════════════════════════════════════════════
   State
═══════════════════════════════════════════════════════════════════════════ */

/** @type {{ columns: Column[] }} */
const state = { columns: [] };

/**
 * @typedef {{ id: string, title: string, position: number, cards: Card[] }} Column
 * @typedef {{ id: string, column_id: string, text: string, position: number, created_at: string }} Card
 */

/* ═══════════════════════════════════════════════════════════════════════════
   State helpers
═══════════════════════════════════════════════════════════════════════════ */

function getColumn(columnId) {
  return state.columns.find((c) => c.id === columnId) ?? null;
}

function getCard(cardId) {
  for (const col of state.columns) {
    const card = col.cards.find((c) => c.id === cardId);
    if (card) return { card, column: col };
  }
  return null;
}

/** Remove a card from wherever it currently lives in state. */
function removeCardFromState(cardId) {
  for (const col of state.columns) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      return;
    }
  }
}

/** Insert / update a card in state, ensuring it lives in exactly one column. */
function upsertCard(card) {
  removeCardFromState(card.id);
  const col = getColumn(card.column_id);
  if (!col) return;
  col.cards.push(card);
  col.cards.sort((a, b) => a.position - b.position);
}

/** Replace all cards in a column (used after renormalisation broadcast). */
function replaceColumnCards(columnId, cards) {
  const col = getColumn(columnId);
  if (!col) return;
  // Remove these card IDs from any other column first (safety)
  const ids = new Set(cards.map((c) => c.id));
  for (const c of state.columns) {
    if (c.id !== columnId) {
      c.cards = c.cards.filter((card) => !ids.has(card.id));
    }
  }
  col.cards = [...cards].sort((a, b) => a.position - b.position);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Render
═══════════════════════════════════════════════════════════════════════════ */

const boardEl = document.getElementById('board');

function render() {
  // Preserve drag state across renders
  const draggingId = dragState.cardId;

  boardEl.innerHTML = '';

  for (const col of state.columns) {
    boardEl.appendChild(buildColumnEl(col, draggingId));
  }
}

function buildColumnEl(col, draggingId) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = col.id;

  // Header
  const header = document.createElement('div');
  header.className = 'column-header';
  header.innerHTML = `
    <span class="column-title">${escHtml(col.title)}</span>
    <span class="card-count">${col.cards.length}</span>
  `;
  colEl.appendChild(header);

  // Card list
  const listEl = document.createElement('div');
  listEl.className = 'card-list';
  listEl.dataset.columnId = col.id;

  for (const card of col.cards) {
    const cardEl = buildCardEl(card, draggingId === card.id);
    listEl.appendChild(cardEl);
  }

  // Drop-zone events on the list
  listEl.addEventListener('dragover',  onDragOver);
  listEl.addEventListener('dragleave', onDragLeave);
  listEl.addEventListener('drop',      onDrop);

  colEl.appendChild(listEl);

  // Add-card button
  const addBtn = document.createElement('button');
  addBtn.className = 'add-card-btn';
  addBtn.dataset.columnId = col.id;
  addBtn.innerHTML = '<span class="icon">＋</span> Add a card';
  addBtn.addEventListener('click', () => openModal(col.id));
  colEl.appendChild(addBtn);

  return colEl;
}

function buildCardEl(card, isDragging) {
  const el = document.createElement('div');
  el.className = 'card' + (isDragging ? ' dragging' : '');
  el.dataset.cardId = card.id;
  el.draggable = true;
  el.textContent = card.text;

  el.addEventListener('dragstart', onDragStart);
  el.addEventListener('dragend',   onDragEnd);

  return el;
}

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ═══════════════════════════════════════════════════════════════════════════
   Drag-and-drop
═══════════════════════════════════════════════════════════════════════════ */

const dragState = {
  cardId:   null,
  sourceColumnId: null,
};

function onDragStart(e) {
  const cardEl = e.currentTarget;
  dragState.cardId = cardEl.dataset.cardId;
  dragState.sourceColumnId = cardEl.closest('.card-list').dataset.columnId;

  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragState.cardId);

  // Mark as dragging after a tick so the ghost image is captured first
  requestAnimationFrame(() => cardEl.classList.add('dragging'));
}

function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  clearDropIndicators();
  dragState.cardId = null;
  dragState.sourceColumnId = null;
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  const listEl = e.currentTarget;
  clearDropIndicators();

  const { beforeCard, afterCard } = getNeighboursFromPointer(listEl, e.clientY);
  showDropIndicator(listEl, beforeCard);
}

function onDragLeave(e) {
  // Only clear if we're leaving the list entirely (not entering a child)
  if (!e.currentTarget.contains(e.relatedTarget)) {
    clearDropIndicators();
  }
}

async function onDrop(e) {
  e.preventDefault();
  clearDropIndicators();

  const listEl    = e.currentTarget;
  const columnId  = listEl.dataset.columnId;
  const cardId    = dragState.cardId;

  if (!cardId) return;

  const { beforeCard, afterCard } = getNeighboursFromPointer(listEl, e.clientY);

  // Don't do anything if dropped in the same position
  const result = getCard(cardId);
  if (!result) return;
  const { card } = result;

  const sameColumn = card.column_id === columnId;
  const sameSpot   = sameColumn
    && (beforeCard?.id ?? null) === (getPrevCard(columnId, cardId)?.id ?? null)
    && (afterCard?.id  ?? null) === (getNextCard(columnId, cardId)?.id ?? null);

  if (sameSpot) return;

  // ── Optimistic update ──────────────────────────────────────────────────
  const optimisticPosition = computeOptimisticPosition(beforeCard, afterCard, columnId);
  const optimisticCard = { ...card, column_id: columnId, position: optimisticPosition };
  upsertCard(optimisticCard);
  render();

  // ── Server mutation ────────────────────────────────────────────────────
  try {
    await fetch(`${API}/cards/${cardId}/move`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        columnId,
        beforeId: beforeCard?.id ?? null,
        afterId:  afterCard?.id  ?? null,
      }),
    });
    // The SSE event will carry the canonical state; no need to parse the response here.
  } catch (err) {
    console.error('Move failed:', err);
    // Revert optimistic update by re-fetching board state
    await loadBoard();
  }
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

/**
 * Given a pointer Y coordinate over a card-list, determine which cards
 * will be the immediate before/after neighbours of the drop target.
 *
 * "before" = the card that will sit above the drop position
 * "after"  = the card that will sit below the drop position
 */
function getNeighboursFromPointer(listEl, clientY) {
  const cardEls = [...listEl.querySelectorAll('.card:not(.dragging)')];

  if (cardEls.length === 0) return { beforeCard: null, afterCard: null };

  for (let i = 0; i < cardEls.length; i++) {
    const rect   = cardEls[i].getBoundingClientRect();
    const midY   = rect.top + rect.height / 2;

    if (clientY < midY) {
      // Drop before this card
      const beforeCard = i > 0 ? getCardFromEl(cardEls[i - 1]) : null;
      const afterCard  = getCardFromEl(cardEls[i]);
      return { beforeCard, afterCard };
    }
  }

  // Drop after the last card
  return {
    beforeCard: getCardFromEl(cardEls[cardEls.length - 1]),
    afterCard:  null,
  };
}

function getCardFromEl(el) {
  if (!el) return null;
  const id = el.dataset.cardId;
  return getCard(id)?.card ?? null;
}

function getPrevCard(columnId, cardId) {
  const col = getColumn(columnId);
  if (!col) return null;
  const idx = col.cards.findIndex((c) => c.id === cardId);
  return idx > 0 ? col.cards[idx - 1] : null;
}

function getNextCard(columnId, cardId) {
  const col = getColumn(columnId);
  if (!col) return null;
  const idx = col.cards.findIndex((c) => c.id === cardId);
  return idx !== -1 && idx < col.cards.length - 1 ? col.cards[idx + 1] : null;
}

function computeOptimisticPosition(beforeCard, afterCard, columnId) {
  const col = getColumn(columnId);
  const cards = col?.cards ?? [];

  const lo = beforeCard?.position ?? (cards.length > 0 ? cards[0].position - 1000 : 0);
  const hi = afterCard?.position  ?? (cards.length > 0 ? cards[cards.length - 1].position + 1000 : 2000);

  return (lo + hi) / 2;
}

/* ── Drop indicator ───────────────────────────────────────────────────────── */

function showDropIndicator(listEl, beforeCard) {
  clearDropIndicators();

  const indicator = document.createElement('div');
  indicator.className = 'drop-indicator';

  if (!beforeCard) {
    // Insert at the top
    listEl.insertBefore(indicator, listEl.firstChild);
    return;
  }

  const beforeEl = listEl.querySelector(`[data-card-id="${beforeCard.id}"]`);
  if (beforeEl) {
    beforeEl.insertAdjacentElement('afterend', indicator);
  } else {
    listEl.appendChild(indicator);
  }
}

function clearDropIndicators() {
  document.querySelectorAll('.drop-indicator').forEach((el) => el.remove());
}

/* ═══════════════════════════════════════════════════════════════════════════
   Modal (create card)
═══════════════════════════════════════════════════════════════════════════ */

const modalOverlay = document.getElementById('modal-overlay');
const cardTextArea = document.getElementById('card-text');
const modalCancel  = document.getElementById('modal-cancel');
const modalSubmit  = document.getElementById('modal-submit');

let activeColumnId = null;

function openModal(columnId) {
  activeColumnId = columnId;
  cardTextArea.value = '';
  modalOverlay.classList.remove('hidden');
  cardTextArea.focus();
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  activeColumnId = null;
}

modalCancel.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

cardTextArea.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitCard();
  if (e.key === 'Escape') closeModal();
});

modalSubmit.addEventListener('click', submitCard);

async function submitCard() {
  const text = cardTextArea.value.trim();
  if (!text || !activeColumnId) return;

  closeModal();

  try {
    await fetch(`${API}/cards`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId: activeColumnId, text }),
    });
    // SSE will deliver the canonical card; no optimistic insert needed here
    // (the latency is low enough that the SSE arrives almost immediately)
  } catch (err) {
    console.error('Create card failed:', err);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   SSE – real-time updates
═══════════════════════════════════════════════════════════════════════════ */

const statusEl = document.getElementById('connection-status');

function setConnectionStatus(status) {
  statusEl.className = 'connection-status ' + status;
  statusEl.title = { connected: 'Connected', connecting: 'Connecting…', '': 'Disconnected' }[status] ?? 'Disconnected';
}

function connectSSE() {
  setConnectionStatus('connecting');
  const es = new EventSource(`${API}/stream`);

  es.addEventListener('open', () => setConnectionStatus('connected'));

  es.addEventListener('error', () => {
    setConnectionStatus('');
    es.close();
    // Reconnect after 3 s
    setTimeout(connectSSE, 3000);
  });

  /** A new card was created */
  es.addEventListener('card:created', (e) => {
    const card = JSON.parse(e.data);
    upsertCard(card);
    render();
  });

  /** A card was moved (canonical position from server) */
  es.addEventListener('card:moved', (e) => {
    const card = JSON.parse(e.data);
    upsertCard(card);
    render();
  });

  /**
   * A column was renormalised – server sends the full ordered card list.
   * Replace the column's cards entirely so all clients converge.
   */
  es.addEventListener('column:reordered', (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    replaceColumnCards(columnId, cards);
    render();
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   Initial load
═══════════════════════════════════════════════════════════════════════════ */

async function loadBoard() {
  try {
    const res  = await fetch(`${API}/board`);
    const data = await res.json();
    state.columns = data.columns;
    render();
  } catch (err) {
    console.error('Failed to load board:', err);
  }
}

(async () => {
  await loadBoard();
  connectSSE();
})();
