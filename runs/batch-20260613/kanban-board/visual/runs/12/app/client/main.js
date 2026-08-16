import { fetchBoard, createCard, moveCard } from './api.js';

/**
 * Client-side board model.
 *
 * state.columns: ordered array of { id, title, position }
 * state.cards:   Map<cardId, { id, column_id, text, position }>
 *
 * Rendering derives card order per column by sorting on (position, id).
 * The server is authoritative: every SSE event mutates this model and we
 * re-render the affected column(s). Optimistic local changes are applied to
 * the same model immediately and later reconciled (snapped) when the server's
 * canonical event arrives.
 */
const state = {
  columns: [],
  cards: new Map(),
};

const boardEl = document.getElementById('board');
const connDot = document.getElementById('conn-dot');
const connText = document.getElementById('conn-text');

// Track the card currently being dragged.
let dragState = null; // { cardId }

// ---------------------------------------------------------------------------
// Model helpers
// ---------------------------------------------------------------------------
function cardsForColumn(columnId) {
  const list = [];
  for (const card of state.cards.values()) {
    if (card.column_id === columnId) list.push(card);
  }
  list.sort((a, b) => (a.position - b.position) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return list;
}

function upsertCard(card) {
  // Normalise numeric position (it may arrive as string from PG).
  state.cards.set(card.id, {
    id: card.id,
    column_id: card.column_id,
    text: card.text,
    position: Number(card.position),
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render() {
  boardEl.innerHTML = '';
  for (const col of state.columns) {
    boardEl.appendChild(renderColumn(col));
  }
}

function renderColumn(col) {
  const colEl = document.createElement('section');
  colEl.className = 'column';
  colEl.dataset.columnId = col.id;

  const cards = cardsForColumn(col.id);

  const header = document.createElement('div');
  header.className = 'column-header';
  header.innerHTML = `<span>${escapeHtml(col.title)}</span>`;
  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = cards.length;
  header.appendChild(count);
  colEl.appendChild(header);

  const list = document.createElement('ul');
  list.className = 'cards';
  list.dataset.columnId = col.id;

  for (const card of cards) {
    list.appendChild(renderCard(card));
  }

  wireDropTarget(list);
  colEl.appendChild(list);
  colEl.appendChild(renderAdder(col.id));
  return colEl;
}

function renderCard(card) {
  const li = document.createElement('li');
  li.className = 'card';
  li.draggable = true;
  li.dataset.cardId = card.id;
  li.textContent = card.text;

  li.addEventListener('dragstart', (e) => {
    dragState = { cardId: card.id };
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('text/plain', card.id);
    } catch {
      /* some browsers require a payload */
    }
  });

  li.addEventListener('dragend', () => {
    li.classList.remove('dragging');
    dragState = null;
    clearIndicators();
  });

  return li;
}

function renderAdder(columnId) {
  const wrap = document.createElement('div');
  wrap.className = 'add-card';

  const toggle = document.createElement('button');
  toggle.className = 'add-toggle';
  toggle.textContent = '+ Add a card';

  toggle.addEventListener('click', () => {
    wrap.innerHTML = '';
    const form = document.createElement('form');

    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Enter card text…';
    textarea.rows = 2;

    const actions = document.createElement('div');
    actions.className = 'actions';

    const add = document.createElement('button');
    add.type = 'submit';
    add.className = 'primary';
    add.textContent = 'Add';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'ghost';
    cancel.textContent = 'Cancel';

    actions.append(add, cancel);
    form.append(textarea, actions);
    wrap.appendChild(form);
    textarea.focus();

    cancel.addEventListener('click', () => {
      wrap.replaceWith(renderAdder(columnId));
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = textarea.value.trim();
      if (!text) return;
      add.disabled = true;
      try {
        // Server creates + broadcasts; we let the SSE event add it to keep a
        // single source of truth. But also handle the response for immediacy.
        const { card } = await createCard(columnId, text);
        upsertCard(card);
        render();
      } catch (err) {
        console.error(err);
        add.disabled = false;
        return;
      }
    });

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
  });

  wrap.appendChild(toggle);
  return wrap;
}

// ---------------------------------------------------------------------------
// Drag & drop
// ---------------------------------------------------------------------------
function clearIndicators() {
  document.querySelectorAll('.drop-indicator').forEach((el) => el.remove());
  document.querySelectorAll('.cards.drag-over').forEach((el) => el.classList.remove('drag-over'));
}

function wireDropTarget(list) {
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    list.classList.add('drag-over');
    showIndicator(list, e.clientY);
  });

  list.addEventListener('dragleave', (e) => {
    // Only clear when leaving the list entirely.
    if (!list.contains(e.relatedTarget)) {
      list.classList.remove('drag-over');
    }
  });

  list.addEventListener('drop', (e) => {
    e.preventDefault();
    list.classList.remove('drag-over');
    if (!dragState) return;
    const targetColumnId = list.dataset.columnId;
    const { afterCardId, beforeCardId } = neighboursAt(list, e.clientY, dragState.cardId);
    clearIndicators();
    handleDrop(dragState.cardId, targetColumnId, afterCardId, beforeCardId);
  });
}

/**
 * Determine the cards immediately above (after) and below (before) the drop
 * point, excluding the dragged card itself.
 */
function neighboursAt(list, y, draggedId) {
  const cardEls = [...list.querySelectorAll('.card')].filter(
    (el) => el.dataset.cardId !== draggedId
  );
  let afterCardId = null; // card above the insertion point
  let beforeCardId = null; // card below the insertion point

  for (const el of cardEls) {
    const rect = el.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    if (y >= mid) {
      afterCardId = el.dataset.cardId;
    } else {
      beforeCardId = el.dataset.cardId;
      break;
    }
  }
  return { afterCardId, beforeCardId };
}

function showIndicator(list, y) {
  clearIndicators();
  list.classList.add('drag-over');
  const draggedId = dragState ? dragState.cardId : null;
  const cardEls = [...list.querySelectorAll('.card')].filter(
    (el) => el.dataset.cardId !== draggedId
  );
  const indicator = document.createElement('div');
  indicator.className = 'drop-indicator';

  let inserted = false;
  for (const el of cardEls) {
    const rect = el.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    if (y < mid) {
      list.insertBefore(indicator, el);
      inserted = true;
      break;
    }
  }
  if (!inserted) list.appendChild(indicator);
}

/**
 * Apply an optimistic move locally, then PATCH the server and reconcile.
 */
async function handleDrop(cardId, columnId, afterCardId, beforeCardId) {
  const card = state.cards.get(cardId);
  if (!card) return;

  // --- Optimistic position guess ---
  const afterPos = afterCardId ? state.cards.get(afterCardId)?.position ?? null : null;
  const beforePos = beforeCardId ? state.cards.get(beforeCardId)?.position ?? null : null;
  const optimisticPos = guessPosition(columnId, afterPos, beforePos);

  card.column_id = columnId;
  card.position = optimisticPos;
  render();

  try {
    const { card: canonical, renormalizedColumns } = await moveCard(cardId, {
      columnId,
      afterId: afterCardId,
      beforeId: beforeCardId,
    });
    // Reconcile: snap to server's canonical state.
    upsertCard(canonical);
    if (renormalizedColumns) {
      for (const cards of Object.values(renormalizedColumns)) {
        for (const c of cards) upsertCard(c);
      }
    }
    render();
  } catch (err) {
    console.error('move failed, reloading authoritative state', err);
    await loadBoard();
  }
}

function guessPosition(columnId, afterPos, beforePos) {
  const STEP = 1000;
  if (afterPos == null && beforePos == null) {
    const existing = cardsForColumn(columnId);
    return existing.length ? existing[existing.length - 1].position + STEP : STEP;
  }
  if (afterPos == null) return beforePos - STEP / 2;
  if (beforePos == null) return afterPos + STEP / 2;
  return afterPos + (beforePos - afterPos) / 2;
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------
function connectStream() {
  const es = new EventSource('/api/stream');

  es.addEventListener('open', () => setConn(true));
  es.addEventListener('error', () => setConn(false));

  es.addEventListener('card-created', (e) => {
    const { card } = JSON.parse(e.data);
    upsertCard(card);
    render();
  });

  es.addEventListener('card-moved', (e) => {
    const { card } = JSON.parse(e.data);
    // Canonical move: this guarantees the card is removed from any old column
    // (column_id is overwritten) and placed in exactly one column.
    upsertCard(card);
    render();
  });

  es.addEventListener('column-reordered', (e) => {
    const { cards } = JSON.parse(e.data);
    for (const c of cards) upsertCard(c);
    render();
  });

  return es;
}

function setConn(online) {
  connDot.classList.toggle('online', online);
  connDot.classList.toggle('offline', !online);
  connText.textContent = online ? 'live' : 'reconnecting…';
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
async function loadBoard() {
  const { columns } = await fetchBoard();
  state.columns = columns.map(({ id, title, position }) => ({
    id,
    title,
    position: Number(position),
  }));
  state.cards.clear();
  for (const col of columns) {
    for (const card of col.cards) upsertCard(card);
  }
  render();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

(async function init() {
  try {
    await loadBoard();
  } catch (err) {
    console.error('initial load failed', err);
  }
  connectStream();
})();
