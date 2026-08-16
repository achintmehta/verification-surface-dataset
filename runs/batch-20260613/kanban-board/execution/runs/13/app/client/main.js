import { fetchBoard, createCard, moveCard } from './api.js';

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');

/**
 * Client-side model. The single source of truth for rendering.
 *   columns: [{ id, title, position, cards: [{ id, columnId, text, position }] }]
 * Rendering is always derived from this model, so a card can never appear
 * in two columns: it lives in exactly one column's `cards` array.
 */
const state = {
  columns: [],
  columnIndex: new Map(), // columnId -> column object
  cardIndex: new Map(),   // cardId -> card object
};

// ---------------------------------------------------------------------------
// Model helpers
// ---------------------------------------------------------------------------

function reindex() {
  state.columnIndex = new Map();
  state.cardIndex = new Map();
  for (const col of state.columns) {
    state.columnIndex.set(col.id, col);
    for (const card of col.cards) {
      card.columnId = col.id;
      state.cardIndex.set(card.id, card);
    }
  }
}

function sortColumnCards(col) {
  col.cards.sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    return String(a.id).localeCompare(String(b.id));
  });
}

function removeCardFromModel(cardId) {
  for (const col of state.columns) {
    const i = col.cards.findIndex((c) => c.id === cardId);
    if (i !== -1) {
      const [card] = col.cards.splice(i, 1);
      return card;
    }
  }
  return null;
}

/**
 * Insert/replace a card into a column at its sorted position, ensuring it
 * exists in exactly one column. Idempotent for the same canonical state.
 */
function upsertCard(card) {
  const existing = state.cardIndex.get(card.id);
  if (existing) {
    // Remove from wherever it currently is.
    removeCardFromModel(card.id);
  }
  const col = state.columnIndex.get(card.columnId);
  if (!col) return; // unknown column; ignore
  col.cards.push({ ...card });
  sortColumnCards(col);
  reindex();
}

/** Replace an entire column's card list (used for server renormalization). */
function replaceColumnCards(columnId, cards) {
  const col = state.columnIndex.get(columnId);
  if (!col) return;
  // Remove these cards from any column they might currently be in.
  for (const c of cards) removeCardFromModel(c.id);
  col.cards = cards.map((c) => ({ ...c, columnId }));
  sortColumnCards(col);
  reindex();
}

// ---------------------------------------------------------------------------
// Rendering (full re-render from model — cheap for board-sized data)
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

  const title = document.createElement('div');
  title.className = 'column__title';
  title.textContent = col.title;
  colEl.appendChild(title);

  const list = document.createElement('ul');
  list.className = 'column__cards';
  list.dataset.columnId = col.id;
  for (const card of col.cards) {
    list.appendChild(renderCard(card));
  }
  attachListDnd(list);
  colEl.appendChild(list);

  colEl.appendChild(renderAddCard(col.id));
  return colEl;
}

function renderCard(card) {
  const li = document.createElement('li');
  li.className = 'card';
  li.draggable = true;
  li.dataset.cardId = card.id;
  li.textContent = card.text;
  attachCardDnd(li);
  return li;
}

function renderAddCard(columnId) {
  const wrap = document.createElement('div');
  wrap.className = 'add-card';

  const trigger = document.createElement('button');
  trigger.className = 'add-card__trigger';
  trigger.type = 'button';
  trigger.textContent = '+ Add a card';

  const form = document.createElement('form');
  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Enter a title for this card…';
  const actions = document.createElement('div');
  actions.className = 'add-card__actions';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Add card';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'cancel';
  cancel.setAttribute('aria-label', 'Cancel');
  cancel.textContent = '×';
  actions.append(submit, cancel);
  form.append(textarea, actions);

  trigger.addEventListener('click', () => {
    wrap.classList.add('editing');
    textarea.focus();
  });
  const close = () => {
    wrap.classList.remove('editing');
    textarea.value = '';
  };
  cancel.addEventListener('click', close);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    } else if (e.key === 'Escape') {
      close();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = '';
    try {
      // The created card will arrive via SSE and be upserted; we also
      // upsert from the response so the local client feels instant.
      const { card } = await createCard(columnId, text);
      upsertCard(card);
      render();
    } catch (err) {
      console.error('Create card failed:', err);
      textarea.value = text;
    }
  });

  wrap.append(trigger, form);
  return wrap;
}

// ---------------------------------------------------------------------------
// Drag & drop
// ---------------------------------------------------------------------------

let dragCardId = null;

function attachCardDnd(cardEl) {
  cardEl.addEventListener('dragstart', (e) => {
    dragCardId = cardEl.dataset.cardId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragCardId);
    requestAnimationFrame(() => cardEl.classList.add('dragging'));
  });
  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('dragging');
    dragCardId = null;
    clearPlaceholders();
  });
}

