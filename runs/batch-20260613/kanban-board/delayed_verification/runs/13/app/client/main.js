// Collaborative Kanban frontend.
//
// State model: we keep a local authoritative-ish map of cards keyed by id,
// each with { id, column_id, text, position }. The DOM is rendered from this
// state. Drag-and-drop applies an optimistic local update immediately, then
// fires a PATCH. The SSE stream pushes canonical create/move/renormalize
// events from the server; on receipt we update local state to match the
// server and re-render, which reconciles any optimistic divergence and
// guarantees a card never appears in two columns.

const API = '/api';

/** @type {Map<string, {id:string, column_id:string, text:string, position:number}>} */
const cards = new Map();
/** @type {Array<{id:string, title:string, position:number}>} */
let columns = [];

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function loadBoard() {
  const res = await fetch(`${API}/board`);
  const data = await res.json();
  columns = data.columns.map((c) => ({ id: c.id, title: c.title, position: Number(c.position) }));
  cards.clear();
  for (const col of data.columns) {
    for (const card of col.cards) {
      cards.set(card.id, {
        id: card.id,
        column_id: card.column_id,
        text: card.text,
        position: Number(card.position)
      });
    }
  }
  render();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function cardsForColumn(columnId) {
  return [...cards.values()]
    .filter((c) => c.column_id === columnId)
    .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
}

function render() {
  boardEl.innerHTML = '';
  for (const col of [...columns].sort((a, b) => a.position - b.position)) {
    const colEl = document.createElement('section');
    colEl.className = 'column';
    colEl.dataset.columnId = col.id;

    const titleEl = document.createElement('div');
    titleEl.className = 'column__title';
    titleEl.textContent = col.title;
    colEl.appendChild(titleEl);

    const cardsEl = document.createElement('div');
    cardsEl.className = 'column__cards';
    cardsEl.dataset.columnId = col.id;
    for (const card of cardsForColumn(col.id)) {
      cardsEl.appendChild(renderCard(card));
    }
    colEl.appendChild(cardsEl);

    colEl.appendChild(renderAddCard(col.id));
    boardEl.appendChild(colEl);
  }
  wireDragTargets();
}

function renderCard(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.dataset.cardId = card.id;
  el.textContent = card.text;
  el.addEventListener('dragstart', onDragStart);
  el.addEventListener('dragend', onDragEnd);
  return el;
}

function renderAddCard(columnId) {
  const wrap = document.createElement('div');
  wrap.className = 'add-card';

  const ta = document.createElement('textarea');
  ta.placeholder = 'Add a card…';
  ta.rows = 1;

  const btn = document.createElement('button');
  btn.className = 'add-card__btn';
  btn.textContent = 'Add card';

  const submit = async () => {
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    await fetch(`${API}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text })
    });
    // Card will arrive via SSE and be rendered then.
  };

  btn.addEventListener('click', submit);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  wrap.appendChild(ta);
  wrap.appendChild(btn);
  return wrap;
}

// ---------------------------------------------------------------------------
// Drag and drop
// ---------------------------------------------------------------------------
let draggingId = null;
let placeholder = null;

function onDragStart(e) {
  draggingId = e.currentTarget.dataset.cardId;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', draggingId);

  placeholder = document.createElement('div');
  placeholder.className = 'card-placeholder';
}

function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  if (placeholder && placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
  placeholder = null;
  draggingId = null;
}

function wireDragTargets() {
  document.querySelectorAll('.column__cards').forEach((listEl) => {
    listEl.addEventListener('dragover', onDragOver);
    listEl.addEventListener('drop', onDrop);
  });
}

function getDragAfterElement(listEl, y) {
  const els = [...listEl.querySelectorAll('.card:not(.dragging)')];
  let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
  for (const child of els) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      closest = { offset, element: child };
    }
  }
  return closest.element;
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const listEl = e.currentTarget;
  if (!placeholder) return;
  const afterEl = getDragAfterElement(listEl, e.clientY);
  if (afterEl == null) {
    listEl.appendChild(placeholder);
  } else {
    listEl.insertBefore(placeholder, afterEl);
  }
}

async function onDrop(e) {
  e.preventDefault();
  const listEl = e.currentTarget;
  const columnId = listEl.dataset.columnId;
  const cardId = draggingId;
  if (!cardId || !placeholder || !placeholder.parentNode) return;

  // Determine neighbours from the placeholder position.
  const prevEl = previousCardSibling(placeholder);
  const nextEl = nextCardSibling(placeholder);
  const afterId = prevEl ? prevEl.dataset.cardId : null; // card above
  const beforeId = nextEl ? nextEl.dataset.cardId : null; // card below

  // --- Optimistic local update ---
  applyOptimisticMove(cardId, columnId, afterId, beforeId);
  render();

  // --- Send intent to server ---
  try {
    const res = await fetch(`${API}/cards/${cardId}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, afterId, beforeId })
    });
    if (res.ok) {
      const data = await res.json();
      // Reconcile against the canonical card the server returned.
      if (data.card) {
        applyServerCard(data.card);
        render();
      }
    }
  } catch {
    // On failure, the next SSE event or a reload will reconcile state.
  }
}

