// Collaborative Kanban frontend.
//
// State model: we keep an authoritative-ish local model `state.columns`, a map
// of columnId -> ordered array of card objects { id, column_id, text, position }.
// The DOM is rendered from this model. Drag-and-drop performs an optimistic
// local update + DOM render, then PATCHes the server. SSE events carry the
// server's canonical ordered card lists which we snap to.

const boardEl = document.getElementById('board');
const connDot = document.getElementById('conn-dot');
const connText = document.getElementById('conn-text');

const state = {
  columnsOrder: [], // ordered column ids
  columnsMeta: new Map(), // id -> { id, title }
  cards: new Map(), // columnId -> [card,...] (ordered)
};

// -- API helpers --------------------------------------------------------------

async function fetchBoard() {
  const res = await fetch('/api/board');
  if (!res.ok) throw new Error('Failed to load board');
  return res.json();
}

async function apiCreateCard(columnId, text) {
  const res = await fetch('/api/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text }),
  });
  if (!res.ok) throw new Error('Failed to create card');
  return res.json();
}

async function apiMoveCard(cardId, payload) {
  const res = await fetch(`/api/cards/${encodeURIComponent(cardId)}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Failed to move card');
  return res.json();
}

// -- Model helpers ------------------------------------------------------------

function loadBoardIntoState(board) {
  state.columnsOrder = [];
  state.columnsMeta.clear();
  state.cards.clear();
  for (const col of board.columns) {
    state.columnsOrder.push(col.id);
    state.columnsMeta.set(col.id, { id: col.id, title: col.title });
    state.cards.set(col.id, col.cards.map(normalizeCard));
  }
}

function normalizeCard(c) {
  return {
    id: c.id,
    column_id: c.column_id,
    text: c.text,
    position: Number(c.position),
  };
}

// Remove a card from whatever column currently holds it. Guarantees a card is
// never present in two columns at once.
function removeCardEverywhere(cardId) {
  let removed = null;
  for (const [colId, list] of state.cards) {
    const idx = list.findIndex((c) => c.id === cardId);
    if (idx !== -1) {
      removed = list[idx];
      list.splice(idx, 1);
    }
  }
  return removed;
}

// Replace the full ordered card list for a column (canonical snap).
function setColumnCards(columnId, cards) {
  const normalized = cards.map(normalizeCard);
  // Ensure none of these cards remain in any other column.
  for (const c of normalized) {
    for (const [colId, list] of state.cards) {
      if (colId === columnId) continue;
      const idx = list.findIndex((x) => x.id === c.id);
      if (idx !== -1) list.splice(idx, 1);
    }
  }
  state.cards.set(columnId, normalized);
}

// -- Rendering ----------------------------------------------------------------

function render() {
  boardEl.innerHTML = '';
  for (const colId of state.columnsOrder) {
    boardEl.appendChild(renderColumn(colId));
  }
}

function renderColumn(colId) {
  const meta = state.columnsMeta.get(colId);
  const cards = state.cards.get(colId) || [];

  const column = el('section', 'column');
  column.dataset.columnId = colId;

  const header = el('div', 'column-header');
  header.append(text('span', meta.title));
  header.append(text('span', String(cards.length), 'column-count'));
  column.append(header);

  const list = el('ul', 'cards');
  list.dataset.columnId = colId;
  for (const card of cards) {
    list.append(renderCard(card));
  }
  attachListDnd(list);
  column.append(list);

  column.append(renderAddCard(colId));
  return column;
}

function renderCard(card) {
  const li = el('li', 'card');
  li.dataset.cardId = card.id;
  li.draggable = true;
  li.textContent = card.text;
  attachCardDnd(li);
  return li;
}

function renderAddCard(colId) {
  const wrap = el('div', 'add-card');
  const ta = document.createElement('textarea');
  ta.placeholder = 'New card…';
  ta.rows = 1;
  const btn = document.createElement('button');
  btn.textContent = 'Add card';

  async function submit() {
    const value = ta.value.trim();
    if (!value) return;
    ta.value = '';
    try {
      // The server broadcasts card:create (including to us), so we let the SSE
      // handler insert it to keep a single source of truth and avoid dupes.
      await apiCreateCard(colId, value);
    } catch (err) {
      console.error(err);
      ta.value = value;
    }
  }

  btn.addEventListener('click', submit);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  wrap.append(ta, btn);
  return wrap;
}

// -- DOM utilities ------------------------------------------------------------

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function text(tag, content, className) {
  const node = el(tag, className);
  node.textContent = content;
  return node;
}

// -- Drag and drop ------------------------------------------------------------

let dragState = null; // { cardId }

function attachCardDnd(li) {
  li.addEventListener('dragstart', (e) => {
    dragState = { cardId: li.dataset.cardId };
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', li.dataset.cardId);
  });
  li.addEventListener('dragend', () => {
    li.classList.remove('dragging');
    clearDropMarkers();
    dragState = null;
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
    if (e.target === list) list.classList.remove('drag-over');
  });
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    list.classList.remove('drag-over');
    const cardId = dragState?.cardId || e.dataTransfer.getData('text/plain');
    clearDropMarkers();
    if (!cardId) return;
    handleDrop(cardId, list, e.clientY);
  });
}

// Determine which existing card (if any) the pointer is above, to decide
// insertion point.
function getInsertionTarget(list, clientY) {
  const cards = [...list.querySelectorAll('.card:not(.dragging)')];
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      return card; // insert before this card
    }
  }
  return null; // append at the end
}

function showDropMarker(list, clientY) {
  clearDropMarkers();
  const target = getInsertionTarget(list, clientY);
  if (target) {
    target.classList.add('drop-before');
  } else {
    const cards = list.querySelectorAll('.card:not(.dragging)');
    const last = cards[cards.length - 1];
    if (last) last.classList.add('drop-after');
  }
}

function clearDropMarkers() {
  document
    .querySelectorAll('.drop-before, .drop-after')
    .forEach((n) => n.classList.remove('drop-before', 'drop-after'));
}

async function handleDrop(cardId, list, clientY) {
  const targetColumnId = list.dataset.columnId;
  const beforeCardEl = getInsertionTarget(list, clientY); // element we go before

  // Compute neighbor ids (afterId = above, beforeId = below) from current model.
  let beforeId = beforeCardEl ? beforeCardEl.dataset.cardId : null;

  // Optimistic local update.
  removeCardEverywhere(cardId);
  const moved = { id: cardId, column_id: targetColumnId, text: cardText(cardId), position: 0 };
  const list2 = state.cards.get(targetColumnId);
  let insertIndex;
  if (beforeId) {
    insertIndex = list2.findIndex((c) => c.id === beforeId);
    if (insertIndex === -1) insertIndex = list2.length;
  } else {
    insertIndex = list2.length;
  }
  list2.splice(insertIndex, 0, moved);

  const afterId = insertIndex > 0 ? list2[insertIndex - 1].id : null;
  beforeId = insertIndex + 1 < list2.length ? list2[insertIndex + 1].id : null;

  render();

  // Send intent to server. The SSE broadcast will deliver canonical state to
  // all clients (including us); we also snap to the PATCH response.
  try {
    const result = await apiMoveCard(cardId, {
      columnId: targetColumnId,
      afterId,
      beforeId,
    });
    if (result.columns) {
      for (const [colId, cards] of Object.entries(result.columns)) {
        setColumnCards(colId, cards);
      }
      render();
    }
  } catch (err) {
    console.error('Move failed, reloading authoritative state', err);
    await reload();
  }
}

// Recover a card's text from the model or DOM (it may be mid-move).
function cardText(cardId) {
  for (const list of state.cards.values()) {
    const found = list.find((c) => c.id === cardId);
    if (found) return found.text;
  }
  const node = boardEl.querySelector(`.card[data-card-id="${CSS.escape(cardId)}"]`);
  return node ? node.textContent : '';
}

// -- SSE realtime sync --------------------------------------------------------

let eventSource = null;

function connectStream() {
  eventSource = new EventSource('/api/stream');

  eventSource.addEventListener('hello', () => setConnected(true));
  eventSource.addEventListener('open', () => setConnected(true));
  eventSource.onopen = () => setConnected(true);

  eventSource.onerror = () => {
    setConnected(false);
    // EventSource auto-reconnects; nothing else to do.
  };

  eventSource.addEventListener('card:create', (e) => {
    const { card } = JSON.parse(e.data);
    onRemoteCreate(normalizeCard(card));
  });

  eventSource.addEventListener('card:move', (e) => {
    const data = JSON.parse(e.data);
    onRemoteMove(data);
  });
}

function onRemoteCreate(card) {
  // Idempotent: if the card already exists anywhere, update it; else append.
  const existing = findCard(card.id);
  if (existing) {
    // Already present (e.g. our own optimistic create) — ensure correct column.
    removeCardEverywhere(card.id);
  }
  const list = state.cards.get(card.column_id);
  if (!list) return;
  // Insert in position order (it was appended at end, but be safe).
  list.push(card);
  list.sort((a, b) => a.position - b.position);
  render();
}

function onRemoteMove(data) {
  // The authoritative payload includes full ordered card lists for every
  // affected column. Snap to those, guaranteeing the card is in exactly one
  // place across all clients.
  if (data.columns) {
    for (const [colId, cards] of Object.entries(data.columns)) {
      setColumnCards(colId, cards);
    }
  } else if (data.card) {
    // Fallback: at least relocate the single card.
    removeCardEverywhere(data.card.id);
    const list = state.cards.get(data.card.column_id);
    if (list) {
      list.push(normalizeCard(data.card));
      list.sort((a, b) => a.position - b.position);
    }
  }
  render();
}

function findCard(cardId) {
  for (const list of state.cards.values()) {
    const found = list.find((c) => c.id === cardId);
    if (found) return found;
  }
  return null;
}

function setConnected(online) {
  connDot.classList.toggle('online', online);
  connText.textContent = online ? 'live' : 'reconnecting…';
}

// -- Bootstrap ----------------------------------------------------------------

async function reload() {
  const board = await fetchBoard();
  loadBoardIntoState(board);
  render();
}

async function init() {
  try {
    await reload();
  } catch (err) {
    console.error(err);
    boardEl.textContent = 'Failed to load board. Is the server running?';
    return;
  }
  connectStream();
}

init();
