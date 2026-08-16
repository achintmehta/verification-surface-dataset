// Collaborative Kanban frontend.
//
// State model: we keep an in-memory copy of the board (columns -> ordered
// cards). The DOM is rendered from this state. Drag-and-drop performs an
// optimistic local mutation, then sends intent to the server. The server's
// canonical responses (and SSE broadcasts) are applied to the state and the
// affected columns re-render, snapping us to the authoritative order.

const API = '/api';

/** @type {{ id:string, title:string, position:number, cards: Card[] }[]} */
let columns = [];
/** card lookup by id -> card object (the same objects referenced in columns) */
const cardIndex = new Map();

const boardEl = document.getElementById('board');
const connDot = document.getElementById('conn-dot');
const connLabel = document.getElementById('conn-label');

// --- State helpers ---------------------------------------------------------

function findColumn(columnId) {
  return columns.find((c) => c.id === columnId);
}

function removeCardFromState(cardId) {
  for (const col of columns) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) {
      const [card] = col.cards.splice(idx, 1);
      return { card, fromColumnId: col.id };
    }
  }
  return { card: null, fromColumnId: null };
}

function sortColumnCards(col) {
  col.cards.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

/**
 * Upsert a canonical card into the state. Guarantees the card exists in
 * exactly one column afterwards. Returns the set of column ids that changed.
 */
function upsertCard(card) {
  const changed = new Set();
  // Remove every existing copy (defensive against duplicates).
  for (const col of columns) {
    const before = col.cards.length;
    col.cards = col.cards.filter((c) => c.id !== card.id);
    if (col.cards.length !== before) changed.add(col.id);
  }
  const target = findColumn(card.columnId);
  if (target) {
    target.cards.push(card);
    sortColumnCards(target);
    changed.add(target.id);
  }
  cardIndex.set(card.id, card);
  return changed;
}

/** Replace an entire column's ordered cards from a canonical list. */
function applyNormalizedColumn(columnId, cards) {
  const col = findColumn(columnId);
  if (!col) return;
  // Remove these cards from anywhere else first.
  const ids = new Set(cards.map((c) => c.id));
  for (const other of columns) {
    if (other.id === columnId) continue;
    other.cards = other.cards.filter((c) => !ids.has(c.id));
  }
  col.cards = cards.slice();
  sortColumnCards(col);
  for (const c of col.cards) cardIndex.set(c.id, c);
}

// --- Rendering -------------------------------------------------------------

function render() {
  boardEl.innerHTML = '';
  for (const col of columns) {
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
  count.textContent = String(col.cards.length);
  title.appendChild(count);
  colEl.appendChild(title);

  const list = document.createElement('ul');
  list.className = 'cards';
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

  const toggle = document.createElement('button');
  toggle.className = 'add-card__toggle';
  toggle.textContent = '+ Add a card';

  toggle.addEventListener('click', () => {
    wrap.innerHTML = '';
    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Enter a title for this card…';
    const buttons = document.createElement('div');
    buttons.className = 'add-card__buttons';

    const add = document.createElement('button');
    add.className = 'btn btn--primary';
    add.textContent = 'Add card';
    const cancel = document.createElement('button');
    cancel.className = 'btn btn--ghost';
    cancel.textContent = 'Cancel';

    const submit = async () => {
      const text = textarea.value.trim();
      if (text) await createCard(columnId, text);
      resetAddCard(wrap, columnId);
    };

    add.addEventListener('click', submit);
    cancel.addEventListener('click', () => resetAddCard(wrap, columnId));
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') {
        resetAddCard(wrap, columnId);
      }
    });

    buttons.append(add, cancel);
    wrap.append(textarea, buttons);
    textarea.focus();
  });

  wrap.appendChild(toggle);
  return wrap;
}

function resetAddCard(wrap, columnId) {
  const fresh = renderAddCard(columnId);
  wrap.replaceWith(fresh);
}

// --- Drag and drop ---------------------------------------------------------

let dragCardId = null;

function attachCardDnd(li) {
  li.addEventListener('dragstart', (e) => {
    dragCardId = li.dataset.cardId;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragCardId);
  });
  li.addEventListener('dragend', () => {
    li.classList.remove('dragging');
    clearDropMarkers();
    dragCardId = null;
  });
}

function attachListDnd(list) {
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDropMarkers();
    const afterEl = getDragAfterElement(list, e.clientY);
    if (afterEl) {
      afterEl.classList.add('drop-before');
    } else {
      list.classList.add('drag-over');
    }
  });

  list.addEventListener('dragleave', (e) => {
    // Only clear when truly leaving the list bounds.
    if (e.target === list) {
      list.classList.remove('drag-over');
    }
  });

  list.addEventListener('drop', (e) => {
    e.preventDefault();
    const cardId = dragCardId || e.dataTransfer.getData('text/plain');
    clearDropMarkers();
    if (!cardId) return;
    handleDrop(cardId, list, e.clientY);
  });
}

