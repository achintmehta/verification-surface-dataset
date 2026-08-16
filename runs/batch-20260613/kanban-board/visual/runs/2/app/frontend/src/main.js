/**
 * Kanban Board – Vanilla JS SPA
 *
 * Architecture:
 *  - `state`  : single source of truth (columns + cards, mirroring server DB)
 *  - Mutations: optimistic DOM update → HTTP request → reconcile with server response
 *  - SSE      : server pushes canonical state; we reconcile against it
 */

const API = '/api';

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {{ columns: Column[] }} */
const state = { columns: [] };

/**
 * @typedef {{ id: string, column_id: string, text: string, position: number, created_at: string }} Card
 * @typedef {{ id: string, title: string, position: number, cards: Card[] }} Column
 */

// ── DOM refs ──────────────────────────────────────────────────────────────────

const boardEl        = document.getElementById('board');
const modalOverlay   = document.getElementById('modal-overlay');
const cardTextInput  = document.getElementById('card-text-input');
const modalConfirm   = document.getElementById('modal-confirm');
const modalCancel    = document.getElementById('modal-cancel');
const connectionBadge = document.getElementById('connection-badge');
const badgeLabel     = connectionBadge.querySelector('.badge-label');

// Toast container
const toastContainer = document.createElement('div');
toastContainer.className = 'toast-container';
document.body.appendChild(toastContainer);

// ── Utilities ─────────────────────────────────────────────────────────────────

function toast(msg, duration = 3000) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  toastContainer.appendChild(el);
  setTimeout(() => {
    el.classList.add('fade-out');
    el.addEventListener('animationend', () => el.remove());
  }, duration);
}

function setConnectionStatus(status) {
  connectionBadge.className = 'connection-badge ' + status;
  const labels = { connected: 'Live', error: 'Disconnected', '': 'Connecting…' };
  badgeLabel.textContent = labels[status] ?? 'Connecting…';
}

// ── State helpers ─────────────────────────────────────────────────────────────

function getColumn(colId) {
  return state.columns.find(c => c.id === colId);
}

function getCard(cardId) {
  for (const col of state.columns) {
    const card = col.cards.find(c => c.id === cardId);
    if (card) return { card, column: col };
  }
  return null;
}

