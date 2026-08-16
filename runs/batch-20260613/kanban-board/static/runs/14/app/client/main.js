import { fetchBoard, createCard, moveCard } from './api.js';

// ---------------------------------------------------------------------------
// Client-side authoritative model
//
// We keep a normalized in-memory model that mirrors the server's canonical
// state. The model is the single source of truth for rendering. Drag-and-drop
// performs an optimistic mutation of the model + a re-render, then sends the
// move intent to the server. SSE events apply canonical updates to the model
// and re-render, which is how optimistic state is reconciled.
//
// Ordering within a column is computed by sorting on (position, createdAt, id),
// guaranteeing a total, stable order that matches the server.
// ---------------------------------------------------------------------------

/** @type {{ columns: Array<{id:string,title:string,position:number}>, cards: Map<string, Card> }} */
const model = {
  columns: [],
  cards: new Map(),
};

/** @typedef {{id:string, columnId:string, text:string, position:number, createdAt:string}} Card */

const boardEl = document.getElementById('board');
const connDot = document.getElementById('connection-dot');
const connText = document.getElementById('connection-text');

// ---------------------------------------------------------------------------
// Model helpers
// ---------------------------------------------------------------------------

function upsertCard(card) {
  model.cards.set(card.id, {
    id: card.id,
    columnId: card.columnId,
    text: card.text,
    position: Number(card.position),
    createdAt: card.createdAt,
  });
}

function cardsForColumn(columnId) {
  const list = [];
  for (const card of model.cards.values()) {
    if (card.columnId === columnId) list.push(card);
  }
  // Total, stable ordering identical to the server.
  list.sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    if (a.createdAt !== b.createdAt) {
      return String(a.createdAt) < String(b.createdAt) ? -1 : 1;
    }
    return a.id < b.id ? -1 : 1;
  });
  return list;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  // Preserve focus/value of any open add-card textarea across re-renders.
  const active = document.activeElement;
  const activeColId =
    active && active.classList && active.classList.contains('add-card__input')
      ? active.closest('.column')?.dataset.columnId
      : null;
  const activeValue = activeColId ? active.value : null;
  const selStart = activeColId ? active.selectionStart : null;
  const selEnd = activeColId ? active.selectionEnd : null;

  boardEl.innerHTML = '';
  for (const column of model.columns) {
    boardEl.appendChild(renderColumn(column));
  }

  if (activeColId) {
    const restored = boardEl.querySelector(
      `.column[data-column-id="${cssEscape(activeColId)}"] .add-card__input`
    );
    if (restored) {
      restored.value = activeValue;
      restored.focus();
      try {
        restored.setSelectionRange(selStart, selEnd);
      } catch {
        /* ignore */
      }
    }
  }
}

function renderColumn(column) {
  const colEl = document.createElement('section');
  colEl.className = 'column';
  colEl.dataset.columnId = column.id;

  const cards = cardsForColumn(column.id);

  const header = document.createElement('div');
  header.className = 'column__header';
  header.innerHTML = `<span>${escapeHtml(column.title)}</span>`;
  const count = document.createElement('span');
  count.className = 'column__count';
  count.textContent = String(cards.length);
  header.appendChild(count);

  const cardsEl = document.createElement('div');
  cardsEl.className = 'column__cards';
  cardsEl.dataset.columnId = column.id;

  for (const card of cards) {
    cardsEl.appendChild(renderCard(card));
  }

  wireColumnDnd(cardsEl, column.id);

  const footer = document.createElement('div');
  footer.className = 'column__footer';
  footer.appendChild(renderAddCard(column.id));

  colEl.appendChild(header);
  colEl.appendChild(cardsEl);
  colEl.appendChild(footer);
  return colEl;
}

function renderCard(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.dataset.cardId = card.id;
  el.textContent = card.text;

  el.addEventListener('dragstart', (e) => {
    dragState.cardId = card.id;
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.id);
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    clearPlaceholders();
    dragState.cardId = null;
  });

  return el;
}