function clearDropMarkers() {
  document
    .querySelectorAll('.drop-before, .drop-after')
    .forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  document
    .querySelectorAll('.cards.drag-over')
    .forEach((el) => el.classList.remove('drag-over'));
}

/** Find the card element that the dragged item should be inserted before. */
function getDragAfterElement(list, y) {
  const els = [...list.querySelectorAll('.card:not(.dragging)')];
  let closest = null;
  let closestOffset = Number.NEGATIVE_INFINITY;
  for (const el of els) {
    const box = el.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closestOffset) {
      closestOffset = offset;
      closest = el;
    }
  }
  return closest;
}

/**
 * Handle a drop: compute neighbours, optimistically reorder the local state,
 * re-render, then send the move intent to the server.
 */
async function handleDrop(cardId, list, y) {
  const columnId = list.dataset.columnId;
  const beforeEl = getDragAfterElement(list, y); // element that goes BELOW

  // Determine target neighbours among cards already in the column (excluding
  // the dragged card).
  const col = findColumn(columnId);
  if (!col) return;

  const otherCards = col.cards.filter((c) => c.id !== cardId);

  let beforeId = null; // card directly below the dropped card
  let afterId = null; // card directly above the dropped card

  if (beforeEl) {
    beforeId = beforeEl.dataset.cardId;
    if (beforeId === cardId) {
      // Shouldn't happen since dragging card is excluded, guard anyway.
      beforeId = null;
    }
    const idx = otherCards.findIndex((c) => c.id === beforeId);
    afterId = idx > 0 ? otherCards[idx - 1].id : null;
  } else {
    // Dropped at the end.
    afterId = otherCards.length ? otherCards[otherCards.length - 1].id : null;
    beforeId = null;
  }

  // --- Optimistic local update ---
  const { card } = removeCardFromState(cardId);
  if (!card) return;
  card.columnId = columnId;

  // Compute an optimistic fractional position between neighbours.
  const afterPos = afterId ? cardPosition(otherCards, afterId) : null;
  const beforePos = beforeId ? cardPosition(otherCards, beforeId) : null;
  card.position = optimisticPosition(afterPos, beforePos);

  col.cards.push(card);
  sortColumnCards(col);
  cardIndex.set(card.id, card);
  render();

  // --- Send intent to server; reconcile against canonical response ---
  try {
    const res = await fetch(`${API}/cards/${cardId}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId })
    });
    if (!res.ok) throw new Error(`move failed: ${res.status}`);
    const data = await res.json();
    if (data.normalizedColumn) {
      applyNormalizedColumn(columnId, data.normalizedColumn);
    } else if (data.card) {
      upsertCard(data.card);
    }
    render();
  } catch (err) {
    console.error(err);
    // On failure, refetch authoritative state.
    await loadBoard();
  }
}

function cardPosition(cards, id) {
  const c = cards.find((x) => x.id === id);
  return c ? c.position : null;
}

function optimisticPosition(afterPos, beforePos) {
  if (afterPos == null && beforePos == null) return 1000;
  if (afterPos == null) return beforePos - 1000;
  if (beforePos == null) return afterPos + 1000;
  return (afterPos + beforePos) / 2;
}

// --- API calls -------------------------------------------------------------

async function loadBoard() {
  const res = await fetch(`${API}/board`);
  const data = await res.json();
  columns = data.columns.map((c) => ({ ...c, cards: c.cards.slice() }));
  cardIndex.clear();
  for (const col of columns) {
    sortColumnCards(col);
    for (const card of col.cards) cardIndex.set(card.id, card);
  }
  render();
}

async function createCard(columnId, text) {
  // The server is authoritative for the new card (id + position), so we let
  // the POST response / SSE broadcast insert it.
  try {
    const res = await fetch(`${API}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text })
    });
    if (!res.ok) throw new Error(`create failed: ${res.status}`);
    const data = await res.json();
    if (data.card) {
      upsertCard(data.card);
      render();
    }
  } catch (err) {
    console.error(err);
  }
}

// --- SSE -------------------------------------------------------------------

function connectStream() {
  const es = new EventSource(`${API}/stream`);

  es.addEventListener('hello', () => setConnected(true));
  es.addEventListener('open', () => setConnected(true));
  es.onopen = () => setConnected(true);

  es.addEventListener('card:created', (e) => {
    const { card } = JSON.parse(e.data);
    upsertCard(card);
    render();
  });

  es.addEventListener('card:moved', (e) => {
    const { card } = JSON.parse(e.data);
    upsertCard(card);
    render();
  });

  es.addEventListener('column:normalized', (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    applyNormalizedColumn(columnId, cards);
    render();
  });

  es.onerror = () => {
    setConnected(false);
    // EventSource auto-reconnects; nothing else needed.
  };
}

function setConnected(ok) {
  connDot.className = `dot ${ok ? 'dot--on' : 'dot--off'}`;
  connLabel.textContent = ok ? 'live' : 'reconnecting…';
}

// --- Utils -----------------------------------------------------------------

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// --- Boot ------------------------------------------------------------------

(async function init() {
  await loadBoard();
  connectStream();
})();
