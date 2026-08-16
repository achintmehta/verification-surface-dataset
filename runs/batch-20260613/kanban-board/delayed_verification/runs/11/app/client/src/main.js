import './style.css';
import { fetchBoard, createCard, moveCard, openStream } from './api.js';
import { BoardStore } from './store.js';

const store = new BoardStore();
const boardEl = document.getElementById('board');
const connEl = document.getElementById('connection');

// Tracks the card currently being dragged.
let dragState = null;

function setConnection(online) {
  connEl.textContent = online ? 'live' : 'offline';
  connEl.className = `status ${online ? 'status--online' : 'status--offline'}`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render() {
  // Preserve any open "add card" composer state across re-renders.
  const openComposers = new Set(
    [...boardEl.querySelectorAll('.add-form:not(.hidden)')].map(
      (f) => f.dataset.columnId
    )
  );
  const focusedCardId = document.activeElement?.dataset?.cardId;

  boardEl.innerHTML = '';
  for (const col of store.columns) {
    boardEl.appendChild(renderColumn(col, openComposers));
  }

  if (focusedCardId) {
    const el = boardEl.querySelector(`[data-card-id="${focusedCardId}"]`);
    el?.focus();
  }
}

function renderColumn(col, openComposers) {
  const colEl = document.createElement('section');
  colEl.className = 'column';
  colEl.dataset.columnId = col.id;

  const header = document.createElement('div');
  header.className = 'column__header';
  header.innerHTML = `<span>${escapeHtml(col.title)}</span>
    <span class="column__count">${col.cards.length}</span>`;
  colEl.appendChild(header);

  const list = document.createElement('ul');
  list.className = 'cards';
  list.dataset.columnId = col.id;
  for (const card of col.cards) {
    list.appendChild(renderCard(card));
  }
  attachColumnDnd(list);
  colEl.appendChild(list);

  colEl.appendChild(renderFooter(col, openComposers.has(col.id)));
  return colEl;
}

function renderCard(card) {
  const li = document.createElement('li');
  li.className = 'card';
  li.draggable = true;
  li.dataset.cardId = card.id;
  li.tabIndex = 0;
  li.textContent = card.text;
  attachCardDnd(li, card);
  return li;
}

function renderFooter(col, open) {
  const footer = document.createElement('div');
  footer.className = 'column__footer';

  const addBtn = document.createElement('button');
  addBtn.className = 'add-btn' + (open ? ' hidden' : '');
  addBtn.textContent = '+ Add a card';

  const form = document.createElement('form');
  form.className = 'add-form' + (open ? '' : ' hidden');
  form.dataset.columnId = col.id;
  form.innerHTML = `
    <textarea rows="2" placeholder="Enter a title for this card…"></textarea>
    <div class="add-actions">
      <button type="submit" class="primary">Add card</button>
      <button type="button" class="ghost">Cancel</button>
    </div>`;

  const textarea = form.querySelector('textarea');
  const cancelBtn = form.querySelector('.ghost');

  addBtn.addEventListener('click', () => {
    addBtn.classList.add('hidden');
    form.classList.remove('hidden');
    textarea.focus();
  });
  cancelBtn.addEventListener('click', () => {
    form.classList.add('hidden');
    addBtn.classList.remove('hidden');
    textarea.value = '';
  });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = '';
    textarea.focus();
    try {
      await createCard(col.id, text);
      // The SSE broadcast will insert the card (also for this client).
    } catch (err) {
      console.error(err);
    }
  });

  footer.appendChild(addBtn);
  footer.appendChild(form);
  return footer;
}

// ---------------------------------------------------------------------------
// Drag and drop
// ---------------------------------------------------------------------------
function attachCardDnd(el, card) {
  el.addEventListener('dragstart', (e) => {
    dragState = { cardId: card.id };
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.id);
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    clearDropMarkers();
    dragState = null;
  });
}

function attachColumnDnd(list) {
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
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    list.classList.remove('drag-over');
    const cardId = dragState?.cardId || e.dataTransfer.getData('text/plain');
    clearDropMarkers();
    if (!cardId) return;
    handleDrop(cardId, list, e.clientY);
  });
}

/**
 * Compute the DOM index at which a dragged card would land for a given pointer
 * Y, ignoring the dragged element itself.
 */
function computeDropIndex(list, clientY, draggedId) {
  const items = [...list.querySelectorAll('.card')].filter(
    (el) => el.dataset.cardId !== draggedId
  );
  for (let i = 0; i < items.length; i++) {
    const rect = items[i].getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return i;
  }
  return items.length;
}

function showDropMarker(list, clientY) {
  clearDropMarkers();
  const draggedId = dragState?.cardId;
  const items = [...list.querySelectorAll('.card')].filter(
    (el) => el.dataset.cardId !== draggedId
  );
  const index = computeDropIndex(list, clientY, draggedId);
  if (items.length === 0) return;
  if (index >= items.length) {
    items[items.length - 1].classList.add('drop-after');
  } else {
    items[index].classList.add('drop-before');
  }
}

function clearDropMarkers() {
  boardEl
    .querySelectorAll('.drop-before, .drop-after')
    .forEach((el) => el.classList.remove('drop-before', 'drop-after'));
}

async function handleDrop(cardId, list, clientY) {
  const columnId = list.dataset.columnId;
  const domIndex = computeDropIndex(list, clientY, cardId);

  // Determine neighbour ids from the column's current order (excluding the
  // dragged card), so the server can compute a canonical position.
  const col = store.getColumn(columnId);
  if (!col) return;
  const others = col.cards.filter((c) => c.id !== cardId);
  const beforeCard = others[domIndex] || null; // the card that will follow
  const afterCard = others[domIndex - 1] || null; // the card that will precede

  // Optimistic update: reposition immediately in our local model + DOM.
  store.optimisticMove(cardId, columnId, domIndex);

  try {
    const result = await moveCard(cardId, {
      columnId,
      beforeId: beforeCard ? beforeCard.id : null,
      afterId: afterCard ? afterCard.id : null,
    });
    // Reconcile against the server's canonical column ordering.
    store.reconcileColumn(result.column, result.card);
  } catch (err) {
    console.error('Move failed, reloading authoritative state', err);
    await loadBoard();
  }
}

// ---------------------------------------------------------------------------
// SSE handling
// ---------------------------------------------------------------------------
function connectStream() {
  openStream({
    onOpen: () => setConnection(true),
    onError: () => setConnection(false),
    onCreate: ({ card }) => {
      store.upsertCard(card);
    },
    onMove: ({ card, column }) => {
      // Authoritative move: reconcile the target column and enforce the
      // single-column invariant by removing the card elsewhere.
      store.reconcileColumn(column, card);
    },
  });
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
async function loadBoard() {
  const { columns } = await fetchBoard();
  store.setBoard(columns);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

store.subscribe(render);

(async () => {
  try {
    await loadBoard();
  } catch (err) {
    console.error(err);
  }
  connectStream();
})();