function renderAddCard(columnId) {
  const form = document.createElement('form');
  form.className = 'add-card';

  const input = document.createElement('textarea');
  input.className = 'add-card__input';
  input.placeholder = 'Add a card…';
  input.rows = 1;

  const button = document.createElement('button');
  button.type = 'submit';
  button.textContent = 'Add';

  form.appendChild(input);
  form.appendChild(button);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      // Create on server; the SSE broadcast (card:created) will add it to the
      // model and re-render. We don't optimistically add to avoid duplicates,
      // since the create returns quickly and the broadcast is authoritative.
      const { card } = await createCard(columnId, text);
      // Apply locally too in case the SSE event is delayed.
      upsertCard(card);
      render();
    } catch (err) {
      console.error(err);
      input.value = text;
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  return form;
}

// ---------------------------------------------------------------------------
// Drag-and-drop
// ---------------------------------------------------------------------------

const dragState = { cardId: null };

function wireColumnDnd(cardsEl, columnId) {
  cardsEl.addEventListener('dragover', (e) => {
    if (!dragState.cardId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    cardsEl.classList.add('drag-over');
    showPlaceholder(cardsEl, e.clientY);
  });

  cardsEl.addEventListener('dragleave', (e) => {
    // Only clear when leaving the column area entirely.
    if (!cardsEl.contains(e.relatedTarget)) {
      cardsEl.classList.remove('drag-over');
    }
  });

  cardsEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    cardsEl.classList.remove('drag-over');
    const cardId = dragState.cardId || e.dataTransfer.getData('text/plain');
    if (!cardId) return;

    const { afterId, beforeId } = neighborsFromPlaceholder(cardsEl, cardId);
    clearPlaceholders();
    dragState.cardId = null;

    await applyMove(cardId, columnId, { afterId, beforeId });
  });
}

/**
 * Inserts (or moves) a placeholder element at the position under the cursor,
 * so the user sees where the card will land.
 */
function showPlaceholder(cardsEl, clientY) {
  let ph = document.querySelector('.drop-placeholder');
  if (!ph) {
    ph = document.createElement('div');
    ph.className = 'card drop-placeholder';
  }
  const afterEl = getCardAfter(cardsEl, clientY);
  if (afterEl == null) {
    cardsEl.appendChild(ph);
  } else {
    cardsEl.insertBefore(ph, afterEl);
  }
}

function clearPlaceholders() {
  document
    .querySelectorAll('.drop-placeholder')
    .forEach((el) => el.remove());
  document
    .querySelectorAll('.column__cards.drag-over')
    .forEach((el) => el.classList.remove('drag-over'));
}

/**
 * Finds the first card whose vertical midpoint is below the cursor; the
 * dragged card should be inserted before it.
 */
function getCardAfter(cardsEl, clientY) {
  const cards = [
    ...cardsEl.querySelectorAll('.card:not(.dragging):not(.drop-placeholder)'),
  ];
  for (const card of cards) {
    const box = card.getBoundingClientRect();
    if (clientY < box.top + box.height / 2) {
      return card;
    }
  }
  return null;
}

/**
 * Resolves the afterId/beforeId neighbor card ids based on the placeholder's
 * current DOM position, excluding the card being moved.
 */
function neighborsFromPlaceholder(cardsEl, movingId) {
  const ph = cardsEl.querySelector('.drop-placeholder');
  let afterId = null;
  let beforeId = null;

  const children = [...cardsEl.children];
  const phIndex = ph ? children.indexOf(ph) : children.length;

  // Walk backwards for the preceding card (afterId).
  for (let i = phIndex - 1; i >= 0; i--) {
    const el = children[i];
    if (
      el.classList.contains('card') &&
      !el.classList.contains('drop-placeholder')
    ) {
      const id = el.dataset.cardId;
      if (id && id !== movingId) {
        afterId = id;
        break;
      }
    }
  }
  // Walk forwards for the following card (beforeId).
  for (let i = phIndex + 1; i < children.length; i++) {
    const el = children[i];
    if (
      el.classList.contains('card') &&
      !el.classList.contains('drop-placeholder')
    ) {
      const id = el.dataset.cardId;
      if (id && id !== movingId) {
        beforeId = id;
        break;
      }
    }
  }
  return { afterId, beforeId };
}

