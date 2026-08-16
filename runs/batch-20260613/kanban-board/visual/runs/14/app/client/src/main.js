import './style.css';
import { fetchBoard, createCard, moveCard, openStream } from './api.js';
import { BoardStore } from './store.js';

const store = new BoardStore();
const boardEl = document.getElementById('board');
const connDot = document.getElementById('conn-dot');
const connText = document.getElementById('conn-text');

// Track which column is currently showing its add-card form so re-renders
// don't blow away in-progress input.
let activeForm = null; // columnId

// --- Drag state ----------------------------------------------------------
let dragCardId = null;

function setConnection(state) {
  connDot.classList.remove('online', 'offline');
  if (state === 'online') {
    connDot.classList.add('online');
    connText.textContent = 'live';
  } else if (state === 'connecting') {
    connDot.classList.add('offline');
    connText.textContent = 'connecting…';
  } else {
    connText.textContent = 'reconnecting…';
  }
}

// --- Rendering -----------------------------------------------------------
function render() {
  const columns = store.getColumns();
  boardEl.innerHTML = '';

  for (const col of columns) {
    const cards = store.getCards(col.id);

    const colEl = document.createElement('section');
    colEl.className = 'column';
    colEl.dataset.columnId = col.id;

    const header = document.createElement('div');
    header.className = 'column-header';
    header.innerHTML = `<span>${escapeHtml(col.title)}</span><span class="column-count">${cards.length}</span>`;
    colEl.appendChild(header);

    const list = document.createElement('ul');
    list.className = 'card-list';
    list.dataset.columnId = col.id;
    attachListDnd(list);

    for (const card of cards) {
      list.appendChild(renderCard(card));
    }
    colEl.appendChild(list);

    colEl.appendChild(renderAddCard(col.id));
    boardEl.appendChild(colEl);
  }
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
    clearIndicators();
  });
  return li;
}

function renderAddCard(columnId) {
  const wrap = document.createElement('div');
  wrap.className = 'add-card';

  if (activeForm === columnId) {
    const form = document.createElement('form');
    form.className = 'add-card-form';

    const ta = document.createElement('textarea');
    ta.placeholder = 'Enter card text…';
    form.appendChild(ta);

    const actions = document.createElement('div');
    actions.className = 'add-card-actions';
    actions.innerHTML = `
      <button type="submit" class="btn btn-primary">Add card</button>
      <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>`;
    form.appendChild(actions);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text) return;
      ta.value = '';
      activeForm = null;
      try {
        // Server creates + broadcasts; the SSE event will insert it for us.
        await createCard(columnId, text);
      } catch (err) {
        console.error(err);
        alert('Failed to add card: ' + err.message);
      }
      render();
    });

    actions.querySelector('[data-cancel]').addEventListener('click', () => {
      activeForm = null;
      render();
    });

    wrap.appendChild(form);
    // Focus after insertion.
    queueMicrotask(() => ta.focus());
  } else {
    const btn = document.createElement('button');
    btn.className = 'add-card-btn';
    btn.textContent = '+ Add a card';
    btn.addEventListener('click', () => {
      activeForm = columnId;
      render();
    });
    wrap.appendChild(btn);
  }
  return wrap;
}

// --- Drag & drop on a column list ---------------------------------------
function attachListDnd(list) {
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    list.classList.add('drag-over');
    showIndicator(list, e.clientY);
  });

  list.addEventListener('dragleave', (e) => {
    // Only clear when actually leaving the list (not entering a child).
    if (!list.contains(e.relatedTarget)) {
      list.classList.remove('drag-over');
    }
  });

  list.addEventListener('drop', async (e) => {
    e.preventDefault();
    list.classList.remove('drag-over');
    const cardId = dragCardId || e.dataTransfer.getData('text/plain');
    clearIndicators();
    if (!cardId) return;
    await handleDrop(cardId, list, e.clientY);
  });
}

/**
 * Compute insertion neighbors (afterId above, beforeId below), apply an
 * optimistic local move, then PATCH the server. Server broadcast reconciles.
 */
