import { fetchBoard, createCard, moveCard } from './api.js';

/**
 * Client-side board state model.
 *
 * The model is the single source of truth for rendering. We keep:
 *   - columns: ordered array of { id, title }
 *   - cards:   Map<cardId, { id, column_id, text, position, created_at }>
 *
 * Card ordering within a column is derived from `position` (ties broken by
 * created_at then id), exactly matching the server's canonical ordering. This
 * guarantees a card never renders in two columns, and that all clients with
 * the same data converge to identical order.
 */
const state = {
  columns: [],
  cards: new Map(),
};

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');

// Tracks the card currently being dragged (id), plus whether a move request
// is in flight so we can avoid clobbering optimistic state mid-flight.
let draggingCardId = null;

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function cardsForColumn(columnId) {
  const list = [];
  for (const card of state.cards.values()) {
    if (card.column_id === columnId) list.push(card);
  }
  list.sort(compareCards);
  return list;
}

function compareCards(a, b) {
  if (a.position !== b.position) return a.position - b.position;
  const ca = Number(a.created_at) || 0;
  const cb = Number(b.created_at) || 0;
  if (ca !== cb) return ca - cb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function upsertCard(card) {
  state.cards.set(card.id, {
    id: card.id,
    column_id: card.column_id,
    text: card.text,
    position: Number(card.position),
    created_at: Number(card.created_at) || 0,
  });
}

/**
 * Apply a server-provided canonical ordering for a column (after a
 * renormalization). Replaces positions for the listed cards exactly.
 */
function applyColumnOrder(columnId, cards) {
  for (const card of cards) {
    upsertCard(card);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  // Preserve focus/active add-forms by rebuilding minimally is overkill here;
  // a full re-render keeps the implementation robust and convergent.
  boardEl.innerHTML = '';
  for (const column of state.columns) {
    boardEl.appendChild(renderColumn(column));
  }
}

function renderColumn(column) {
  const columnEl = document.createElement('section');
  columnEl.className = 'column';
  columnEl.dataset.columnId = column.id;

  const cards = cardsForColumn(column.id);

  const header = document.createElement('div');
  header.className = 'column__header';
  const title = document.createElement('span');
  title.textContent = column.title;
  const count = document.createElement('span');
  count.className = 'column__count';
  count.textContent = String(cards.length);
  header.append(title, count);

  const list = document.createElement('ul');
  list.className = 'cards';
  list.dataset.columnId = column.id;

  for (const card of cards) {
    list.appendChild(renderCard(card));
  }

  attachListDnd(list, column.id);

  const footer = document.createElement('div');
  footer.className = 'column__footer';
  footer.appendChild(renderAddCard(column.id));

  columnEl.append(header, list, footer);
  return columnEl;
}

function renderCard(card) {
  const li = document.createElement('li');
  li.className = 'card';
  li.draggable = true;
  li.dataset.cardId = card.id;
  li.textContent = card.text;

  li.addEventListener('dragstart', (e) => {
    draggingCardId = card.id;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.id);
  });

  li.addEventListener('dragend', () => {
    li.classList.remove('dragging');
    draggingCardId = null;
    clearPlaceholders();
  });

  return li;
}

function renderAddCard(columnId) {
  const button = document.createElement('button');
  button.className = 'add-card';
  button.textContent = '+ Add a card';

  button.addEventListener('click', () => {
    const form = renderAddForm(columnId, () => {
      form.replaceWith(button);
    });
    button.replaceWith(form);
    form.querySelector('textarea').focus();
  });

  return button;
}

function renderAddForm(columnId, onClose) {
  const form = document.createElement('form');
  form.className = 'add-form';

  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Enter card text…';

  const actions = document.createElement('div');
  actions.className = 'add-form__actions';

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'btn btn--primary';
  submit.textContent = 'Add card';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn--ghost';
  cancel.textContent = 'Cancel';

  actions.append(submit, cancel);
  form.append(textarea, actions);

  cancel.addEventListener('click', onClose);

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    } else if (e.key === 'Escape') {
      onClose();
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textarea.value.trim();
    if (!text) return;
    submit.disabled = true;
    try {
      // The created card will arrive via SSE (and via the response). We rely
      // on upsert idempotency so both paths converge to the same card.
      const { card } = await createCard(columnId, text);
      upsertCard(card);
      render();
    } catch (err) {
      console.error(err);
      submit.disabled = false;
      return;
    }
  });

  return form;
}

// ---------------------------------------------------------------------------
// Drag and drop
// ---------------------------------------------------------------------------

function clearPlaceholders() {
  document.querySelectorAll('.drop-placeholder').forEach((el) => el.remove());
  document.querySelectorAll('.cards.drag-over').forEach((el) =>
    el.classList.remove('drag-over')
  );
}

