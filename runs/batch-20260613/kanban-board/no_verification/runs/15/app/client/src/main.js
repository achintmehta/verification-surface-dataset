import './style.css';
import { BoardStore } from './store.js';
import { fetchBoard, createCard, moveCard } from './api.js';

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');
const store = new BoardStore();

// --- Drag state ----------------------------------------------------------
let dragCardId = null;

function setStatus(state, label) {
  statusEl.className = `status status--${state}`;
  statusEl.textContent = label;
}

// --- Rendering -----------------------------------------------------------

function render() {
  // Preserve scroll positions across re-renders.
  const scrolls = new Map();
  boardEl.querySelectorAll('.column__cards').forEach((el) => {
    scrolls.set(el.dataset.columnId, el.scrollTop);
  });

  boardEl.innerHTML = '';
  for (const col of store.columns) {
    boardEl.appendChild(renderColumn(col));
  }

  scrolls.forEach((top, columnId) => {
    const el = boardEl.querySelector(`.column__cards[data-column-id="${columnId}"]`);
    if (el) el.scrollTop = top;
  });
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

  for (const card of store.cardsForColumn(col.id)) {
    list.appendChild(renderCard(card));
  }

  attachListDnd(list, col.id);
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

  li.addEventListener('dragstart', (e) => {
    dragCardId = card.id;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.id);
  });
  li.addEventListener('dragend', () => {
    dragCardId = null;
    li.classList.remove('dragging');
    cleanupPlaceholders();
  });
  return li;
}

function renderAddCard(columnId) {
  const wrap = document.createElement('div');
  wrap.className = 'add-card';

  const ta = document.createElement('textarea');
  ta.rows = 2;
  ta.placeholder = 'Add a card…';

  const btn = document.createElement('button');
  btn.className = 'add-card__btn';
  btn.textContent = 'Add card';

  const submit = async () => {
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    try {
      // Server assigns canonical position; SSE will deliver it. We also
      // upsert from the POST response for snappy feedback.
      const { card } = await createCard(columnId, text);
      store.upsertCard(card);
    } catch (err) {
      console.error(err);
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

// --- Drag & drop on a column list ---------------------------------------

function cleanupPlaceholders() {
  boardEl.querySelectorAll('.card-placeholder').forEach((el) => el.remove());
  boardEl.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
}

function getPlaceholder() {
  let ph = boardEl.querySelector('.card-placeholder');
  if (!ph) {
    ph = document.createElement('li');
    ph.className = 'card-placeholder';
  }
  return ph;
}

/**
 * Determine the DOM element the dragged card should be inserted *before*,
 * based on pointer Y position relative to the existing (non-dragging) cards.
 */
function getDragAfterElement(list, y) {
  const cards = [...list.querySelectorAll('.card:not(.dragging)')];
  let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
  for (const child of cards) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      closest = { offset, element: child };
    }
  }
  return closest.element; // null => append to end
}

function attachListDnd(list, columnId) {
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    list.classList.add('drag-over');

    const ph = getPlaceholder();
    const afterEl = getDragAfterElement(list, e.clientY);
    if (afterEl == null) {
      list.appendChild(ph);
    } else {
      list.insertBefore(ph, afterEl);
    }
  });

  list.addEventListener('dragleave', (e) => {
    // Only clear when leaving the list entirely.
    if (!list.contains(e.relatedTarget)) {
      list.classList.remove('drag-over');
    }
  });

  list.addEventListener('drop', async (e) => {
    e.preventDefault();
    list.classList.remove('drag-over');
    const cardId = dragCardId || e.dataTransfer.getData('text/plain');
    if (!cardId) return;

    const ph = boardEl.querySelector('.card-placeholder');
    // Determine neighbor card ids from the placeholder position.
    const { afterId, beforeId } = neighborsFromPlaceholder(list, ph);
    cleanupPlaceholders();

    await performMove(cardId, columnId, afterId, beforeId);
  });
}

/**
 * afterId  = card immediately above the slot (smaller position)
 * beforeId = card immediately below the slot (larger position)
 */
function neighborsFromPlaceholder(list, ph) {
  const children = [...list.children].filter(
    (el) => el.classList.contains('card') || el.classList.contains('card-placeholder')
  );
  const idx = ph ? children.indexOf(ph) : children.length;

  let afterId = null;
  let beforeId = null;
  for (let i = idx - 1; i >= 0; i--) {
    const el = children[i];
    if (el.classList.contains('card') && el.dataset.cardId !== dragCardId) {
      afterId = el.dataset.cardId;
      break;
    }
  }
  for (let i = idx + 1; i < children.length; i++) {
    const el = children[i];
    if (el.classList.contains('card') && el.dataset.cardId !== dragCardId) {
      beforeId = el.dataset.cardId;
      break;
    }
  }
  return { afterId, beforeId };
}

// --- Optimistic move + reconciliation -----------------------------------

async function performMove(cardId, columnId, afterId, beforeId) {
  const card = store.getCard(cardId);
  if (!card) return;

  // Optimistic: compute a tentative position between the neighbors so the
  // card snaps into place immediately.
  const optimisticPos = optimisticPosition(columnId, afterId, beforeId, cardId);
  store.upsertCard({ ...card, columnId, position: optimisticPos });

  try {
    const { card: canonical, renormalizedColumn } = await moveCard(cardId, {
      columnId,
      beforeId,
      afterId,
    });
    // Reconcile against server-authoritative ordering.
    if (renormalizedColumn) {
      store.applyRenormalizedColumn(columnId, renormalizedColumn);
    }
    store.upsertCard(canonical);
  } catch (err) {
    console.error(err);
    // On failure, reload authoritative state.
    await loadBoard();
  }
}

function optimisticPosition(columnId, afterId, beforeId, movingId) {
  const cards = store
    .cardsForColumn(columnId)
    .filter((c) => c.id !== movingId);
  const after = afterId ? cards.find((c) => c.id === afterId) : null;
  const before = beforeId ? cards.find((c) => c.id === beforeId) : null;

  const afterPos = after ? after.position : null;
  const beforePos = before ? before.position : null;

  if (afterPos == null && beforePos == null) {
    const max = cards.reduce((m, c) => Math.max(m, c.position), 0);
    return max + 1000;
  }
  if (afterPos == null) return beforePos - 1000;
  if (beforePos == null) return afterPos + 1000;
  return afterPos + (beforePos - afterPos) / 2;
}

// --- SSE -----------------------------------------------------------------

function connectStream() {
  const es = new EventSource('/api/stream');

  es.addEventListener('open', () => setStatus('live', 'live'));

  es.addEventListener('card.created', (e) => {
    const { card } = JSON.parse(e.data);
    store.upsertCard(card);
  });

  es.addEventListener('card.moved', (e) => {
    const { card, renormalizedColumn, columnId } = JSON.parse(e.data);
    // Apply canonical card first (this also moves it out of any old column,
    // since each card is keyed by id with a single columnId).
    store.upsertCard(card);
    if (renormalizedColumn) {
      store.applyRenormalizedColumn(columnId, renormalizedColumn);
    }
  });

  es.addEventListener('error', () => {
    setStatus('offline', 'reconnecting…');
    // EventSource auto-reconnects; status flips back on 'open'.
  });
}

// --- Boot ----------------------------------------------------------------

async function loadBoard() {
  const payload = await fetchBoard();
  store.setBoard(payload);
}

store.subscribe(render);

(async () => {
  setStatus('connecting', 'connecting…');
  try {
    await loadBoard();
  } catch (err) {
    console.error(err);
    setStatus('offline', 'offline');
  }
  connectStream();
})();
