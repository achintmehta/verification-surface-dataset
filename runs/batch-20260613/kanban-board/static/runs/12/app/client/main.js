import { fetchBoard, createCard, moveCard } from './api.js';

// ---------------------------------------------------------------------------
// Client state model
//
// We keep a local model of the board keyed by canonical server data. Each card
// stores its server-authoritative `position`. Cards within a column are
// rendered sorted by (position, id) so ordering is total and stable and
// matches exactly what the server produces in getBoard().
//
// Drag-and-drop applies an optimistic position locally, then sends the move
// intent. SSE events carry the canonical card (with its real position) and we
// overwrite the local card, re-sorting and re-rendering. This guarantees every
// client converges to the same order regardless of who initiated the move.
// ---------------------------------------------------------------------------

const state = {
  columns: [], // [{ id, title, position }]
  cards: new Map(), // id -> { id, columnId, text, position, createdAt }
};

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');

let dragState = null; // { cardId }

// --- Status indicator ------------------------------------------------------
function setStatus(kind, label) {
  statusEl.className = `status status--${kind}`;
  statusEl.textContent = label;
}

// --- Sorting helper --------------------------------------------------------
function compareCards(a, b) {
  if (a.position !== b.position) return a.position - b.position;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function cardsForColumn(columnId) {
  const list = [];
  for (const card of state.cards.values()) {
    if (card.columnId === columnId) list.push(card);
  }
  list.sort(compareCards);
  return list;
}

// --- Rendering -------------------------------------------------------------
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
  for (const card of cardsForColumn(col.id)) {
    list.appendChild(renderCard(card));
  }
  attachListDnD(list);
  colEl.appendChild(list);

  colEl.appendChild(renderAddCard(col.id));
  return colEl;
}

function renderCard(card) {
  const el = document.createElement('li');
  el.className = 'card';
  el.dataset.cardId = card.id;
  el.draggable = true;
  el.textContent = card.text;
  attachCardDnD(el);
  return el;
}

function renderAddCard(columnId) {
  const wrap = document.createElement('div');
  wrap.className = 'add-card';

  const button = document.createElement('button');
  button.className = 'add-card__button';
  button.type = 'button';
  button.textContent = '+ Add a card';

  const showForm = () => {
    wrap.innerHTML = '';
    const textarea = document.createElement('textarea');
    textarea.className = 'add-card__input';
    textarea.rows = 2;
    textarea.placeholder = 'Enter a title for this card…';

    const submit = document.createElement('button');
    submit.className = 'add-card__button';
    submit.type = 'button';
    submit.textContent = 'Add card';

    const doSubmit = async () => {
      const text = textarea.value.trim();
      if (!text) {
        resetAddCard(wrap, columnId);
        return;
      }
      submit.disabled = true;
      try {
        // The created card arrives via SSE and is added to the model there.
        // We still await to surface errors; SSE applies it idempotently.
        await createCard(columnId, text);
      } catch (err) {
        console.error('Create failed', err);
      }
      resetAddCard(wrap, columnId);
    };

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        doSubmit();
      } else if (e.key === 'Escape') {
        resetAddCard(wrap, columnId);
      }
    });
    submit.addEventListener('click', doSubmit);

    wrap.appendChild(textarea);
    wrap.appendChild(submit);
    textarea.focus();
  };

  button.addEventListener('click', showForm);
  wrap.appendChild(button);
  return wrap;
}

function resetAddCard(wrap, columnId) {
  const fresh = renderAddCard(columnId);
  wrap.replaceWith(fresh);
}

// --- Drag and drop ---------------------------------------------------------
function attachCardDnD(cardEl) {
  cardEl.addEventListener('dragstart', (e) => {
    dragState = { cardId: cardEl.dataset.cardId };
    cardEl.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Some browsers require data to be set for DnD to work.
    e.dataTransfer.setData('text/plain', cardEl.dataset.cardId);
  });

  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('dragging');
    clearDragOver();
    dragState = null;
  });
}

