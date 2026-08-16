import { fetchBoard, createCard, moveCard } from './api.js';
import { BoardStore } from './store.js';

const store = new BoardStore();
const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');

// --- Drag state (module-level, single active drag) -------------------------
let dragCardId = null;

function setStatus(online) {
  statusEl.textContent = online ? 'live' : 'connecting…';
  statusEl.className = `status ${online ? 'status--online' : 'status--offline'}`;
}

// --- Rendering -------------------------------------------------------------
// We render declaratively from the store, which mirrors the server's
// canonical ordering. This makes reconciliation trivial: whenever the store
// changes (optimistic move, SSE event, full resync) we re-render and the DOM
// snaps to the authoritative order.
function render() {
  boardEl.innerHTML = '';
  for (const col of store.columns) {
    boardEl.appendChild(renderColumn(col));
  }
}

function renderColumn(col) {
  const colEl = document.createElement('section');
  colEl.className = 'column';
  colEl.dataset.columnId = String(col.id);

  const title = document.createElement('h2');
  title.className = 'column__title';
  title.textContent = col.title;
  colEl.appendChild(title);

  const list = document.createElement('ul');
  list.className = 'column__list';
  list.dataset.columnId = String(col.id);

  for (const card of store.cardsForColumn(col.id)) {
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
  li.dataset.cardId = String(card.id);
  li.textContent = card.text;

  li.addEventListener('dragstart', (e) => {
    dragCardId = card.id;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(card.id));
  });
  li.addEventListener('dragend', () => {
    dragCardId = null;
    li.classList.remove('dragging');
    clearDropMarkers();
  });
  return li;
}

function renderAddCard(columnId) {
  const wrap = document.createElement('div');
  wrap.className = 'add-card';
  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Add a card…';
  textarea.rows = 1;
  const button = document.createElement('button');
  button.textContent = 'Add';

  async function submit() {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = '';
    try {
      await createCard(columnId, text);
      // The card will arrive via SSE and be inserted; no optimistic insert
      // needed since creation is fast and avoids id reconciliation.
    } catch (err) {
      console.error(err);
    }
  }

  button.addEventListener('click', submit);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  wrap.appendChild(textarea);
  wrap.appendChild(button);
  return wrap;
}

// --- Drag & drop -----------------------------------------------------------
function attachListDnD(list, columnId) {
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    list.classList.add('drag-over');
    showDropMarker(list, e.clientY);
  });

  list.addEventListener('dragleave', (e) => {
    if (!list.contains(e.relatedTarget)) {
      list.classList.remove('drag-over');
    }
  });

  list.addEventListener('drop', async (e) => {
    e.preventDefault();
    list.classList.remove('drag-over');
    clearDropMarkers();

    const cardId = dragCardId;
    if (cardId == null) return;

    const { afterId, beforeId } = computeNeighbors(list, e.clientY, cardId);

    // Optimistic: update local store immediately so the drop feels instant.
    store.optimisticMove(cardId, columnId, afterId, beforeId);

    try {
      const { card, normalizedColumn } = await moveCard(cardId, {
        columnId,
        afterId,
        beforeId,
      });
      // Reconcile against the server's canonical position. If it differs from
      // our optimistic guess, the store re-render snaps the card into place.
      store.upsertCard(card);
      if (normalizedColumn) {
        store.applyNormalizedColumn(
          normalizedColumn.columnId,
          normalizedColumn.cards
        );
      }
    } catch (err) {
      console.error(err);
      // On failure, resync from the authoritative server state.
      await fullResync();
    }
  });
}

/**
 * Determine the card immediately above (afterId) and below (beforeId) the
 * cursor within a list, ignoring the dragged card itself.
 */
function computeNeighbors(list, clientY, draggedId) {
  const cards = [...list.querySelectorAll('.card')].filter(
    (el) => Number(el.dataset.cardId) !== draggedId
  );

  let beforeEl = null; // first card whose midpoint is below the cursor
  for (const el of cards) {
    const rect = el.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    if (clientY < mid) {
      beforeEl = el;
      break;
    }
  }

  let afterEl;
  if (beforeEl) {
    const idx = cards.indexOf(beforeEl);
    afterEl = idx > 0 ? cards[idx - 1] : null;
  } else {
    afterEl = cards.length ? cards[cards.length - 1] : null;
  }

  return {
    afterId: afterEl ? Number(afterEl.dataset.cardId) : null,
    beforeId: beforeEl ? Number(beforeEl.dataset.cardId) : null,
  };
}

function showDropMarker(list, clientY) {
  clearDropMarkers();
  const cards = [...list.querySelectorAll('.card')].filter(
    (el) => Number(el.dataset.cardId) !== dragCardId
  );
  for (const el of cards) {
    const rect = el.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    if (clientY < mid) {
      el.classList.add('drop-before');
      return;
    }
  }
  if (cards.length) cards[cards.length - 1].classList.add('drop-after');
}

function clearDropMarkers() {
  document
    .querySelectorAll('.drop-before, .drop-after')
    .forEach((el) => el.classList.remove('drop-before', 'drop-after'));
}

// --- SSE -------------------------------------------------------------------
function connectStream() {
  const es = new EventSource('/api/stream');

  es.onopen = () => setStatus(true);
  es.onerror = () => {
    setStatus(false);
    // EventSource auto-reconnects; on reconnect we resync to catch up on any
    // events missed while disconnected.
  };

  es.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    handleEvent(msg);
  };

  return es;
}

function handleEvent(msg) {
  switch (msg.type) {
    case 'card:create':
    case 'card:move':
      // Upsert the single canonical card record; it can only live in one
      // column, so no duplication is possible.
      store.upsertCard(msg.payload.card);
      break;
    case 'column:normalize':
      store.applyNormalizedColumn(
        msg.payload.columnId,
        msg.payload.cards
      );
      break;
    default:
      break;
  }
}

// --- Bootstrap -------------------------------------------------------------
async function fullResync() {
  const board = await fetchBoard();
  store.setBoard(board);
}

async function init() {
  store.subscribe(render);
  let es = null;
  try {
    await fullResync();
  } catch (err) {
    console.error(err);
  }
  es = connectStream();

  // When the tab becomes visible again, resync to guarantee convergence.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      fullResync().catch(console.error);
    }
  });

  window.addEventListener('beforeunload', () => es && es.close());
}

init();
