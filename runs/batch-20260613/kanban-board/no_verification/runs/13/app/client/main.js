// Collaborative Kanban frontend.
// State is kept as a simple in-memory model and rendered to the DOM.
// Optimistic updates are applied immediately on drop, then reconciled
// against the authoritative server state delivered via SSE / the PATCH
// response.

const API = '/api';

// --- Model ---------------------------------------------------------------

/** @type {{ columns: Array<{id,title,position,cards: Array}> }} */
let state = { columns: [] };

function findCard(cardId) {
  for (const col of state.columns) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) return { col, idx, card: col.cards[idx] };
  }
  return null;
}

function getColumn(columnId) {
  return state.columns.find((c) => c.id === columnId) || null;
}

/** Remove a card from wherever it currently lives. */
function removeCard(cardId) {
  const found = findCard(cardId);
  if (found) {
    found.col.cards.splice(found.idx, 1);
  }
  return found ? found.card : null;
}

/**
 * Upsert a card into the model at the position implied by `position`,
 * ensuring it appears in exactly one column. The card object always carries
 * the canonical columnId and position.
 */
function upsertCard(card) {
  const existing = findCard(card.id);
  const merged = {
    id: card.id,
    columnId: card.columnId,
    text: card.text != null ? card.text : existing?.card.text ?? '',
    position: card.position
  };
  // Remove from current location (any column).
  removeCard(card.id);
  const col = getColumn(merged.columnId);
  if (!col) return;
  col.cards.push(merged);
  sortColumn(col);
}

function sortColumn(col) {
  col.cards.sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Apply a full canonical ordering for a column (used on renormalize). */
function applyColumnOrder(columnId, cards) {
  const col = getColumn(columnId);
  if (!col) return;
  // Remove all these cards from any column they might currently be in.
  for (const c of cards) removeCard(c.id);
  col.cards = cards.map((c) => ({
    id: c.id,
    columnId: c.columnId,
    text: c.text,
    position: c.position
  }));
  sortColumn(col);
}

// --- Rendering -----------------------------------------------------------

const boardEl = document.getElementById('board');

function render() {
  boardEl.innerHTML = '';
  for (const col of state.columns) {
    boardEl.appendChild(renderColumn(col));
  }
}

function renderColumn(col) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = col.id;

  const header = document.createElement('div');
  header.className = 'column-header';
  header.innerHTML = `<span>${escapeHtml(col.title)}</span><span class="count">${col.cards.length}</span>`;
  colEl.appendChild(header);

  const list = document.createElement('div');
  list.className = 'card-list';
  list.dataset.columnId = col.id;
  for (const card of col.cards) {
    list.appendChild(renderCard(card));
  }
  attachListDnD(list);
  colEl.appendChild(list);

  colEl.appendChild(renderAddCard(col));
  return colEl;
}

function renderCard(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.dataset.cardId = card.id;
  el.textContent = card.text;
  attachCardDnD(el);
  return el;
}

function renderAddCard(col) {
  const wrap = document.createElement('div');
  wrap.className = 'add-card';

  const btn = document.createElement('button');
  btn.textContent = '+ Add a card';
  btn.addEventListener('click', () => openComposer(wrap, col.id));
  wrap.appendChild(btn);
  return wrap;
}

function openComposer(wrap, columnId) {
  wrap.innerHTML = '';
  const ta = document.createElement('textarea');
  ta.placeholder = 'Enter a title for this card…';
  wrap.appendChild(ta);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const add = document.createElement('button');
  add.className = 'primary';
  add.textContent = 'Add card';
  const cancel = document.createElement('button');
  cancel.className = 'cancel';
  cancel.innerHTML = '&times;';
  actions.append(add, cancel);
  wrap.appendChild(actions);

  ta.focus();

  const submit = async () => {
    const text = ta.value.trim();
    if (text) {
      await createCard(columnId, text);
    }
    closeComposer(wrap, columnId);
  };
  add.addEventListener('click', submit);
  cancel.addEventListener('click', () => closeComposer(wrap, columnId));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      closeComposer(wrap, columnId);
    }
  });
}

function closeComposer(wrap, columnId) {
  const col = getColumn(columnId);
  if (!col) return;
  const fresh = renderAddCard(col);
  wrap.replaceWith(fresh);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// --- Drag and drop -------------------------------------------------------

let dragState = null; // { cardId }

function attachCardDnD(el) {
  el.addEventListener('dragstart', (e) => {
    dragState = { cardId: el.dataset.cardId };
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', el.dataset.cardId);
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    clearDropMarkers();
    dragState = null;
  });
}

function attachListDnD(list) {
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    list.classList.add('drag-over');
    showDropTarget(list, e.clientY);
  });
  list.addEventListener('dragleave', (e) => {
    if (!list.contains(e.relatedTarget)) {
      list.classList.remove('drag-over');
    }
  });
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    list.classList.remove('drag-over');
    if (!dragState) return;
    const columnId = list.dataset.columnId;
    const { afterId, beforeId } = computeNeighbours(list, e.clientY, dragState.cardId);
    clearDropMarkers();
    handleDrop(dragState.cardId, columnId, afterId, beforeId);
  });
}

