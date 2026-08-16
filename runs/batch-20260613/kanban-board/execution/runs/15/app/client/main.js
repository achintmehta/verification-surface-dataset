import { fetchBoard, createCard, moveCard } from './api.js';

// ---------------------------------------------------------------------------
// Client state
//
// We keep an authoritative-ish local model:
//   columns: ordered array of { id, title }
//   cards:   Map<cardId, { id, columnId, text, position }>
// The DOM is always re-derived from this model so a card can never render in
// more than one column. Drag-and-drop performs an optimistic mutation to the
// model, then the server response / SSE broadcast snaps it to canonical state.
// ---------------------------------------------------------------------------

const state = {
  columns: [],
  cards: new Map(),
};

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');
const statusTextEl = document.getElementById('status-text');

// Track an in-flight drag so SSE events arriving mid-drag don't fight the user.
let dragging = null; // { cardId }

// ---------------------------------------------------------------------------
// Model helpers
// ---------------------------------------------------------------------------

function setBoard(board) {
  state.columns = board.columns.map((c) => ({ id: c.id, title: c.title }));
  state.cards.clear();
  for (const col of board.columns) {
    for (const card of col.cards) {
      state.cards.set(card.id, {
        id: card.id,
        columnId: card.columnId,
        text: card.text,
        position: card.position,
      });
    }
  }
}

function upsertCard(card) {
  state.cards.set(card.id, {
    id: card.id,
    columnId: card.columnId,
    text: card.text,
    position: card.position,
  });
}

/** Cards in a column, sorted by canonical position (stable tie-break by id). */
function cardsInColumn(columnId) {
  const list = [];
  for (const card of state.cards.values()) {
    if (card.columnId === columnId) list.push(card);
  }
  list.sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
  return list;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  // Preserve scroll positions of card lists across re-render.
  const scrolls = new Map();
  boardEl.querySelectorAll('.card-list').forEach((el) => {
    scrolls.set(el.dataset.columnId, el.scrollTop);
  });

  boardEl.innerHTML = '';
  for (const col of state.columns) {
    boardEl.appendChild(renderColumn(col));
  }

  scrolls.forEach((top, columnId) => {
    const el = boardEl.querySelector(`.card-list[data-column-id="${cssEscape(columnId)}"]`);
    if (el) el.scrollTop = top;
  });
}

function renderColumn(col) {
  const colEl = document.createElement('section');
  colEl.className = 'column';
  colEl.dataset.columnId = col.id;

  const cards = cardsInColumn(col.id);

  const header = document.createElement('div');
  header.className = 'column-header';
  header.innerHTML = `<span>${escapeHtml(col.title)}</span><span class="count">${cards.length}</span>`;
  colEl.appendChild(header);

  const list = document.createElement('ul');
  list.className = 'card-list';
  list.dataset.columnId = col.id;
  for (const card of cards) {
    list.appendChild(renderCard(card));
  }
  attachListDnD(list, col.id);
  colEl.appendChild(list);

  colEl.appendChild(renderAddCard(col.id));
  return colEl;
}

function renderCard(card) {
  const li = document.createElement('li');
  li.className = 'card';
  li.dataset.cardId = card.id;
  li.draggable = true;
  li.textContent = card.text;
  attachCardDnD(li, card.id);
  return li;
}

function renderAddCard(columnId) {
  const wrap = document.createElement('div');
  wrap.className = 'add-card';

  const textarea = document.createElement('textarea');
  textarea.rows = 2;
  textarea.placeholder = 'Add a card…';

  const btn = document.createElement('button');
  btn.className = 'add-card-btn';
  btn.textContent = '+ Add card';

  async function submit() {
    const text = textarea.value.trim();
    if (!text) return;
    btn.disabled = true;
    try {
      const { card } = await createCard(columnId, text);
      // The SSE broadcast will also arrive; upsert here for instant feedback.
      upsertCard(card);
      render();
      flashCard(card.id);
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
    }
  }

  btn.addEventListener('click', submit);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  });

  wrap.appendChild(textarea);
  wrap.appendChild(btn);
  return wrap;
}

// ---------------------------------------------------------------------------
// Drag and drop
// ---------------------------------------------------------------------------

function attachCardDnD(cardEl, cardId) {
  cardEl.addEventListener('dragstart', (e) => {
    dragging = { cardId };
    cardEl.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', cardId);
  });

  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('dragging');
    clearPlaceholders();
    dragging = null;
  });
}

function attachListDnD(listEl, columnId) {
  listEl.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    listEl.classList.add('drag-over');
    showPlaceholder(listEl, e.clientY);
  });

  listEl.addEventListener('dragleave', (e) => {
    // Only clear when leaving the list entirely.
    if (!listEl.contains(e.relatedTarget)) {
      listEl.classList.remove('drag-over');
    }
  });

  listEl.addEventListener('drop', (e) => {
    if (!dragging) return;
    e.preventDefault();
    listEl.classList.remove('drag-over');
    const cardId = dragging.cardId;
    const { afterId, beforeId } = neighboursAtPlaceholder(listEl, cardId);
    clearPlaceholders();
    handleDrop(cardId, columnId, afterId, beforeId);
  });
}

/** Returns the card element the cursor is directly above (excluding dragged). */
function elementAfterCursor(listEl, y) {
  const cards = [...listEl.querySelectorAll('.card:not(.dragging)')];
  let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
  for (const child of cards) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      closest = { offset, element: child };
    }
  }
  return closest.element;
}

let placeholderEl = null;