function attachListDnD(listEl) {
  listEl.addEventListener('dragover', (e) => {
    if (!dragState) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    listEl.classList.add('drag-over');

    const dragging = listEl.querySelector('.dragging');
    const afterEl = getDragAfterElement(listEl, e.clientY);
    const draggingEl =
      dragging || document.querySelector(`.card[data-card-id="${dragState.cardId}"]`);
    if (!draggingEl) return;

    if (afterEl == null) {
      listEl.appendChild(draggingEl);
    } else {
      listEl.insertBefore(draggingEl, afterEl);
    }
  });

  listEl.addEventListener('dragleave', (e) => {
    // Only clear when leaving the list entirely.
    if (!listEl.contains(e.relatedTarget)) {
      listEl.classList.remove('drag-over');
    }
  });

  listEl.addEventListener('drop', async (e) => {
    if (!dragState) return;
    e.preventDefault();
    listEl.classList.remove('drag-over');

    const cardId = dragState.cardId;
    const columnId = listEl.dataset.columnId;
    const cardEl = listEl.querySelector(`.card[data-card-id="${cardId}"]`);
    if (!cardEl) return;

    // Determine the optimistic neighbors from current DOM order.
    const prevEl = previousCardElement(cardEl);
    const nextEl = nextCardElement(cardEl);
    const afterId = prevEl ? prevEl.dataset.cardId : null;
    const beforeId = nextEl ? nextEl.dataset.cardId : null;

    applyOptimisticMove(cardId, columnId, afterId, beforeId);

    try {
      const { card } = await moveCard(cardId, { columnId, afterId, beforeId });
      // Reconcile against the canonical card the server returns.
      applyCanonicalCard(card);
    } catch (err) {
      console.error('Move failed; reverting to server state', err);
      await reloadBoard();
    }
  });
}

function getDragAfterElement(listEl, y) {
  const els = [...listEl.querySelectorAll('.card:not(.dragging)')];
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

function previousCardElement(cardEl) {
  let el = cardEl.previousElementSibling;
  while (el && !el.classList.contains('card')) el = el.previousElementSibling;
  return el;
}
function nextCardElement(cardEl) {
  let el = cardEl.nextElementSibling;
  while (el && !el.classList.contains('card')) el = el.nextElementSibling;
  return el;
}

function clearDragOver() {
  document.querySelectorAll('.column__cards.drag-over').forEach((el) => {
    el.classList.remove('drag-over');
  });
}

// --- Optimistic + canonical model updates ----------------------------------

/**
 * Compute an optimistic fractional position between the neighbors' current
 * positions so the local sort matches the DOM the user just produced.
 */
function applyOptimisticMove(cardId, columnId, afterId, beforeId) {
  const card = state.cards.get(cardId);
  if (!card) return;

  const after = afterId ? state.cards.get(afterId) : null;
  const before = beforeId ? state.cards.get(beforeId) : null;

  let position;
  if (!after && !before) {
    position = 1000;
  } else if (!after) {
    position = before.position - 1000;
  } else if (!before) {
    position = after.position + 1000;
  } else {
    position = (after.position + before.position) / 2;
  }

  card.columnId = columnId;
  card.position = position;
  // Re-render the affected columns to reflect the optimistic order.
  render();
}

/** Overwrite the local card with the server's canonical version. */
function applyCanonicalCard(card) {
  const existing = state.cards.get(card.id);
  state.cards.set(card.id, {
    id: card.id,
    columnId: card.columnId,
    text: card.text,
    position: card.position,
    createdAt: card.createdAt ?? existing?.createdAt,
  });
  render();
}

/** Replace all cards in a column with the server's renormalized order. */
function applyColumnReorder(columnId, cards) {
  // Remove existing cards for this column, then add the canonical set.
  for (const [id, card] of state.cards) {
    if (card.columnId === columnId) state.cards.delete(id);
  }
  for (const card of cards) {
    state.cards.set(card.id, {
      id: card.id,
      columnId: card.columnId,
      text: card.text,
      position: card.position,
      createdAt: card.createdAt,
    });
  }
  render();
}

// --- Initial load + SSE -----------------------------------------------------
async function reloadBoard() {
  const data = await fetchBoard();
  state.columns = data.columns.map((c) => ({
    id: c.id,
    title: c.title,
    position: c.position,
  }));
  state.cards.clear();
  for (const col of data.columns) {
    for (const card of col.cards) {
      state.cards.set(card.id, {
        id: card.id,
        columnId: card.columnId,
        text: card.text,
        position: card.position,
        createdAt: card.createdAt,
      });
    }
  }
  render();
}

function connectStream() {
  const es = new EventSource('/api/stream');

  es.addEventListener('open', () => setStatus('online', 'live'));
  es.addEventListener('error', () => setStatus('offline', 'reconnecting…'));

  es.addEventListener('card:created', (e) => {
    const { card } = JSON.parse(e.data).payload;
    applyCanonicalCard(card);
  });

  es.addEventListener('card:moved', (e) => {
    const { card } = JSON.parse(e.data).payload;
    applyCanonicalCard(card);
  });

  es.addEventListener('column:reordered', (e) => {
    const { columnId, cards } = JSON.parse(e.data).payload;
    applyColumnReorder(columnId, cards);
  });

  return es;
}

async function start() {
  setStatus('connecting', 'connecting…');
  try {
    await reloadBoard();
  } catch (err) {
    console.error('Failed to load board', err);
    setStatus('offline', 'load failed');
  }
  connectStream();
}

start();