function clearDropMarkers() {
  document
    .querySelectorAll('.drop-before, .drop-after')
    .forEach((el) => el.classList.remove('drop-before', 'drop-after'));
}

function showDropTarget(list, y) {
  clearDropMarkers();
  const after = getCardAfterY(list, y);
  if (after) {
    after.classList.add('drop-before');
  } else {
    const cards = [...list.querySelectorAll('.card:not(.dragging)')];
    if (cards.length) cards[cards.length - 1].classList.add('drop-after');
  }
}

/** Returns the card element that should come AFTER the drop point. */
function getCardAfterY(list, y) {
  const cards = [...list.querySelectorAll('.card:not(.dragging)')];
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) {
      return card;
    }
  }
  return null;
}

/**
 * Determine the neighbour ids around the drop point.
 * afterId: the card immediately before the drop slot.
 * beforeId: the card immediately after the drop slot.
 */
function computeNeighbours(list, y, movingId) {
  const cards = [...list.querySelectorAll('.card')].filter(
    (c) => c.dataset.cardId !== movingId
  );
  const afterEl = getCardAfterY(list, y);
  let beforeId = null;
  let afterId = null;
  if (afterEl && afterEl.dataset.cardId !== movingId) {
    beforeId = afterEl.dataset.cardId;
    const idx = cards.indexOf(afterEl);
    afterId = idx > 0 ? cards[idx - 1].dataset.cardId : null;
  } else {
    // Drop at the end.
    afterId = cards.length ? cards[cards.length - 1].dataset.cardId : null;
    beforeId = null;
  }
  return { afterId, beforeId };
}

// --- Optimistic move + server reconcile ----------------------------------

async function handleDrop(cardId, columnId, afterId, beforeId) {
  const found = findCard(cardId);
  if (!found) return;

  // Optimistically compute a tentative position so the card jumps to the
  // right slot immediately.
  optimisticMove(cardId, columnId, afterId, beforeId);
  render();

  // Send intent to the server; reconcile with the canonical answer.
  try {
    const res = await fetch(`${API}/cards/${cardId}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, afterId, beforeId })
    });
    if (!res.ok) throw new Error('move failed');
    const data = await res.json();
    reconcileMove(data);
    render();
  } catch (err) {
    // On failure, reload the authoritative board.
    console.error(err);
    await loadBoard();
  }
}

function optimisticMove(cardId, columnId, afterId, beforeId) {
  const card = removeCard(cardId);
  if (!card) return;
  const col = getColumn(columnId);
  if (!col) return;

  const afterPos = afterId ? col.cards.find((c) => c.id === afterId)?.position : undefined;
  const beforePos = beforeId ? col.cards.find((c) => c.id === beforeId)?.position : undefined;

  let pos;
  if (afterPos === undefined && beforePos === undefined) {
    const max = col.cards.reduce((m, c) => Math.max(m, c.position), 0);
    pos = max + 1000;
  } else if (afterPos === undefined) {
    pos = beforePos - 500;
  } else if (beforePos === undefined) {
    pos = afterPos + 1000;
  } else {
    pos = (afterPos + beforePos) / 2;
  }

  card.columnId = columnId;
  card.position = pos;
  col.cards.push(card);
  sortColumn(col);
}

function reconcileMove(data) {
  if (data.renormalized && data.columnOrder) {
    applyColumnOrder(data.card.columnId, data.columnOrder);
  } else {
    upsertCard(data.card);
  }
}

// --- Server interactions -------------------------------------------------

async function createCard(columnId, text) {
  try {
    const res = await fetch(`${API}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text })
    });
    if (!res.ok) throw new Error('create failed');
    const data = await res.json();
    // The card may already arrive via SSE; upsert is idempotent.
    upsertCard(data.card);
    render();
  } catch (err) {
    console.error(err);
    await loadBoard();
  }
}

async function loadBoard() {
  const res = await fetch(`${API}/board`);
  state = await res.json();
  for (const col of state.columns) sortColumn(col);
  render();
}

// --- SSE -----------------------------------------------------------------

function connectStream() {
  const es = new EventSource(`${API}/stream`);
  const dot = document.getElementById('conn-dot');
  const text = document.getElementById('conn-text');

  es.addEventListener('connected', () => {
    dot.className = 'dot online';
    text.textContent = 'live';
  });

  es.addEventListener('card-created', (e) => {
    const { card } = JSON.parse(e.data);
    upsertCard(card);
    render();
  });

  es.addEventListener('card-moved', (e) => {
    const data = JSON.parse(e.data);
    if (data.renormalized && data.columnOrder) {
      applyColumnOrder(data.columnId, data.columnOrder);
    } else {
      upsertCard(data.card);
    }
    render();
  });

  es.onerror = () => {
    dot.className = 'dot offline';
    text.textContent = 'reconnecting…';
  };
}

// --- Boot ----------------------------------------------------------------

async function main() {
  await loadBoard();
  connectStream();
}

main();
