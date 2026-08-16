// Collaborative Kanban frontend.
//
// State model: a single source of truth `state.columns`, an ordered list of
// columns each with an ordered list of cards. The DOM is rendered from this
// state. Drag-and-drop produces an optimistic local mutation that is rendered
// immediately and sent to the server; the SSE stream then delivers the
// canonical result, which we reconcile into state and re-render.

const API = '/api';

const statusEl = document.getElementById('status');
const boardEl = document.getElementById('board');

/** @type {{ columns: Array<{id:string,title:string,cards:Array<Card>}> }} */
const state = { columns: [] };

/** @typedef {{id:string,columnId:string,text:string,position:number}} Card */

// --- Helpers ------------------------------------------------------------

function findCard(id) {
  for (const col of state.columns) {
    const idx = col.cards.findIndex((c) => c.id === id);
    if (idx !== -1) return { col, idx, card: col.cards[idx] };
  }
  return null;
}

function findColumn(id) {
  return state.columns.find((c) => c.id === id) || null;
}

function removeCardEverywhere(id) {
  for (const col of state.columns) {
    const idx = col.cards.findIndex((c) => c.id === id);
    if (idx !== -1) col.cards.splice(idx, 1);
  }
}

function sortByPosition(cards) {
  cards.sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// --- Initial load -------------------------------------------------------

async function loadBoard() {
  const res = await fetch(`${API}/board`);
  if (!res.ok) throw new Error('Failed to load board');
  const data = await res.json();
  state.columns = data.columns.map((col) => ({
    id: col.id,
    title: col.title,
    cards: col.cards.map(normalizeCard),
  }));
  state.columns.forEach((col) => sortByPosition(col.cards));
  render();
}

function normalizeCard(c) {
  return {
    id: c.id,
    columnId: c.columnId,
    text: c.text,
    position: Number(c.position),
  };
}

// --- Rendering ----------------------------------------------------------

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
  title.innerHTML = `<span>${escapeHtml(col.title)}</span>`;
  const count = document.createElement('span');
  count.className = 'column__count';
  count.textContent = col.cards.length;
  title.appendChild(count);
  colEl.appendChild(title);

  const list = document.createElement('ul');
  list.className = 'cards';
  list.dataset.columnId = col.id;
  for (const card of col.cards) {
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
  li.draggable = true;
  li.dataset.cardId = card.id;
  li.textContent = card.text;
  attachCardDnD(li, card);
  return li;
}

function renderAddCard(columnId) {
  const wrap = document.createElement('div');
  wrap.className = 'add-card';
  const ta = document.createElement('textarea');
  ta.placeholder = 'Add a card…';
  const btn = document.createElement('button');
  btn.textContent = 'Add';

  const submit = async () => {
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    try {
      await fetch(`${API}/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId, text }),
      });
      // The card will appear via the SSE broadcast (authoritative).
    } catch (e) {
      console.error(e);
    }
  };

  btn.addEventListener('click', submit);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  });

  wrap.appendChild(ta);
  wrap.appendChild(btn);
  return wrap;
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (ch) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[ch]
  );
}

// --- Drag and drop ------------------------------------------------------

let dragging = null; // { cardId }

function attachCardDnD(el, card) {
  el.addEventListener('dragstart', (e) => {
    dragging = { cardId: card.id };
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('text/plain', card.id);
    } catch {
      /* some browsers require this in a try */
    }
  });

  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    clearDropMarkers();
    dragging = null;
  });
}

function attachListDnD(list, columnId) {
  list.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    list.classList.add('drag-over');
    showDropMarker(list, e.clientY);
  });

  list.addEventListener('dragleave', (e) => {
    if (e.target === list) list.classList.remove('drag-over');
  });

  list.addEventListener('drop', (e) => {
    if (!dragging) return;
    e.preventDefault();
    list.classList.remove('drag-over');
    const cardId = dragging.cardId;
    const { afterId, beforeId } = computeNeighbors(list, e.clientY, cardId);
    clearDropMarkers();
    handleDrop(cardId, columnId, afterId, beforeId);
  });
}

/**
 * Determine the cards immediately above (afterId) and below (beforeId) the
 * drop point within `list`, ignoring the dragged card itself.
 */
function computeNeighbors(list, clientY, draggedId) {
  const cards = [...list.querySelectorAll('.card')].filter(
    (el) => el.dataset.cardId !== draggedId
  );

  let beforeEl = null;
  for (const el of cards) {
    const box = el.getBoundingClientRect();
    if (clientY < box.top + box.height / 2) {
      beforeEl = el;
      break;
    }
  }

  if (!beforeEl) {
    const afterId = cards.length ? cards[cards.length - 1].dataset.cardId : null;
    return { afterId, beforeId: null };
  }

  const beforeIndex = cards.indexOf(beforeEl);
  const afterEl = beforeIndex > 0 ? cards[beforeIndex - 1] : null;
  return {
    afterId: afterEl ? afterEl.dataset.cardId : null,
    beforeId: beforeEl.dataset.cardId,
  };
}

function showDropMarker(list, clientY) {
  clearDropMarkers();
  if (!dragging) return;
  const cards = [...list.querySelectorAll('.card')].filter(
    (el) => el.dataset.cardId !== dragging.cardId
  );
  let target = null;
  for (const el of cards) {
    const box = el.getBoundingClientRect();
    if (clientY < box.top + box.height / 2) {
      target = el;
      break;
    }
  }
  if (target) {
    target.classList.add('drop-before');
  } else if (cards.length) {
    cards[cards.length - 1].classList.add('drop-after');
  }
}

function clearDropMarkers() {
  document
    .querySelectorAll('.drop-before, .drop-after')
    .forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  document
    .querySelectorAll('.cards.drag-over')
    .forEach((el) => el.classList.remove('drag-over'));
}

/**
 * Optimistically move the card in local state + DOM, then send the intent to
 * the server. The canonical result arrives via SSE and reconciles.
 */
async function handleDrop(cardId, columnId, afterId, beforeId) {
  const found = findCard(cardId);
  if (!found) return;
  const card = found.card;

  // Optimistic local move.
  removeCardEverywhere(cardId);
  const targetCol = findColumn(columnId);
  if (!targetCol) return;

  const insertIndex = computeInsertIndex(targetCol.cards, afterId, beforeId);
  card.columnId = columnId;
  // Assign a provisional fractional position so re-renders keep order before
  // the server reconciles.
  card.position = provisionalPosition(targetCol.cards, insertIndex);
  targetCol.cards.splice(insertIndex, 0, card);
  render();

  try {
    await fetch(`${API}/cards/${encodeURIComponent(cardId)}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, afterId, beforeId }),
    });
    // Reconciliation happens through the SSE 'card:move' (and possibly
    // 'column:reorder') broadcasts.
  } catch (e) {
    console.error('move failed', e);
    // On failure, reload authoritative state.
    loadBoard().catch(console.error);
  }
}

