import { fetchBoard, createCard, moveCard } from './api.js';
import { BoardStore } from './store.js';

const store = new BoardStore();
const boardEl = document.getElementById('board');
const connEl = document.getElementById('connection');

// Tracks the card id currently being dragged (so SSE re-renders don't disrupt
// an in-progress drag).
let draggingId = null;

// --- Rendering --------------------------------------------------------------

function render() {
  // Preserve scroll positions of card lists across re-renders.
  const scrolls = new Map();
  boardEl.querySelectorAll('.cards').forEach((ul) => {
    scrolls.set(ul.dataset.columnId, ul.scrollTop);
  });

  boardEl.innerHTML = '';

  for (const col of store.columns) {
    const colEl = document.createElement('section');
    colEl.className = 'column';
    colEl.dataset.columnId = col.id;

    const header = document.createElement('div');
    header.className = 'column__header';
    const title = document.createElement('span');
    title.textContent = col.title;
    const count = document.createElement('span');
    count.className = 'column__count';
    count.textContent = String(col.cards.length);
    header.append(title, count);

    const list = document.createElement('ul');
    list.className = 'cards';
    list.dataset.columnId = col.id;

    for (const card of col.cards) {
      list.appendChild(renderCard(card));
    }

    wireColumnDnD(list, col.id);

    const adder = renderAdder(col.id);

    colEl.append(header, list, adder);
    boardEl.appendChild(colEl);
  }

  // Restore scroll positions.
  boardEl.querySelectorAll('.cards').forEach((ul) => {
    const s = scrolls.get(ul.dataset.columnId);
    if (s != null) ul.scrollTop = s;
  });
}

function renderCard(card) {
  const li = document.createElement('li');
  li.className = 'card';
  li.draggable = true;
  li.dataset.cardId = card.id;
  li.textContent = card.text;
  if (card.id === draggingId) li.classList.add('dragging');

  li.addEventListener('dragstart', (e) => {
    draggingId = card.id;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.id);
  });

  li.addEventListener('dragend', () => {
    draggingId = null;
    clearDropIndicators();
    li.classList.remove('dragging');
  });

  return li;
}

function renderAdder(columnId) {
  const wrap = document.createElement('div');
  wrap.className = 'add-card';

  const ta = document.createElement('textarea');
  ta.placeholder = 'Write a card…';
  ta.rows = 1;

  const btn = document.createElement('button');
  btn.textContent = '+ Add card';

  async function submit() {
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    try {
      await createCard(columnId, text);
      // Canonical card arrives via SSE; nothing else to do.
    } catch (err) {
      console.error('create failed', err);
      ta.value = text;
    }
  }

  btn.addEventListener('click', submit);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  });

  wrap.append(ta, btn);
  return wrap;
}

// --- Drag and drop ----------------------------------------------------------

function clearDropIndicators() {
  document.querySelectorAll('.drop-before, .drop-after').forEach((el) => {
    el.classList.remove('drop-before', 'drop-after');
  });
  document.querySelectorAll('.cards.drag-over').forEach((el) => {
    el.classList.remove('drag-over');
  });
}

function wireColumnDnD(list, columnId) {
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDropIndicators();
    list.classList.add('drag-over');

    const target = getDropTarget(list, e.clientY);
    if (target) {
      target.el.classList.add(target.position === 'before' ? 'drop-before' : 'drop-after');
    }
  });

  list.addEventListener('dragleave', (e) => {
    // Only clear if leaving the list entirely.
    if (!list.contains(e.relatedTarget)) {
      list.classList.remove('drag-over');
    }
  });

  list.addEventListener('drop', async (e) => {
    e.preventDefault();
    const cardId = e.dataTransfer.getData('text/plain') || draggingId;
    clearDropIndicators();
    if (!cardId) return;

    const { afterId, beforeId } = computeNeighbors(list, columnId, cardId, e.clientY);

    // Optimistic update first.
    store.optimisticMove(cardId, { columnId, beforeId, afterId });
    draggingId = null;

    // Then send intent to the server; canonical state arrives via SSE and
    // reconciles. We also reconcile from the direct response in case SSE is
    // momentarily lagging.
    try {
      const result = await moveCard(cardId, { columnId, beforeId, afterId });
      store.applyMoved({
        card: result.card,
        columnId: result.card.columnId,
        renormalized: result.renormalized,
        column: result.column
      });
    } catch (err) {
      console.error('move failed; reloading authoritative board', err);
      await loadBoard();
    }
  });
}

// Determine the card element under the cursor and whether to drop before/after.
function getDropTarget(list, clientY) {
  const cards = [...list.querySelectorAll('.card')].filter(
    (el) => el.dataset.cardId !== draggingId
  );
  for (const el of cards) {
    const rect = el.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    if (clientY < mid) return { el, position: 'before' };
  }
  if (cards.length) return { el: cards[cards.length - 1], position: 'after' };
  return null;
}

// Compute afterId (card above) and beforeId (card below) for the drop slot.
function computeNeighbors(list, columnId, cardId, clientY) {
  const col = store.getColumn(columnId);
  const ordered = col ? col.cards.filter((c) => c.id !== cardId).map((c) => c.id) : [];

  const target = getDropTarget(list, clientY);
  if (!target) {
    // Empty column.
    return { afterId: null, beforeId: null };
  }

  const targetId = target.el.dataset.cardId;
  const targetIndex = ordered.indexOf(targetId);

  if (target.position === 'before') {
    const afterId = targetIndex > 0 ? ordered[targetIndex - 1] : null;
    return { afterId, beforeId: targetId };
  }
  // after
  const beforeId = targetIndex < ordered.length - 1 ? ordered[targetIndex + 1] : null;
  return { afterId: targetId, beforeId };
}

// --- SSE --------------------------------------------------------------------

function connectSSE() {
  const es = new EventSource('/api/stream');

  es.addEventListener('open', () => setConn('open'));

  es.addEventListener('card-created', (e) => {
    const { card } = JSON.parse(e.data);
    store.applyCreated(card);
  });

  es.addEventListener('card-moved', (e) => {
    const data = JSON.parse(e.data);
    // Don't yank a card out from under an active drag of that same card.
    if (data.card && data.card.id === draggingId) return;
    store.applyMoved(data);
  });

  es.addEventListener('error', () => {
    setConn('closed');
    // EventSource auto-reconnects; reflect connecting state.
    setTimeout(() => {
      if (es.readyState === EventSource.CONNECTING) setConn('connecting');
    }, 300);
  });
}

function setConn(state) {
  connEl.className = `conn conn--${state}`;
  connEl.textContent =
    state === 'open' ? 'live' : state === 'closed' ? 'disconnected' : 'connecting…';
}

// --- Boot -------------------------------------------------------------------

async function loadBoard() {
  const board = await fetchBoard();
  store.setBoard(board);
}

store.subscribe(render);

(async function init() {
  try {
    await loadBoard();
  } catch (err) {
    console.error('initial load failed', err);
  }
  connectSSE();
})();