function attachListDnd(list, columnId) {
  list.addEventListener('dragover', (e) => {
    if (!draggingCardId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    list.classList.add('drag-over');
    showPlaceholder(list, e.clientY);
  });

  list.addEventListener('dragleave', (e) => {
    // Only clear when actually leaving the list (not entering a child).
    if (!list.contains(e.relatedTarget)) {
      list.classList.remove('drag-over');
    }
  });

  list.addEventListener('drop', (e) => {
    if (!draggingCardId) return;
    e.preventDefault();
    handleDrop(list, columnId, e.clientY);
  });
}

/**
 * Insert (or move) a placeholder element representing where the card would
 * land, based on cursor Y position relative to existing cards.
 */
function showPlaceholder(list, clientY) {
  let placeholder = list.querySelector('.drop-placeholder');
  if (!placeholder) {
    placeholder = document.createElement('li');
    placeholder.className = 'card drop-placeholder';
  }

  const afterEl = getCardAfter(list, clientY);
  if (afterEl == null) {
    list.appendChild(placeholder);
  } else {
    list.insertBefore(placeholder, afterEl);
  }
}

/**
 * Find the first card whose vertical midpoint is below clientY. The dragged
 * card and the placeholder are ignored.
 */
function getCardAfter(list, clientY) {
  const cards = [...list.querySelectorAll('.card:not(.dragging):not(.drop-placeholder)')];
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    if (clientY < midpoint) {
      return card;
    }
  }
  return null;
}

async function handleDrop(list, columnId, clientY) {
  const cardId = draggingCardId;
  if (!cardId) return;

  // Determine the neighbors at the drop location BEFORE mutating the model.
  const afterEl = getCardAfter(list, clientY);

  // beforeId: the card that should be just BELOW the dropped card.
  const beforeId = afterEl ? afterEl.dataset.cardId : null;

  // afterId: the card that should be just ABOVE the dropped card.
  let afterId = null;
  if (afterEl) {
    let prev = afterEl.previousElementSibling;
    while (prev && (prev.classList.contains('drop-placeholder') || prev.dataset.cardId === cardId)) {
      prev = prev.previousElementSibling;
    }
    afterId = prev ? prev.dataset.cardId : null;
  } else {
    // Dropped at the end: the last real card (excluding the dragged one).
    const existing = cardsForColumn(columnId).filter((c) => c.id !== cardId);
    afterId = existing.length ? existing[existing.length - 1].id : null;
  }

  clearPlaceholders();

  // --- Optimistic update: reposition the card in our model immediately. ---
  const optimisticPos = computeOptimisticPosition(columnId, afterId, beforeId, cardId);
  const card = state.cards.get(cardId);
  if (!card) return;
  const prevSnapshot = { column_id: card.column_id, position: card.position };
  card.column_id = columnId;
  card.position = optimisticPos;
  render();

  // --- Send intent to server; reconcile against canonical result. ---
  try {
    const { card: canonical, columns } = await moveCard(cardId, {
      columnId,
      beforeId,
      afterId,
    });
    // Reconcile: snap to server's authoritative position/column.
    upsertCard(canonical);
    if (columns) {
      for (const [colId, cards] of Object.entries(columns)) {
        applyColumnOrder(colId, cards);
      }
    }
    render();
  } catch (err) {
    console.error('Move failed, reverting:', err);
    const c = state.cards.get(cardId);
    if (c) {
      c.column_id = prevSnapshot.column_id;
      c.position = prevSnapshot.position;
    }
    render();
  }
}

/**
 * Mirror the server's fractional positioning so the optimistic guess closely
 * matches the canonical result, minimizing visible snapping.
 */
function computeOptimisticPosition(columnId, afterId, beforeId, movingId) {
  const STEP = 1000;
  const after = afterId ? state.cards.get(afterId) : null;
  const before = beforeId ? state.cards.get(beforeId) : null;
  const afterPos = after && after.column_id === columnId && after.id !== movingId ? after.position : null;
  const beforePos = before && before.column_id === columnId && before.id !== movingId ? before.position : null;

  if (afterPos == null && beforePos == null) return STEP;
  if (afterPos == null) return beforePos - STEP;
  if (beforePos == null) return afterPos + STEP;
  return (afterPos + beforePos) / 2;
}

// ---------------------------------------------------------------------------
// Realtime (SSE)
// ---------------------------------------------------------------------------

function setStatus(online) {
  statusEl.classList.toggle('status--online', online);
  statusEl.classList.toggle('status--offline', !online);
  statusEl.querySelector('.status__label').textContent = online
    ? 'live'
    : 'reconnecting…';
}

function connectStream() {
  const es = new EventSource('/api/stream');

  es.addEventListener('open', () => setStatus(true));

  es.addEventListener('error', () => setStatus(false));

  es.addEventListener('card-created', (e) => {
    const { card } = JSON.parse(e.data);
    upsertCard(card);
    render();
  });

  es.addEventListener('card-moved', (e) => {
    const { card, columns } = JSON.parse(e.data);
    // Don't override our own in-flight optimistic drag for the same card;
    // our move() response will reconcile it. But if it's a different card or
    // we're not dragging, apply the canonical state immediately.
    if (card.id === draggingCardId) {
      // Still apply the canonical state if a renormalization affected order.
      if (columns) {
        for (const [colId, cards] of Object.entries(columns)) {
          applyColumnOrder(colId, cards);
        }
      }
      return;
    }
    upsertCard(card);
    if (columns) {
      for (const [colId, cards] of Object.entries(columns)) {
        applyColumnOrder(colId, cards);
      }
    }
    render();
  });

  return es;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function init() {
  try {
    const board = await fetchBoard();
    state.columns = board.columns.map((c) => ({ id: c.id, title: c.title }));
    state.cards.clear();
    for (const column of board.columns) {
      for (const card of column.cards) {
        upsertCard(card);
      }
    }
    render();
  } catch (err) {
    console.error('Failed to load board:', err);
    boardEl.innerHTML = `<p style="color:var(--danger);padding:24px">Failed to load board: ${err.message}</p>`;
    return;
  }
  connectStream();
}

init();
