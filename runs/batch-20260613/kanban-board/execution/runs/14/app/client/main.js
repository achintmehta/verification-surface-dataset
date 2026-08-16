// Collaborative Kanban frontend.
// - Renders board from GET /api/board
// - Drag-and-drop with optimistic DOM update + PATCH /api/cards/:id/move
// - EventSource SSE stream reconciles all clients to canonical server state.

const API = '/api';

/**
 * Local model: a map of columnId -> { id, title, position, cards: Map(id -> card) }
 * We keep card order via the `position` field and sort on render.
 */
const state = {
  columns: new Map(), // columnId -> { id, title, position }
  cards: new Map() // cardId -> { id, column_id, text, position, created_at }
};

const boardEl = document.getElementById('board');
const connEl = document.getElementById('connection');

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function loadBoard() {
  const res = await fetch(`${API}/board`);
  const data = await res.json();
  state.columns.clear();
  state.cards.clear();
  for (const col of data.columns) {
    state.columns.set(col.id, { id: col.id, title: col.title, position: col.position });
    for (const card of col.cards) {
      state.cards.set(card.id, card);
    }
  }
  render();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function columnsSorted() {
  return [...state.columns.values()].sort(
    (a, b) => a.position - b.position || (a.id < b.id ? -1 : 1)
  );
}

function cardsForColumn(columnId) {
  const list = [];
  for (const card of state.cards.values()) {
    if (card.column_id === columnId) list.push(card);
  }
  return list.sort(
    (a, b) =>
      a.position - b.position ||
      cmp(a.created_at, b.created_at) ||
      (a.id < b.id ? -1 : 1)
  );
}

function cmp(a, b) {
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
  return ta - tb;
}

function render() {
  boardEl.innerHTML = '';
  for (const col of columnsSorted()) {
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
  header.innerHTML = `<span>${escapeHtml(col.title)}</span><span class="count">${cards.length}</span>`;
  colEl.appendChild(header);

  const list = document.createElement('ul');
  list.className = 'card-list';
  list.dataset.columnId = col.id;
  attachListDnd(list);

  for (const card of cards) {
    list.appendChild(renderCard(card));
  }
  colEl.appendChild(list);

  // Add-card form
  const adder = document.createElement('div');
  adder.className = 'add-card';
  const textarea = document.createElement('textarea');
  textarea.placeholder = 'New card…';
  textarea.rows = 1;
  const btn = document.createElement('button');
  btn.textContent = '+ Add card';
  const submit = async () => {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = '';
    await createCard(col.id, text);
  };
  btn.addEventListener('click', submit);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  });
  adder.appendChild(textarea);
  adder.appendChild(btn);
  colEl.appendChild(adder);

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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ---------------------------------------------------------------------------
// Drag and drop
// ---------------------------------------------------------------------------
let draggingId = null;

function attachCardDnd(li) {
  li.addEventListener('dragstart', (e) => {
    draggingId = li.dataset.cardId;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', draggingId);
  });
  li.addEventListener('dragend', () => {
    li.classList.remove('dragging');
    clearDropMarkers();
    draggingId = null;
  });
}

function attachListDnd(list) {
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    list.classList.add('drag-over');
    showDropMarker(list, e.clientY);
  });
  list.addEventListener('dragleave', (e) => {
    // Only clear if leaving the list entirely.
    if (!list.contains(e.relatedTarget)) {
      list.classList.remove('drag-over');
      clearDropMarkers();
    }
  });
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    list.classList.remove('drag-over');
    const cardId = draggingId || e.dataTransfer.getData('text/plain');
    clearDropMarkers();
    if (!cardId) return;
    handleDrop(cardId, list, e.clientY);
  });
}

function clearDropMarkers() {
  document
    .querySelectorAll('.drop-before, .drop-after')
    .forEach((el) => el.classList.remove('drop-before', 'drop-after'));
}

// Find the card the cursor is hovering relative to, for visual marker.
function showDropMarker(list, clientY) {
  clearDropMarkers();
  const ref = getDropReference(list, clientY);
  if (ref.before) {
    ref.before.classList.add('drop-before');
  } else if (ref.after) {
    ref.after.classList.add('drop-after');
  }
}

/**
 * Determine the insertion point in a list given the cursor Y.
 * Returns { before, after } DOM nodes (the card that will be below / above
 * the dropped card). Excludes the currently dragging card.
 */
