import { fetchBoard, createCard, moveCard } from './api.js';

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');

// --- Local model ---------------------------------------------------------
// We keep an authoritative-ish local model keyed by id. Cards carry their
// canonical position from the server; rendering always sorts by position then
// id so ordering is total and stable and matches the server.

const state = {
  columns: [], // [{ id, title, position }]
  cards: new Map() // id -> { id, column_id, text, position, created_at }
};

let dragCardId = null;

// --- Rendering -----------------------------------------------------------

function cardsForColumn(columnId) {
  const list = [];
  for (const card of state.cards.values()) {
    if (card.column_id === columnId) list.push(card);
  }
  list.sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    return a.id - b.id;
  });
  return list;
}

function render() {
  boardEl.innerHTML = '';
  const cols = [...state.columns].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    return a.id - b.id;
  });

  for (const col of cols) {
    const colEl = document.createElement('section');
    colEl.className = 'column';
    colEl.dataset.columnId = col.id;

    const titleEl = document.createElement('h2');
    titleEl.className = 'column__title';
    titleEl.textContent = col.title;
    colEl.appendChild(titleEl);

    const listEl = document.createElement('ul');
    listEl.className = 'cards';
    listEl.dataset.columnId = col.id;
    attachListDnd(listEl, col.id);

    for (const card of cardsForColumn(col.id)) {
      listEl.appendChild(renderCard(card));
    }
    colEl.appendChild(listEl);

    colEl.appendChild(renderAddForm(col.id));
    boardEl.appendChild(colEl);
  }
}

function renderCard(card) {
  const li = document.createElement('li');
  li.className = 'card';
  li.draggable = true;
  li.dataset.cardId = card.id;
  li.textContent = card.text;

  li.addEventListener('dragstart', (e) => {
    dragCardId = card.id;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(card.id));
  });
  li.addEventListener('dragend', () => {
    dragCardId = null;
    li.classList.remove('dragging');
    clearDropMarkers();
  });
  return li;
}

function renderAddForm(columnId) {
  const wrap = document.createElement('div');
  wrap.className = 'column__add';
  const form = document.createElement('form');
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Add a card…';
  const button = document.createElement('button');
  button.type = 'submit';
  button.textContent = '+';
  form.append(input, button);
  wrap.appendChild(form);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      // Server creates and broadcasts; our own SSE event will add the card.
      await createCard(columnId, text);
    } catch (err) {
      console.error(err);
    }
  });
  return wrap;
}

// --- Drag and drop -------------------------------------------------------

function clearDropMarkers() {
  document
    .querySelectorAll('.drop-before, .drop-after')
    .forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  document
    .querySelectorAll('.cards.drag-over')
    .forEach((el) => el.classList.remove('drag-over'));
}

/**
 * Given a list element and the pointer y position, find the card element the
 * dragged card should be inserted *before* (or null to append).
 */
function getDropTarget(listEl, y) {
  const cards = [...listEl.querySelectorAll('.card:not(.dragging)')];
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) {
      return card;
    }
  }
  return null;
}

function attachListDnd(listEl, columnId) {
  listEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDropMarkers();
    listEl.classList.add('drag-over');
    const before = getDropTarget(listEl, e.clientY);
    if (before) before.classList.add('drop-before');
  });

  listEl.addEventListener('dragleave', (e) => {
    if (e.target === listEl) listEl.classList.remove('drag-over');
  });

  listEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    clearDropMarkers();
    const cardId = dragCardId;
    dragCardId = null;
    if (cardId == null) return;

    const beforeEl = getDropTarget(listEl, e.clientY);
    const beforeId = beforeEl ? Number(beforeEl.dataset.cardId) : null;

    // afterId is the card immediately above the drop slot.
    const ordered = cardsForColumn(columnId).filter((c) => c.id !== cardId);
    let afterId = null;
    if (beforeId == null) {
      afterId = ordered.length ? ordered[ordered.length - 1].id : null;
    } else {
      const idx = ordered.findIndex((c) => c.id === beforeId);
      afterId = idx > 0 ? ordered[idx - 1].id : null;
    }

    // Optimistic update: place card locally between after/before.
    applyOptimisticMove(cardId, columnId, beforeId, afterId);
    render();

    try {
      const result = await moveCard(cardId, { columnId, beforeId, afterId });
      reconcileMove(result);
    } catch (err) {
      console.error(err);
      // On failure, refetch authoritative state.
      await reload();
    }
  });
}

/**
 * Optimistically reposition the card by computing a midpoint position
 * locally. The server will send back the canonical position which we then
 * snap to.
 */
function applyOptimisticMove(cardId, columnId, beforeId, afterId) {
  const card = state.cards.get(cardId);
  if (!card) return;
  const siblings = cardsForColumn(columnId).filter((c) => c.id !== cardId);

  const afterCard = afterId != null ? siblings.find((c) => c.id === afterId) : null;
  const beforeCard =
    beforeId != null ? siblings.find((c) => c.id === beforeId) : null;

  let lower = afterCard
    ? afterCard.position
    : siblings.length
    ? siblings[0].position - 1000
    : 0;
  let upper = beforeCard
    ? beforeCard.position
    : siblings.length
    ? siblings[siblings.length - 1].position + 1000
    : 1000;
  if (lower >= upper) {
    lower = 0;
    upper = 1000;
  }

  card.column_id = columnId;
  card.position = (lower + upper) / 2;
}

// --- Reconciliation against canonical server state -----------------------

function upsertCard(card) {
  const normalized = {
    ...card,
    id: Number(card.id),
    column_id: Number(card.column_id),
    position: Number(card.position)
  };
  state.cards.set(normalized.id, normalized);
}

function reconcileMove(result) {
  if (!result) return;
  if (result.card) upsertCard(result.card);
  if (result.columnCards) {
    for (const c of result.columnCards) upsertCard(c);
  }
  render();
}

function applyRenormalize(columnId, cards) {
  // Remove any local cards for this column then re-add canonical ones,
  // so a card never lingers in the wrong column.
  for (const [id, card] of state.cards) {
    if (card.column_id === Number(columnId)) state.cards.delete(id);
  }
  for (const c of cards) upsertCard(c);
  render();
}

// --- SSE ----------------------------------------------------------------

function connectSSE() {
  const es = new EventSource('/api/stream');

  es.onopen = () => setStatus('connected');
  es.onerror = () => setStatus('disconnected');

  es.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    handleEvent(msg);
  };
}

function handleEvent(msg) {
  switch (msg.type) {
    case 'connected':
      setStatus('connected');
      break;
    case 'card:create':
      upsertCard(msg.payload.card);
      render();
      break;
    case 'card:move':
      // Canonical move: card now belongs to exactly one column/position.
      upsertCard(msg.payload.card);
      render();
      break;
    case 'column:renormalize':
      applyRenormalize(msg.payload.columnId, msg.payload.cards);
      break;
    default:
      break;
  }
}

function setStatus(kind) {
  statusEl.className = `status status--${kind}`;
  statusEl.textContent = kind;
}

// --- Bootstrap -----------------------------------------------------------

async function reload() {
  const data = await fetchBoard();
  state.columns = data.columns.map((c) => ({
    id: Number(c.id),
    title: c.title,
    position: Number(c.position)
  }));
  state.cards = new Map();
  for (const col of data.columns) {
    for (const card of col.cards) upsertCard(card);
  }
  render();
}

async function init() {
  setStatus('connecting');
  await reload();
  connectSSE();
}

init().catch((err) => {
  console.error(err);
  setStatus('disconnected');
});