/**
 * Optimistically move the card in the model, re-render, then send intent.
 * The server's response / SSE broadcast reconciles to canonical state.
 */
async function applyMove(cardId, columnId, { afterId, beforeId }) {
  const card = model.cards.get(cardId);
  if (!card) return;

  // Optimistic position: compute a fractional guess matching the server's
  // rule so the card lands in the right slot immediately.
  const optimisticPos = computeOptimisticPosition(columnId, afterId, beforeId);
  const prev = { columnId: card.columnId, position: card.position };
  card.columnId = columnId;
  card.position = optimisticPos;
  render();

  try {
    const { card: canonical } = await moveCard(cardId, {
      columnId,
      afterId,
      beforeId,
    });
    // Reconcile to the server's canonical position.
    upsertCard(canonical);
    render();
  } catch (err) {
    console.error('Move failed, reverting:', err);
    // Revert optimistic change on failure.
    const current = model.cards.get(cardId);
    if (current) {
      current.columnId = prev.columnId;
      current.position = prev.position;
      render();
    }
  }
}

function computeOptimisticPosition(columnId, afterId, beforeId) {
  const STEP = 1024;
  const list = cardsForColumn(columnId);
  const afterCard = afterId ? model.cards.get(afterId) : null;
  const beforeCard = beforeId ? model.cards.get(beforeId) : null;

  const lower =
    afterCard && afterCard.columnId === columnId ? afterCard.position : null;
  const upper =
    beforeCard && beforeCard.columnId === columnId ? beforeCard.position : null;

  if (lower == null && upper == null) {
    if (list.length === 0) return STEP;
    return list[list.length - 1].position + STEP;
  }
  if (lower == null) return upper - STEP;
  if (upper == null) return lower + STEP;
  return (lower + upper) / 2;
}

// ---------------------------------------------------------------------------
// SSE real-time sync
// ---------------------------------------------------------------------------

function connectStream() {
  const es = new EventSource('/api/stream');

  es.addEventListener('open', () => setConnection(true));
  es.addEventListener('error', () => setConnection(false));

  es.addEventListener('card:created', (e) => {
    const { card } = JSON.parse(e.data);
    upsertCard(card);
    render();
  });

  es.addEventListener('card:moved', (e) => {
    const { card } = JSON.parse(e.data);
    upsertCard(card);
    render();
  });

  es.addEventListener('column:reordered', (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    // Replace the canonical ordering for the affected column: remove any cards
    // we think belong there but the server no longer lists, and upsert the
    // authoritative set with corrected positions.
    const serverIds = new Set(cards.map((c) => c.id));
    for (const card of model.cards.values()) {
      if (card.columnId === columnId && !serverIds.has(card.id)) {
        model.cards.delete(card.id);
      }
    }
    for (const card of cards) upsertCard(card);
    render();
  });

  return es;
}

function setConnection(online) {
  connDot.className = `dot ${online ? 'dot--online' : 'dot--offline'}`;
  connText.textContent = online ? 'live' : 'reconnecting…';
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cssEscape(str) {
  if (window.CSS && window.CSS.escape) return window.CSS.escape(str);
  return String(str).replace(/["\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function init() {
  try {
    const board = await fetchBoard();
    model.columns = board.columns.map((c) => ({
      id: c.id,
      title: c.title,
      position: Number(c.position),
    }));
    model.cards.clear();
    for (const col of board.columns) {
      for (const card of col.cards) upsertCard(card);
    }
    render();
  } catch (err) {
    console.error('Failed to load board:', err);
    boardEl.innerHTML = `<p style="color:#ff8a8a">Failed to load board: ${escapeHtml(
      err.message
    )}</p>`;
  }
  connectStream();
}

init();