function showPlaceholder(listEl, y) {
  if (!placeholderEl) {
    placeholderEl = document.createElement('li');
    placeholderEl.className = 'drop-placeholder';
  }
  const after = elementAfterCursor(listEl, y);
  if (after) {
    listEl.insertBefore(placeholderEl, after);
  } else {
    listEl.appendChild(placeholderEl);
  }
}

function clearPlaceholders() {
  if (placeholderEl && placeholderEl.parentNode) {
    placeholderEl.parentNode.removeChild(placeholderEl);
  }
  boardEl.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
}

/**
 * Determines the neighbour card ids around the placeholder. afterId is the
 * card above the slot, beforeId is the card below the slot.
 */
function neighboursAtPlaceholder(listEl, movingCardId) {
  if (!placeholderEl || placeholderEl.parentNode !== listEl) {
    // Dropped without a placeholder (e.g. empty list): append at end.
    const cards = [...listEl.querySelectorAll('.card')].filter(
      (c) => c.dataset.cardId !== movingCardId
    );
    const last = cards[cards.length - 1];
    return { afterId: last ? last.dataset.cardId : null, beforeId: null };
  }
  let prev = placeholderEl.previousElementSibling;
  while (prev && (!prev.classList.contains('card') || prev.dataset.cardId === movingCardId)) {
    prev = prev.previousElementSibling;
  }
  let next = placeholderEl.nextElementSibling;
  while (next && (!next.classList.contains('card') || next.dataset.cardId === movingCardId)) {
    next = next.nextElementSibling;
  }
  return {
    afterId: prev ? prev.dataset.cardId : null,
    beforeId: next ? next.dataset.cardId : null,
  };
}

// ---------------------------------------------------------------------------
// Optimistic move + reconcile
// ---------------------------------------------------------------------------

async function handleDrop(cardId, columnId, afterId, beforeId) {
  const card = state.cards.get(cardId);
  if (!card) return;

  // --- Optimistic update: compute a provisional fractional position so the
  // card immediately snaps into place in the model, then re-render.
  const optimisticPosition = optimisticPositionFor(columnId, afterId, beforeId, cardId);
  card.columnId = columnId;
  card.position = optimisticPosition;
  render();
  flashCard(cardId);

  try {
    const { card: canonical, renormalized } = await moveCard(cardId, {
      columnId,
      beforeId,
      afterId,
    });
    // --- Reconcile against server-authoritative ordering.
    applyMoveResult(canonical, renormalized);
    render();
  } catch (err) {
    // On failure, re-sync the whole board from the server.
    console.error('Move failed:', err);
    await resync();
  }
}

function optimisticPositionFor(columnId, afterId, beforeId, movingCardId) {
  const STEP = 1000;
  const afterCard = afterId ? state.cards.get(afterId) : null;
  const beforeCard = beforeId ? state.cards.get(beforeId) : null;
  const afterPos =
    afterCard && afterCard.columnId === columnId ? afterCard.position : null;
  const beforePos =
    beforeCard && beforeCard.columnId === columnId ? beforeCard.position : null;

  if (afterPos == null && beforePos == null) {
    // Empty target (ignoring the moving card) — place after current max.
    const others = cardsInColumn(columnId).filter((c) => c.id !== movingCardId);
    const max = others.length ? others[others.length - 1].position : 0;
    return max + STEP;
  }
  if (afterPos == null) return beforePos - STEP;
  if (beforePos == null) return afterPos + STEP;
  return afterPos + (beforePos - afterPos) / 2;
}

function applyMoveResult(canonical, renormalized) {
  upsertCard(canonical);
  if (renormalized && Array.isArray(renormalized.cards)) {
    for (const c of renormalized.cards) {
      upsertCard(c);
    }
  }
}

// ---------------------------------------------------------------------------
// SSE real-time sync
// ---------------------------------------------------------------------------

function connectStream() {
  const es = new EventSource('/api/stream');

  es.addEventListener('open', () => setStatus('connected', 'live'));
  es.addEventListener('error', () => setStatus('disconnected', 'reconnecting…'));

  es.addEventListener('card:create', (e) => {
    const { card } = JSON.parse(e.data);
    upsertCard(card);
    render();
    flashCard(card.id);
  });

  es.addEventListener('card:move', (e) => {
    const { card, renormalized } = JSON.parse(e.data);
    // If we're mid-drag on this exact card, defer; our own reconcile will win.
    if (dragging && dragging.cardId === card.id) return;
    applyMoveResult(card, renormalized);
    render();
  });

  return es;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function setStatus(cls, text) {
  statusEl.className = `status ${cls}`;
  statusTextEl.textContent = text;
}

function flashCard(cardId) {
  // Defer to next frame so the element exists after render().
  requestAnimationFrame(() => {
    const el = boardEl.querySelector(`.card[data-card-id="${cssEscape(cardId)}"]`);
    if (el) {
      el.classList.remove('flash');
      // Force reflow to restart the animation.
      void el.offsetWidth;
      el.classList.add('flash');
    }
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cssEscape(str) {
  if (window.CSS && CSS.escape) return CSS.escape(str);
  return String(str).replace(/["\\]/g, '\\$&');
}

async function resync() {
  const board = await fetchBoard();
  setBoard(board);
  render();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function init() {
  try {
    await resync();
  } catch (err) {
    boardEl.innerHTML = `<p style="color:var(--danger)">Failed to load board: ${escapeHtml(
      err.message
    )}</p>`;
    return;
  }
  connectStream();
}

init();