async function handleDrop(cardId, list, clientY) {
  const columnId = list.dataset.columnId;
  const { afterEl, beforeEl } = locateNeighbors(list, clientY, cardId);

  const afterId = afterEl ? afterEl.dataset.cardId : null;
  const beforeId = beforeEl ? beforeEl.dataset.cardId : null;

  // --- Optimistic update: compute a local position between neighbors. ---
  const card = store.getCard(cardId);
  if (!card) return;

  const afterPos = afterId ? store.getCard(afterId)?.position : null;
  const beforePos = beforeId ? store.getCard(beforeId)?.position : null;
  const optimisticPos = computeOptimisticPosition(afterPos, beforePos);

  store.upsertCard({
    id: cardId,
    columnId,
    text: card.text,
    position: optimisticPos,
  });

  try {
    const { card: canonical, renormalizedColumns } = await moveCard(cardId, {
      columnId,
      beforeId,
      afterId,
    });
    // Reconcile: snap to server-authoritative position/column.
    store.upsertCard(canonical);
    for (const col of renormalizedColumns || []) {
      store.applyRenormalize(col);
    }
  } catch (err) {
    console.error('move failed, resyncing', err);
    await resync();
  }
}

function computeOptimisticPosition(afterPos, beforePos) {
  if (afterPos == null && beforePos == null) return 1000;
  if (afterPos == null) return beforePos - 1000;
  if (beforePos == null) return afterPos + 1000;
  return (afterPos + beforePos) / 2;
}

/**
 * Find the card element that the dragged card should be placed AFTER (above)
 * and BEFORE (below), based on pointer Y, ignoring the dragged card itself.
 */
function locateNeighbors(list, clientY, draggingId) {
  const cards = [...list.querySelectorAll('.card')].filter(
    (el) => el.dataset.cardId !== draggingId
  );

  let beforeEl = null;
  for (const el of cards) {
    const rect = el.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    if (clientY < midpoint) {
      beforeEl = el;
      break;
    }
  }

  let afterEl = null;
  if (beforeEl) {
    const idx = cards.indexOf(beforeEl);
    afterEl = idx > 0 ? cards[idx - 1] : null;
  } else {
    afterEl = cards.length ? cards[cards.length - 1] : null;
  }
  return { afterEl, beforeEl };
}

// --- Drop indicator -----------------------------------------------------
function clearIndicators() {
  document.querySelectorAll('.drop-indicator').forEach((el) => el.remove());
  document.querySelectorAll('.card-list.drag-over').forEach((el) =>
    el.classList.remove('drag-over')
  );
}

function showIndicator(list, clientY) {
  clearIndicators();
  list.classList.add('drag-over');
  const { beforeEl } = locateNeighbors(list, clientY, dragCardId);
  const indicator = document.createElement('div');
  indicator.className = 'drop-indicator';
  if (beforeEl) {
    list.insertBefore(indicator, beforeEl);
  } else {
    list.appendChild(indicator);
  }
}

// --- Real-time sync ------------------------------------------------------
function connectStream() {
  setConnection('connecting');
  const es = openStream();

  es.addEventListener('hello', () => setConnection('online'));

  es.addEventListener('card:create', (e) => {
    const { card } = JSON.parse(e.data);
    store.upsertCard(card);
  });

  es.addEventListener('card:move', (e) => {
    const { card } = JSON.parse(e.data);
    store.upsertCard(card);
  });

  es.addEventListener('column:renormalize', (e) => {
    store.applyRenormalize(JSON.parse(e.data));
  });

  es.onopen = () => setConnection('online');
  es.onerror = () => {
    setConnection('reconnecting');
    // EventSource auto-reconnects; on reconnect we resync to catch up on any
    // events missed while disconnected.
    if (es.readyState === EventSource.CONNECTING) {
      // will retry; schedule a resync shortly after.
      setTimeout(resync, 1500);
    }
  };
}

// --- Initial load + resync ----------------------------------------------
async function resync() {
  try {
    const board = await fetchBoard();
    store.setBoard(board);
  } catch (err) {
    console.error('resync failed', err);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

// Re-render whenever the store changes, but skip wholesale re-render while the
// user is mid-drag to avoid disrupting the native drag operation.
store.subscribe(() => {
  if (dragCardId) return;
  render();
});

(async function boot() {
  await resync();
  render();
  // Allow disabling the live SSE connection (e.g. for static rendering/tests)
  // via ?nostream — the board still loads its full state over HTTP.
  if (!new URLSearchParams(location.search).has('nostream')) {
    connectStream();
  } else {
    setConnection('online');
  }
})();