function computeInsertIndex(cards, afterId, beforeId) {
  if (afterId) {
    const i = cards.findIndex((c) => c.id === afterId);
    if (i !== -1) return i + 1;
  }
  if (beforeId) {
    const i = cards.findIndex((c) => c.id === beforeId);
    if (i !== -1) return i;
  }
  if (!afterId) return 0;
  return cards.length;
}

function provisionalPosition(cards, index) {
  const prev = index > 0 ? cards[index - 1].position : null;
  const next = index < cards.length ? cards[index].position : null;
  if (prev === null && next === null) return 1000;
  if (prev === null) return next - 1;
  if (next === null) return prev + 1;
  return prev + (next - prev) / 2;
}

// --- SSE reconciliation -------------------------------------------------

function applyCanonicalCard(card) {
  const c = normalizeCard(card);
  // Remove the card from wherever it currently is (guarantees it never lives
  // in two columns) and re-insert by canonical position.
  removeCardEverywhere(c.id);
  const col = findColumn(c.columnId);
  if (!col) return;
  col.cards.push(c);
  sortByPosition(col.cards);
}

function applyColumnReorder(columnId, cards) {
  const col = findColumn(columnId);
  if (!col) return;
  // Remove all of these cards from anywhere they might appear, then rebuild
  // the column from the canonical list.
  const ids = new Set(cards.map((c) => c.id));
  for (const c of state.columns) {
    c.cards = c.cards.filter((card) => !ids.has(card.id));
  }
  col.cards = cards.map(normalizeCard);
  sortByPosition(col.cards);
}

function connectStream() {
  const es = new EventSource(`${API}/stream`);

  es.onopen = () => setStatus('online');
  es.onerror = () => setStatus('offline');

  es.addEventListener('card:create', (e) => {
    const { card } = JSON.parse(e.data);
    applyCanonicalCard(card);
    render();
  });

  es.addEventListener('card:move', (e) => {
    const { card } = JSON.parse(e.data);
    applyCanonicalCard(card);
    render();
  });

  es.addEventListener('column:reorder', (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    applyColumnReorder(columnId, cards);
    render();
  });
}

function setStatus(kind) {
  statusEl.className = `status status--${kind}`;
  statusEl.textContent =
    kind === 'online' ? 'live' : kind === 'offline' ? 'reconnecting…' : kind;
}

// --- Boot ---------------------------------------------------------------

(async function boot() {
  try {
    await loadBoard();
  } catch (e) {
    console.error(e);
  }
  connectStream();
})();
