import './style.css';
import { fetchBoard, createCard, moveCard } from './api.js';
import { BoardStore } from './store.js';

const boardEl = document.getElementById('board');
const connStatus = document.getElementById('conn-status');
const store = new BoardStore();

// ---- Rendering ---------------------------------------------------------

store.subscribe(render);

function render() {
  // Preserve focus/value of any open add-card textarea across re-renders.
  const active = document.activeElement;
  const activeColId = active && active.dataset && active.dataset.addColumn;
  const activeValue = active && activeColId ? active.value : null;
  const selStart = active && activeColId ? active.selectionStart : null;

  boardEl.innerHTML = '';

  for (const col of store.getColumns()) {
    const colEl = document.createElement('section');
    colEl.className = 'column';
    colEl.dataset.columnId = col.id;

    const header = document.createElement('div');
    header.className = 'column-header';
    const cards = store.getCardsForColumn(col.id);
    header.innerHTML = `<span>${escapeHtml(col.title)}</span><span class="column-count">${cards.length}</span>`;
    colEl.appendChild(header);

    const list = document.createElement('div');
    list.className = 'card-list';
    list.dataset.columnId = col.id;

    for (const card of cards) {
      list.appendChild(renderCard(card));
    }

    attachListDnD(list, col.id);
    colEl.appendChild(list);

    // Add-card composer.
    const composer = document.createElement('div');
    composer.className = 'add-card';
    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Add a card…';
    textarea.dataset.addColumn = col.id;
    const btn = document.createElement('button');
    btn.textContent = 'Add card';

    const submit = async () => {
      const text = textarea.value.trim();
      if (!text) return;
      textarea.value = '';
      try {
        await createCard(col.id, text);
        // The card will appear via the SSE 'card:create' broadcast (and the
        // POST response also includes it). We rely on SSE for convergence.
      } catch (err) {
        console.error(err);
        textarea.value = text;
      }
    };

    btn.addEventListener('click', submit);
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    });

    composer.appendChild(textarea);
    composer.appendChild(btn);
    colEl.appendChild(composer);

    boardEl.appendChild(colEl);
  }

  // Restore composer focus/value.
  if (activeColId != null && activeValue != null) {
    const restored = boardEl.querySelector(`textarea[data-add-column="${activeColId}"]`);
    if (restored) {
      restored.value = activeValue;
      restored.focus();
      if (selStart != null) {
        try {
          restored.setSelectionRange(selStart, selStart);
        } catch {}
      }
    }
  }
}

function renderCard(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.dataset.cardId = card.id;
  el.textContent = card.text;

  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(card.id));
    // Defer so the drag image is the full card before opacity changes.
    requestAnimationFrame(() => el.classList.add('dragging'));
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    clearDropIndicators();
  });

  return el;
}

// ---- Drag and drop -----------------------------------------------------

function attachListDnD(list, columnId) {
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    showDropIndicator(list, e.clientY);
  });

  list.addEventListener('dragleave', (e) => {
    // Only clear if we actually left the list (not entered a child).
    if (!list.contains(e.relatedTarget)) {
      clearDropIndicators(list);
    }
  });

  list.addEventListener('drop', async (e) => {
    e.preventDefault();
    const cardId = Number(e.dataTransfer.getData('text/plain'));
    if (!cardId) return;

    const { afterId, beforeId } = computeNeighbors(list, e.clientY, cardId);
    clearDropIndicators();

    // 1. Optimistically reposition locally.
    store.optimisticMove(cardId, columnId, beforeId, afterId);

    // 2. Send canonical intent to the server and reconcile from the response.
    try {
      const { card, renormalized } = await moveCard(cardId, {
        columnId,
        beforeId,
        afterId,
      });
      if (!renormalized) {
        // Snap to the server's canonical position.
        store.upsertCard(card);
      }
      // If renormalized, the SSE 'column:reorder' event carries the full
      // corrected ordering and will reconcile everyone (including us).
    } catch (err) {
      console.error('Move failed, reloading authoritative state:', err);
      await loadBoard();
    }
  });
}

/**
 * Determine the (afterId, beforeId) neighbours for a drop at clientY,
 * excluding the dragged card itself.
 */
function computeNeighbors(list, clientY, draggedId) {
  const cards = [...list.querySelectorAll('.card')].filter(
    (c) => Number(c.dataset.cardId) !== draggedId
  );

  let afterId = null; // card above the slot
  let beforeId = null; // card below the slot

  for (const cardEl of cards) {
    const rect = cardEl.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    if (clientY < midpoint) {
      beforeId = Number(cardEl.dataset.cardId);
      break;
    } else {
      afterId = Number(cardEl.dataset.cardId);
    }
  }

  return { afterId, beforeId };
}

function showDropIndicator(list, clientY) {
  clearDropIndicators();
  const indicator = document.createElement('div');
  indicator.className = 'drop-indicator';

  const cards = [...list.querySelectorAll('.card:not(.dragging)')];
  let inserted = false;
  for (const cardEl of cards) {
    const rect = cardEl.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    if (clientY < midpoint) {
      list.insertBefore(indicator, cardEl);
      inserted = true;
      break;
    }
  }
  if (!inserted) list.appendChild(indicator);
}

function clearDropIndicators() {
  document.querySelectorAll('.drop-indicator').forEach((el) => el.remove());
}

// ---- SSE realtime ------------------------------------------------------

function connectSSE() {
  const es = new EventSource('/api/stream');

  es.addEventListener('open', () => setConn(true));
  es.addEventListener('error', () => setConn(false));

  es.addEventListener('card:create', (e) => {
    const { card } = JSON.parse(e.data);
    store.upsertCard(card);
  });

  es.addEventListener('card:move', (e) => {
    const { card } = JSON.parse(e.data);
    // Canonical move: upserting overwrites column_id + position, so the card
    // can only ever live in exactly one column.
    store.upsertCard(card);
  });

  es.addEventListener('column:reorder', (e) => {
    const payload = JSON.parse(e.data);
    store.applyColumnReorder(payload);
  });

  return es;
}

function setConn(online) {
  connStatus.classList.toggle('online', online);
  connStatus.classList.toggle('offline', !online);
  connStatus.title = online ? 'Realtime connected' : 'Reconnecting…';
}

// ---- Boot --------------------------------------------------------------

async function loadBoard() {
  const data = await fetchBoard();
  store.setBoard(data);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

async function init() {
  try {
    await loadBoard();
  } catch (err) {
    console.error('Initial load failed:', err);
  }
  connectSSE();
}

init();
