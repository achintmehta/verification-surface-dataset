// Collaborative Kanban frontend.
// State model: a local map of columns -> ordered card arrays mirroring the
// server's authoritative ordering. Optimistic moves update this model and DOM
// immediately; SSE events reconcile to the canonical server state.

const API = '/api';

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');

// In-memory model.
// columns: [{ id, title, position, cards: [{id, columnId, text, position}] }]
let state = { columns: [] };

// Track in-flight optimistic moves so we can reconcile when the canonical
// broadcast arrives. Keyed by cardId.
const pendingMoves = new Map();

function setStatus(online) {
  statusEl.textContent = online ? 'live' : 'connecting…';
  statusEl.className = 'status ' + (online ? 'status--online' : 'status--offline');
}

// ---------- Data helpers ----------

function findCard(cardId) {
  for (const col of state.columns) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) return { col, idx, card: col.cards[idx] };
  }
  return null;
}

function getColumn(columnId) {
  return state.columns.find((c) => c.id === columnId);
}

function sortCards(cards) {
  cards.sort((a, b) => (a.position - b.position) || (a.id - b.id));
}

// Replace the entire ordered card list of a column from canonical data.
function applyColumnOrder(columnId, cards) {
  const col = getColumn(columnId);
  if (!col) return;
  col.cards = cards.map((c) => ({
    id: c.id,
    columnId: c.columnId,
    text: c.text,
    position: c.position,
  }));
}

// ---------- Rendering ----------

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

  const cardsEl = document.createElement('div');
  cardsEl.className = 'column__cards';
  cardsEl.dataset.columnId = col.id;
  sortCards(col.cards);
  for (const card of col.cards) {
    cardsEl.appendChild(renderCard(card));
  }
  attachDropHandlers(cardsEl);
  colEl.appendChild(cardsEl);

  colEl.appendChild(renderAddCard(col));
  return colEl;
}

function renderCard(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.dataset.cardId = card.id;
  el.textContent = card.text;
  el.addEventListener('dragstart', (e) => {
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(card.id));
    draggingCardId = card.id;
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    draggingCardId = null;
    clearPlaceholder();
  });
  return el;
}