function previousCardSibling(node) {
  let n = node.previousElementSibling;
  while (n && !n.classList.contains('card')) n = n.previousElementSibling;
  return n;
}
function nextCardSibling(node) {
  let n = node.nextElementSibling;
  while (n && !n.classList.contains('card')) n = n.nextElementSibling;
  return n;
}

/**
 * Compute an optimistic fractional position between the two neighbours so the
 * dragged card immediately renders in the dropped slot. The server will later
 * send the canonical position which we snap to.
 */
function applyOptimisticMove(cardId, columnId, afterId, beforeId) {
  const card = cards.get(cardId);
  if (!card) return;
  const afterPos = afterId && cards.get(afterId) ? cards.get(afterId).position : null;
  const beforePos = beforeId && cards.get(beforeId) ? cards.get(beforeId).position : null;

  let position;
  if (afterPos === null && beforePos === null) {
    position = 1024;
  } else if (afterPos === null) {
    position = beforePos - 512;
  } else if (beforePos === null) {
    position = afterPos + 512;
  } else {
    position = afterPos + (beforePos - afterPos) / 2;
  }
  card.column_id = columnId;
  card.position = position;
}

function applyServerCard(serverCard) {
  cards.set(serverCard.id, {
    id: serverCard.id,
    column_id: serverCard.column_id,
    text: serverCard.text,
    position: Number(serverCard.position)
  });
}

// ---------------------------------------------------------------------------
// SSE: real-time convergence
// ---------------------------------------------------------------------------
function connectStream() {
  const es = new EventSource(`${API}/stream`);

  es.addEventListener('hello', () => setStatus('connected'));
  es.addEventListener('open', () => setStatus('connected'));
  es.onopen = () => setStatus('connected');

  es.addEventListener('card-created', (e) => {
    const { card } = JSON.parse(e.data);
    applyServerCard(card);
    render();
  });

  es.addEventListener('card-moved', (e) => {
    const { card } = JSON.parse(e.data);
    // Canonical move: snap the card to the server's column + position. Because
    // a card has exactly one record keyed by id, it can never be in two
    // columns simultaneously.
    applyServerCard(card);
    render();
  });

  es.addEventListener('column-renormalized', (e) => {
    const { column } = JSON.parse(e.data);
    // Replace positions for every card in the renormalized column.
    for (const card of column.cards) {
      applyServerCard(card);
    }
    render();
  });

  es.onerror = () => {
    setStatus('disconnected');
    // EventSource auto-reconnects; status will flip back on reopen.
  };
}

function setStatus(state) {
  statusEl.className = `status status--${state}`;
  statusEl.textContent = state;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function init() {
  setStatus('connecting');
  await loadBoard();
  connectStream();
})();