function attachListDnd(list) {
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    list.classList.add('drag-over');
    showPlaceholder(list, e.clientY);
  });
  list.addEventListener('dragleave', (e) => {
    // Only clear if we truly left the list region.
    if (!list.contains(e.relatedTarget)) {
      list.classList.remove('drag-over');
    }
  });
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    list.classList.remove('drag-over');
    const cardId = dragCardId || e.dataTransfer.getData('text/plain');
    if (!cardId) return;
    handleDrop(cardId, list, e.clientY);
  });
}

function getDragAfterElement(list, y) {
  const els = [...list.querySelectorAll('.card:not(.dragging)')];
  let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
  for (const el of els) {
    const box = el.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      closest = { offset, element: el };
    }
  }
  return closest.element;
}

function clearPlaceholders() {
  document.querySelectorAll('.card-placeholder').forEach((p) => p.remove());
  document.querySelectorAll('.column__cards.drag-over').forEach((l) => l.classList.remove('drag-over'));
}

function showPlaceholder(list, y) {
  let ph = document.querySelector('.card-placeholder');
  if (!ph) {
    ph = document.createElement('li');
    ph.className = 'card-placeholder';
  }
  const afterEl = getDragAfterElement(list, y);
  if (afterEl == null) list.appendChild(ph);
  else list.insertBefore(ph, afterEl);
}

/**
 * On drop: compute target column + neighbor ids, optimistically update the
 * model/DOM, then PATCH the server and reconcile against canonical state.
 */
async function handleDrop(cardId, list, y) {
  const columnId = list.dataset.columnId;
  const afterEl = getDragAfterElement(list, y);

  // Determine the neighbor ids in the TARGET column, excluding the moving card.
  const col = state.columnIndex.get(columnId);
  if (!col) return;
  const siblings = col.cards.filter((c) => c.id !== cardId);

  let beforeId = null; // the card the moved card should precede
  let afterId = null;  // the card the moved card should follow

  if (afterEl == null) {
    // Dropped at the end.
    afterId = siblings.length ? siblings[siblings.length - 1].id : null;
    beforeId = null;
  } else {
    beforeId = afterEl.dataset.cardId;
    const idx = siblings.findIndex((c) => c.id === beforeId);
    afterId = idx > 0 ? siblings[idx - 1].id : null;
  }

  clearPlaceholders();

  // --- Optimistic update ---
  const moving = state.cardIndex.get(cardId);
  if (!moving) return;
  const optimisticPos = optimisticPosition(columnId, afterId, beforeId, cardId);
  removeCardFromModel(cardId);
  moving.columnId = columnId;
  moving.position = optimisticPos;
  col.cards.push(moving);
  sortColumnCards(col);
  reindex();
  render();

  // --- Send intent & reconcile ---
  try {
    const { card, normalizedColumn } = await moveCard(cardId, { columnId, beforeId, afterId });
    if (normalizedColumn) {
      replaceColumnCards(normalizedColumn.columnId, normalizedColumn.cards);
    }
    // Snap to the server's canonical position.
    upsertCard(card);
    render();
  } catch (err) {
    console.error('Move failed, resyncing:', err);
    await loadBoard();
  }
}

function optimisticPosition(columnId, afterId, beforeId, movingId) {
  const col = state.columnIndex.get(columnId);
  const list = col.cards.filter((c) => c.id !== movingId);
  const after = afterId ? list.find((c) => c.id === afterId) : null;
  const before = beforeId ? list.find((c) => c.id === beforeId) : null;
  const a = after ? after.position : null;
  const b = before ? before.position : null;
  if (a == null && b == null) return 1000;
  if (a == null) return b - 1000;
  if (b == null) return a + 1000;
  return (a + b) / 2;
}

// ---------------------------------------------------------------------------
// Real-time sync (SSE)
// ---------------------------------------------------------------------------

function connectStream() {
  const es = new EventSource('/api/stream');

  es.addEventListener('open', () => setStatus(true));
  es.addEventListener('error', () => setStatus(false));

  es.addEventListener('card:create', (e) => {
    const { card } = JSON.parse(e.data);
    upsertCard(card);
    render();
  });

  es.addEventListener('card:move', (e) => {
    const { card, normalizedColumn } = JSON.parse(e.data);
    if (normalizedColumn) {
      replaceColumnCards(normalizedColumn.columnId, normalizedColumn.cards);
    }
    upsertCard(card);
    render();
  });

  return es;
}

function setStatus(online) {
  statusEl.textContent = online ? 'live' : 'reconnecting…';
  statusEl.className = 'status ' + (online ? 'status--online' : 'status--offline');
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function loadBoard() {
  const { columns } = await fetchBoard();
  state.columns = columns.map((col) => ({
    ...col,
    cards: col.cards.map((c) => ({ ...c })),
  }));
  reindex();
  for (const col of state.columns) sortColumnCards(col);
  render();
}

async function init() {
  try {
    await loadBoard();
  } catch (err) {
    console.error('Initial load failed:', err);
  }
  connectStream();
}

init();