/** Remove a card from wherever it currently lives in state */
function removeCardFromState(cardId) {
  for (const col of state.columns) {
    const idx = col.cards.findIndex(c => c.id === cardId);
    if (idx !== -1) { col.cards.splice(idx, 1); return; }
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

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderBoard() {
  boardEl.innerHTML = '';
  for (const col of state.columns) {
    boardEl.appendChild(buildColumnEl(col));
  }
}

function buildColumnEl(col) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.colId = col.id;

  // Header
  const header = document.createElement('div');
  header.className = 'column-header';

  const title = document.createElement('span');
  title.className = 'column-title';
  title.textContent = col.title;

  const count = document.createElement('span');
  count.className = 'column-count';
  count.textContent = col.cards.length;

  header.appendChild(title);
  header.appendChild(count);
  colEl.appendChild(header);

  // Card list
  const listEl = document.createElement('div');
  listEl.className = 'card-list';
  listEl.dataset.colId = col.id;

  if (col.cards.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-column';
    empty.textContent = 'No cards yet';
    listEl.appendChild(empty);
  } else {
    for (const card of col.cards) {
      listEl.appendChild(buildCardEl(card));
    }
  }

  setupDropZone(listEl);
  colEl.appendChild(listEl);

  // Add-card button
  const addBtn = document.createElement('button');
  addBtn.className = 'add-card-btn';
  addBtn.dataset.colId = col.id;
  addBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>
    Add a card
  `;
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

  el.innerHTML = `
    <span class="card-text">${escapeHtml(card.text)}</span>
    <span class="card-drag-handle" aria-hidden="true">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
        <circle cx="4" cy="3" r="1.2"/><circle cx="8" cy="3" r="1.2"/>
        <circle cx="4" cy="6" r="1.2"/><circle cx="8" cy="6" r="1.2"/>
        <circle cx="4" cy="9" r="1.2"/><circle cx="8" cy="9" r="1.2"/>
      </svg>
    </span>
  `;

  setupDragSource(el, card);
  return el;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Partial DOM updates (avoid full re-render on SSE events) ──────────────────

/**
 * Sync a single column's card list DOM to match state.
 * Flashes cards whose position changed (reconciliation).
 */
function syncColumnDom(colId, flashCardId = null) {
  const col = getColumn(colId);
  if (!col) return;

  const colEl  = boardEl.querySelector(`.column[data-col-id="${colId}"]`);
  if (!colEl) { renderBoard(); return; }

  const listEl = colEl.querySelector('.card-list');
  const countEl = colEl.querySelector('.column-count');

  // Rebuild card list
  listEl.innerHTML = '';
  if (col.cards.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-column';
    empty.textContent = 'No cards yet';
    listEl.appendChild(empty);
  } else {
    for (const card of col.cards) {
      const cardEl = buildCardEl(card);
      if (card.id === flashCardId) {
        cardEl.classList.add('reconciling');
      }
      listEl.appendChild(cardEl);
    }
  }

  countEl.textContent = col.cards.length;
}

// ── Drag-and-drop ─────────────────────────────────────────────────────────────

/** Currently dragged card info */
const drag = {
  cardId:       null,
  srcColId:     null,
  /** snapshot of card before optimistic move */
  savedCard:    null,
};

function setupDragSource(el, card) {
  el.addEventListener('dragstart', e => {
    drag.cardId   = card.id;
    drag.srcColId = card.column_id;
    drag.savedCard = { ...card };

    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.id);

    // Slight delay so the ghost image renders before we add .dragging
    requestAnimationFrame(() => el.classList.add('dragging'));
  });

  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    clearAllDropIndicators();
    drag.cardId   = null;
    drag.srcColId = null;
    drag.savedCard = null;
  });
}

function setupDropZone(listEl) {
  listEl.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const colEl = listEl.closest('.column');
    colEl.classList.add('drag-over');

    // Show placeholder at the right position
    showPlaceholder(listEl, e.clientY);
  });

  listEl.addEventListener('dragleave', e => {
    // Only remove if we're leaving the list entirely
    if (!listEl.contains(e.relatedTarget)) {
      listEl.closest('.column').classList.remove('drag-over');
      removePlaceholder(listEl);
    }
  });

  listEl.addEventListener('drop', e => {
    e.preventDefault();
    const colEl = listEl.closest('.column');
    colEl.classList.remove('drag-over');

    const targetColId = listEl.dataset.colId;
    if (!drag.cardId) return;

    const { beforeId, afterId } = getNeighboursFromPlaceholder(listEl);
    removePlaceholder(listEl);

    handleDrop(drag.cardId, targetColId, beforeId, afterId);
  });
}

/** Insert a placeholder element at the right position in the list */
function showPlaceholder(listEl, clientY) {
  removePlaceholder(listEl);

  const cards = [...listEl.querySelectorAll('.card:not(.dragging)')];
  let insertBefore = null;

  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      insertBefore = card;
      break;
    }
  }

  const ph = document.createElement('div');
  ph.className = 'drop-placeholder';
  ph.dataset.placeholder = '1';

  if (insertBefore) {
    listEl.insertBefore(ph, insertBefore);
  } else {
    listEl.appendChild(ph);
  }
}

function removePlaceholder(listEl) {
  const ph = listEl.querySelector('[data-placeholder]');
  if (ph) ph.remove();
}

function clearAllDropIndicators() {
  document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  document.querySelectorAll('[data-placeholder]').forEach(el => el.remove());
}

/**
 * Read the placeholder position to determine neighbours.
 * Returns { beforeId, afterId } where:
 *   beforeId = card immediately before the placeholder (null if placeholder is first)
 *   afterId  = card immediately after  the placeholder (null if placeholder is last)
 */
function getNeighboursFromPlaceholder(listEl) {
  const children = [...listEl.children];
  const phIdx = children.findIndex(el => el.dataset.placeholder);
  if (phIdx === -1) return { beforeId: null, afterId: null };

  const beforeEl = children.slice(0, phIdx).reverse().find(el => el.dataset.cardId);
  const afterEl  = children.slice(phIdx + 1).find(el => el.dataset.cardId);

  return {
    beforeId: beforeEl?.dataset.cardId ?? null,
    afterId:  afterEl?.dataset.cardId  ?? null,
  };
}

// ── Drop handler ──────────────────────────────────────────────────────────────

async function handleDrop(cardId, targetColId, beforeId, afterId) {
  const found = getCard(cardId);
  if (!found) return;

  const { card: originalCard } = found;
  const srcColId = originalCard.column_id;

  // ── Optimistic update ──────────────────────────────────────────────────────
  // Compute an optimistic position between neighbours
  const beforeCard = beforeId ? getCard(beforeId)?.card : null;
  const afterCard  = afterId  ? getCard(afterId)?.card  : null;

  const beforePos = beforeCard?.position ?? null;
  const afterPos  = afterCard?.position  ?? null;

  let optimisticPos;
  if (beforePos === null && afterPos === null) optimisticPos = 1000;
  else if (beforePos === null) optimisticPos = afterPos - 1000;
  else if (afterPos  === null) optimisticPos = beforePos + 1000;
  else optimisticPos = (beforePos + afterPos) / 2;

  // Apply optimistic state
  const optimisticCard = { ...originalCard, column_id: targetColId, position: optimisticPos };
  upsertCardInState(optimisticCard);

  // Re-render affected columns
  syncColumnDom(targetColId);
  if (srcColId !== targetColId) syncColumnDom(srcColId);

  // ── Server request ─────────────────────────────────────────────────────────
  try {
    const resp = await fetch(`${API}/cards/${cardId}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId: targetColId, beforeId, afterId }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || resp.statusText);
    }

    // Server response is handled via SSE (card:moved event).
    // If SSE is slow we also reconcile here.
    const { card: serverCard } = await resp.json();
    reconcileCard(serverCard);
  } catch (err) {
    console.error('[drop] move failed:', err);
    toast('Move failed – reverting');
    // Revert to original
    upsertCardInState(originalCard);
    syncColumnDom(targetColId);
    if (srcColId !== targetColId) syncColumnDom(srcColId);
  }
}