function getDropReference(list, clientY) {
  const cards = [...list.querySelectorAll('.card')].filter(
    (c) => c.dataset.cardId !== draggingId
  );
  let before = null; // the card that will be directly AFTER the dropped one
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    if (clientY < midpoint) {
      before = card;
      break;
    }
  }
  let after = null; // the card directly BEFORE the dropped one
  if (before) {
    const idx = cards.indexOf(before);
    after = idx > 0 ? cards[idx - 1] : null;
  } else {
    after = cards.length ? cards[cards.length - 1] : null;
  }
  return { before, after };
}

async function handleDrop(cardId, list, clientY) {
  const columnId = list.dataset.columnId;
  const { before, after } = getDropReference(list, clientY);
  const beforeId = before ? before.dataset.cardId : null;
  const afterId = after ? after.dataset.cardId : null;

  // No-op guard: dropping in exactly the same place.
  // (Still send to server to be safe with concurrency, but optimistic update
  // is cheap and idempotent.)

  // --- Optimistic update of local model ---
  optimisticMove(cardId, columnId, beforeId, afterId);
  render();

  // --- Send intent to server ---
  try {
    const res = await fetch(`${API}/cards/${cardId}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId })
    });
    if (!res.ok) throw new Error(`move failed: ${res.status}`);
    const data = await res.json();
    // Reconcile against canonical server position.
    applyServerCard(data.card);
    if (data.normalizedColumns) {
      for (const nc of data.normalizedColumns) applyNormalizedColumn(nc);
    }
    render();
  } catch (err) {
    console.error(err);
    // On failure, reload authoritative state.
    await loadBoard();
  }
}

/**
 * Compute an optimistic fractional position client-side so the card snaps to
 * the dropped slot immediately, before the server responds.
 */
function optimisticMove(cardId, columnId, beforeId, afterId) {
  const card = state.cards.get(cardId);
  if (!card) return;
  const afterCard = afterId ? state.cards.get(afterId) : null;
  const beforeCard = beforeId ? state.cards.get(beforeId) : null;

  let pos;
  if (afterCard && beforeCard) {
    pos = (afterCard.position + beforeCard.position) / 2;
  } else if (afterCard) {
    pos = afterCard.position + 1024;
  } else if (beforeCard) {
    pos = beforeCard.position / 2;
  } else {
    pos = 1024;
  }
  card.column_id = columnId;
  card.position = pos;
}

// ---------------------------------------------------------------------------
// Server reconciliation
// ---------------------------------------------------------------------------
function applyServerCard(card) {
  const existing = state.cards.get(card.id) || {};
  state.cards.set(card.id, { ...existing, ...card });
}

function applyNormalizedColumn(nc) {
  // Replace all positions for cards in this column with canonical values.
  for (const card of nc.cards) {
    applyServerCard(card);
  }
}

// ---------------------------------------------------------------------------
// Create card
// ---------------------------------------------------------------------------
async function createCard(columnId, text) {
  try {
    const res = await fetch(`${API}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text })
    });
    if (!res.ok) throw new Error(`create failed: ${res.status}`);
    const data = await res.json();
    // The SSE broadcast will also deliver this; applying here too is idempotent.
    applyServerCard(data.card);
    render();
  } catch (err) {
    console.error(err);
    await loadBoard();
  }
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------
function connectStream() {
  const es = new EventSource(`${API}/stream`);

  es.addEventListener('hello', () => setConnection(true));

  es.addEventListener('card-created', (e) => {
    const { card } = JSON.parse(e.data);
    const isNew = !state.cards.has(card.id);
    applyServerCard(card);
    render();
    if (isNew) flashCard(card.id);
  });

  es.addEventListener('card-moved', (e) => {
    const { card } = JSON.parse(e.data);
    applyServerCard(card);
    render();
  });

  es.addEventListener('column-normalized', (e) => {
    const nc = JSON.parse(e.data);
    applyNormalizedColumn(nc);
    render();
  });

  es.onopen = () => setConnection(true);
  es.onerror = () => {
    setConnection(false);
    // EventSource auto-reconnects; nothing else to do.
  };
}

function setConnection(online) {
  connEl.textContent = online ? 'live' : 'reconnecting…';
  connEl.className = `badge ${online ? 'online' : 'offline'}`;
}

function flashCard(cardId) {
  // After render, briefly highlight the card.
  requestAnimationFrame(() => {
    const el = boardEl.querySelector(`[data-card-id="${CSS.escape(cardId)}"]`);
    if (el) {
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 600);
    }
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function main() {
  await loadBoard();
  connectStream();
}

main().catch((err) => {
  console.error('init failed', err);
});