function renderAddCard(col) {
  const wrap = document.createElement('div');
  wrap.className = 'add-card';
  const ta = document.createElement('textarea');
  ta.placeholder = 'Add a card…';
  ta.rows = 1;
  const btn = document.createElement('button');
  btn.textContent = 'Add card';

  const submit = async () => {
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    try {
      await fetch(`${API}/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId: col.id, text }),
      });
      // The card will arrive via SSE broadcast and render then.
    } catch (e) {
      console.error('create card failed', e);
    }
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

// ---------- Drag & drop ----------

let draggingCardId = null;
let placeholder = null;

function clearPlaceholder() {
  if (placeholder && placeholder.parentNode) {
    placeholder.parentNode.removeChild(placeholder);
  }
  placeholder = null;
  document.querySelectorAll('.column__cards.drag-over').forEach((el) =>
    el.classList.remove('drag-over')
  );
}

function ensurePlaceholder() {
  if (!placeholder) {
    placeholder = document.createElement('div');
    placeholder.className = 'card-placeholder';
  }
  return placeholder;
}

// Given a container and y coordinate, find the element after which to insert.
function getCardAfter(container, y) {
  const cards = [...container.querySelectorAll('.card:not(.dragging)')];
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) {
      return card;
    }
  }
  return null;
}

function attachDropHandlers(container) {
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    container.classList.add('drag-over');
    const ph = ensurePlaceholder();
    const after = getCardAfter(container, e.clientY);
    if (after == null) {
      container.appendChild(ph);
    } else {
      container.insertBefore(ph, after);
    }
  });

  container.addEventListener('dragleave', (e) => {
    if (e.target === container && !container.contains(e.relatedTarget)) {
      container.classList.remove('drag-over');
    }
  });

  container.addEventListener('drop', (e) => {
    e.preventDefault();
    container.classList.remove('drag-over');
    const cardId = Number(e.dataTransfer.getData('text/plain'));
    if (!cardId || !placeholder) {
      clearPlaceholder();
      return;
    }
    const targetColumnId = Number(container.dataset.columnId);

    // Determine neighbors based on placeholder position.
    const prevEl = previousCardEl(placeholder);
    const nextEl = nextCardEl(placeholder);
    const afterId = prevEl ? Number(prevEl.dataset.cardId) : null; // card above
    const beforeId = nextEl ? Number(nextEl.dataset.cardId) : null; // card below

    clearPlaceholder();
    optimisticMove(cardId, targetColumnId, beforeId, afterId);
    sendMove(cardId, targetColumnId, beforeId, afterId);
  });
}

function previousCardEl(node) {
  let el = node.previousElementSibling;
  while (el && !el.classList.contains('card')) el = el.previousElementSibling;
  return el && el.classList.contains('card') ? el : null;
}

function nextCardEl(node) {
  let el = node.nextElementSibling;
  while (el && !el.classList.contains('card')) el = el.nextElementSibling;
  return el && el.classList.contains('card') ? el : null;
}

// ---------- Optimistic move ----------

function optimisticMove(cardId, targetColumnId, beforeId, afterId) {
  const found = findCard(cardId);
  if (!found) return;
  const { col: sourceCol, card } = found;

  // Remove from source.
  sourceCol.cards = sourceCol.cards.filter((c) => c.id !== cardId);

  const targetCol = getColumn(targetColumnId);
  if (!targetCol) return;

  // Compute an optimistic position between afterId and beforeId.
  const afterCard = afterId != null ? targetCol.cards.find((c) => c.id === afterId) : null;
  const beforeCard = beforeId != null ? targetCol.cards.find((c) => c.id === beforeId) : null;

  let pos;
  if (afterCard && beforeCard) {
    pos = (afterCard.position + beforeCard.position) / 2;
  } else if (afterCard) {
    pos = afterCard.position + 1000;
  } else if (beforeCard) {
    pos = beforeCard.position - 1000;
  } else {
    pos = 1000;
  }

  card.columnId = targetColumnId;
  card.position = pos;
  targetCol.cards.push(card);
  sortCards(targetCol.cards);

  pendingMoves.set(cardId, true);
  render();
}

async function sendMove(cardId, columnId, beforeId, afterId) {
  try {
    await fetch(`${API}/cards/${cardId}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId }),
    });
    // Canonical state arrives via SSE; reconciliation happens there.
  } catch (e) {
    console.error('move failed', e);
    // On failure, reload authoritative state.
    pendingMoves.delete(cardId);
    await loadBoard();
  }
}

// ---------- SSE handling ----------

function applyCreate(card) {
  // Remove if it somehow already exists (idempotent).
  const existing = findCard(card.id);
  if (existing) existing.col.cards.splice(existing.idx, 1);

  const col = getColumn(card.columnId);
  if (!col) return;
  col.cards.push({
    id: card.id,
    columnId: card.columnId,
    text: card.text,
    position: card.position,
  });
  sortCards(col.cards);
  render();
}

function applyMove(payload) {
  const { card, columns } = payload;
  // Reconcile: replace every affected column's ordering with canonical data.
  // This guarantees the card exists in exactly one column.

  // First, ensure the card is removed from any column it doesn't belong to.
  const existing = findCard(card.id);
  if (existing && existing.col.id !== card.columnId) {
    existing.col.cards.splice(existing.idx, 1);
  }

  for (const colData of columns) {
    applyColumnOrder(colData.id, colData.cards);
  }

  pendingMoves.delete(card.id);
  render();
}

function connectStream() {
  const es = new EventSource(`${API}/stream`);

  es.addEventListener('open', () => setStatus(true));
  es.addEventListener('error', () => setStatus(false));

  es.addEventListener('card:create', (e) => {
    try {
      const data = JSON.parse(e.data);
      applyCreate(data.card);
    } catch (err) {
      console.error('bad create event', err);
    }
  });

  es.addEventListener('card:move', (e) => {
    try {
      const data = JSON.parse(e.data);
      applyMove(data);
    } catch (err) {
      console.error('bad move event', err);
    }
  });
}

// ---------- Init ----------

async function loadBoard() {
  const res = await fetch(`${API}/board`);
  const data = await res.json();
  state = {
    columns: data.columns.map((c) => ({
      id: c.id,
      title: c.title,
      position: c.position,
      cards: c.cards.map((card) => ({
        id: card.id,
        columnId: card.columnId,
        text: card.text,
        position: card.position,
      })),
    })),
  };
  render();
}

async function init() {
  await loadBoard();
  connectStream();
}

init().catch((e) => console.error('init failed', e));