/**
 * Reconcile a server-canonical card against current state.
 * If position or column differs from what we have, update and flash.
 */
function reconcileCard(serverCard) {
  const found = getCard(serverCard.id);
  if (!found) {
    // Card not in state yet – just insert it
    upsertCardInState(serverCard);
    syncColumnDom(serverCard.column_id);
    return;
  }

  const { card: localCard } = found;
  const posChanged = Math.abs(localCard.position - serverCard.position) > 1e-9;
  const colChanged = localCard.column_id !== serverCard.column_id;

  if (posChanged || colChanged) {
    const oldColId = localCard.column_id;
    upsertCardInState(serverCard);
    syncColumnDom(serverCard.column_id, serverCard.id);
    if (colChanged) syncColumnDom(oldColId);
  }
}

// ── Modal (add card) ──────────────────────────────────────────────────────────

let pendingColId = null;

function openModal(colId) {
  pendingColId = colId;
  cardTextInput.value = '';
  modalOverlay.hidden = false;
  cardTextInput.focus();
}

function closeModal() {
  modalOverlay.hidden = true;
  pendingColId = null;
}

modalCancel.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });
cardTextInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitCard(); }
  if (e.key === 'Escape') closeModal();
});
modalConfirm.addEventListener('click', submitCard);

async function submitCard() {
  const text = cardTextInput.value.trim();
  if (!text || !pendingColId) return;

  modalConfirm.disabled = true;

  try {
    const resp = await fetch(`${API}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId: pendingColId, text }),
    });

    if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || resp.statusText);

    // Card will arrive via SSE; close modal
    closeModal();
  } catch (err) {
    console.error('[submitCard]', err);
    toast('Failed to create card');
  } finally {
    modalConfirm.disabled = false;
  }
}

// ── SSE ───────────────────────────────────────────────────────────────────────

function connectSSE() {
  const es = new EventSource(`/api/stream`);

  es.addEventListener('open', () => {
    setConnectionStatus('connected');
  });

  es.addEventListener('error', () => {
    setConnectionStatus('error');
    // EventSource auto-reconnects; we just update the badge
  });

  // ── card:created ────────────────────────────────────────────────────────────
  es.addEventListener('card:created', e => {
    const { card } = JSON.parse(e.data);
    upsertCardInState(card);
    syncColumnDom(card.column_id);
  });

  // ── card:moved ──────────────────────────────────────────────────────────────
  es.addEventListener('card:moved', e => {
    const { card } = JSON.parse(e.data);
    const found = getCard(card.id);
    const oldColId = found?.card.column_id;
    reconcileCard(card);
    if (oldColId && oldColId !== card.column_id) syncColumnDom(oldColId);
  });

  // ── column:reordered (after renormalisation) ────────────────────────────────
  es.addEventListener('column:reordered', e => {
    const { columnId, cards } = JSON.parse(e.data);
    const col = getColumn(columnId);
    if (!col) return;
    // Replace the column's cards wholesale with the renormed list
    col.cards = cards.map(c => ({ ...c, position: parseFloat(c.position) }));
    syncColumnDom(columnId);
  });
}

// ── Initial load ──────────────────────────────────────────────────────────────

async function loadBoard() {
  boardEl.innerHTML = `<div class="board-loading"><div class="spinner"></div> Loading board…</div>`;

  try {
    const resp = await fetch(`${API}/board`);
    if (!resp.ok) throw new Error(resp.statusText);
    const { columns } = await resp.json();

    state.columns = columns.map(col => ({
      ...col,
      position: parseFloat(col.position),
      cards: col.cards.map(c => ({ ...c, position: parseFloat(c.position) })),
    }));

    renderBoard();
  } catch (err) {
    console.error('[loadBoard]', err);
    boardEl.innerHTML = `<div class="board-loading" style="color:var(--danger)">Failed to load board. Is the server running?</div>`;
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

loadBoard();
connectSSE();
