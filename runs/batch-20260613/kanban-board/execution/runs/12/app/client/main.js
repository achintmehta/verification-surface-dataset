import { fetchBoard, createCard, moveCard } from './api.js';

// ---------------------------------------------------------------------------
// Local client model.
//
// The client keeps a normalized model of the board:
//   columns: ordered list of { id, title }
//   cards:   Map<cardId, { id, column_id, text, position }>
// Rendering always derives column contents by filtering cards by column_id and
// sorting by position. This guarantees a card renders in exactly one place.
// ---------------------------------------------------------------------------

const state = {
  columns: [], // [{ id, title }]
  cards: new Map(), // id -> card
};

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');

// Tracks the card currently being dragged.
let dragCardId = null;

// ---- Model helpers --------------------------------------------------------

function cardsForColumn(columnId) {
  const list = [];
  for (const card of state.cards.values()) {
    if (card.column_id === columnId) list.push(card);
  }
  list.sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    // Deterministic tie-breaker so ordering is total and stable.
    if (a.created_at && b.created_at && a.created_at !== b.created_at) {
      return a.created_at < b.created_at ? -1 : 1;
    }
    return a.id < b.id ? -1 : 1;
  });
  return list;
}

function upsertCard(card) {
  // Normalize position to a number for stable comparisons.
  state.cards.set(card.id, { ...card, position: Number(card.position) });
}

// ---- Rendering ------------------------------------------------------------

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

  const cards = cardsForColumn(col.id);

  const header = document.createElement('div');
  header.className = 'column__header';
  header.innerHTML = `<span>${escapeHtml(col.title)}</span>`;
  const count = document.createElement('span');
  count.className = 'column__count';
  count.textContent = String(cards.length);
  header.appendChild(count);
  colEl.appendChild(header);

  const cardsEl = document.createElement('div');
  cardsEl.className = 'column__cards';
  cardsEl.dataset.columnId = col.id;

  for (const card of cards) {
    cardsEl.appendChild(renderCard(card));
  }

  attachColumnDnD(cardsEl, col.id);
  colEl.appendChild(cardsEl);

  colEl.appendChild(renderAdd(col.id));
  return colEl;
}

function renderCard(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.dataset.cardId = card.id;
  el.textContent = card.text;

  el.addEventListener('dragstart', (e) => {
    dragCardId = card.id;
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('text/plain', card.id);
    } catch {
      /* some browsers restrict */
    }
  });

  el.addEventListener('dragend', () => {
    dragCardId = null;
    el.classList.remove('dragging');
    removePlaceholder();
  });

  return el;
}

function renderAdd(columnId) {
  const wrap = document.createElement('div');
  wrap.className = 'column__add';

  const btn = document.createElement('button');
  btn.className = 'add-btn';
  btn.textContent = '+ Add a card';

  btn.addEventListener('click', () => {
    wrap.innerHTML = '';
    const form = document.createElement('form');
    form.className = 'add-form';

    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Enter card text…';
    textarea.rows = 2;

    const actions = document.createElement('div');
    actions.className = 'add-form__actions';

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'add-form__submit';
    submit.textContent = 'Add';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'add-form__cancel';
    cancel.textContent = '✕';
    cancel.title = 'Cancel';

    actions.append(submit, cancel);
    form.append(textarea, actions);
    wrap.appendChild(form);
    textarea.focus();

    const close = () => {
      // Restore the column's add control by re-rendering the board.
      render();
    };

    cancel.addEventListener('click', close);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = textarea.value.trim();
      if (!text) return;
      submit.disabled = true;
      try {
        // The card will arrive via SSE (card.created). We also handle the
        // direct response so the author sees it immediately even if SSE lags.
        const { card } = await createCard(columnId, text);
        upsertCard(card);
        render();
      } catch (err) {
        alert(err.message);
        submit.disabled = false;
      }
    });

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      } else if (e.key === 'Escape') {
        close();
      }
    });
  });

  wrap.appendChild(btn);
  return wrap;
}

// ---- Drag & drop ----------------------------------------------------------

function attachColumnDnD(cardsEl, columnId) {
  cardsEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    cardsEl.classList.add('drag-over');
    showPlaceholder(cardsEl, e.clientY);
  });

  cardsEl.addEventListener('dragleave', (e) => {
    // Only clear when leaving the column entirely.
    if (!cardsEl.contains(e.relatedTarget)) {
      cardsEl.classList.remove('drag-over');
    }
  });

  cardsEl.addEventListener('drop', (e) => {
    e.preventDefault();
    cardsEl.classList.remove('drag-over');
    const cardId = dragCardId || e.dataTransfer.getData('text/plain');
    if (!cardId) return;
    handleDrop(cardId, columnId, cardsEl, e.clientY);
  });
}

// Determine the card the dragged item would be inserted *before*, given a
// vertical cursor position. Returns the DOM element to insert before, or null
// to append at the end.
function getInsertBeforeEl(cardsEl, clientY) {
  const cards = [...cardsEl.querySelectorAll('.card:not(.dragging)')];
  for (const cardEl of cards) {
    const rect = cardEl.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    if (clientY < midpoint) return cardEl;
  }
  return null;
}

let placeholderEl = null;

function showPlaceholder(cardsEl, clientY) {
  if (!placeholderEl) {
    placeholderEl = document.createElement('div');
    placeholderEl.className = 'card-placeholder';
  }
  const beforeEl = getInsertBeforeEl(cardsEl, clientY);
  if (beforeEl) {
    cardsEl.insertBefore(placeholderEl, beforeEl);
  } else {
    cardsEl.appendChild(placeholderEl);
  }
}

function removePlaceholder() {
  if (placeholderEl && placeholderEl.parentNode) {
    placeholderEl.parentNode.removeChild(placeholderEl);
  }
  placeholderEl = null;
  document
    .querySelectorAll('.drag-over')
    .forEach((el) => el.classList.remove('drag-over'));
}

async function handleDrop(cardId, columnId, cardsEl, clientY) {
  const card = state.cards.get(cardId);
  if (!card) {
    removePlaceholder();
    return;
  }

  // Compute neighbor ids from the drop location, excluding the dragged card.
  const beforeEl = getInsertBeforeEl(cardsEl, clientY);
  const beforeId = beforeEl ? beforeEl.dataset.cardId : null;

  const ordered = cardsForColumn(columnId).filter((c) => c.id !== cardId);
  let afterId = null;
  if (beforeId) {
    const idx = ordered.findIndex((c) => c.id === beforeId);
    afterId = idx > 0 ? ordered[idx - 1].id : null;
  } else {
    afterId = ordered.length ? ordered[ordered.length - 1].id : null;
  }

  removePlaceholder();

  // --- Optimistic update: reposition the card immediately in the model. ---
  const optimisticPos = computeOptimisticPosition(columnId, afterId, beforeId, cardId);
  const prev = { column_id: card.column_id, position: card.position };
  upsertCard({ ...card, column_id: columnId, position: optimisticPos });
  render();

  // --- Reconcile against the server's authoritative ordering. ---
  try {
    const { card: canonical, renormalized } = await moveCard(cardId, {
      columnId,
      beforeId,
      afterId,
    });
    if (renormalized) {
      for (const c of renormalized) upsertCard(c);
    }
    // Snap to server's canonical position (may differ from the optimistic guess).
    upsertCard(canonical);
    render();
  } catch (err) {
    // Roll back the optimistic move on failure.
    const current = state.cards.get(cardId);
    if (current) upsertCard({ ...current, ...prev });
    render();
    console.error('Move failed:', err);
  }
}

// Mirror the server's fractional-position math so the optimistic order matches
// the eventual canonical order as closely as possible.
function computeOptimisticPosition(columnId, afterId, beforeId, movingId) {
  const STEP = 1000;
  const ordered = cardsForColumn(columnId).filter((c) => c.id !== movingId);
  const lower = afterId
    ? ordered.find((c) => c.id === afterId)?.position ?? null
    : null;
  const upper = beforeId
    ? ordered.find((c) => c.id === beforeId)?.position ?? null
    : null;

  if (lower == null && upper == null) return STEP;
  if (lower == null) return upper - STEP;
  if (upper == null) return lower + STEP;
  return (lower + upper) / 2;
}

// ---- SSE ------------------------------------------------------------------

function connectStream() {
  const es = new EventSource('/api/stream');

  es.addEventListener('open', () => setStatus('online'));
  es.addEventListener('error', () => setStatus('offline'));

  es.addEventListener('card.created', (e) => {
    const { card } = JSON.parse(e.data).payload;
    upsertCard(card);
    render();
  });

  es.addEventListener('card.moved', (e) => {
    const { card, renormalized } = JSON.parse(e.data).payload;
    if (renormalized) {
      for (const c of renormalized) upsertCard(c);
    }
    // Canonical state wins: this ensures convergence even if our optimistic
    // guess differed, and that a card lives in exactly one column.
    upsertCard(card);
    render();
  });
}

function setStatus(s) {
  statusEl.className = `status status--${s}`;
  statusEl.textContent =
    s === 'online' ? 'online' : s === 'offline' ? 'offline' : 'connecting…';
}

// ---- Utilities ------------------------------------------------------------

function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (ch) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[ch])
  );
}

// ---- Bootstrap ------------------------------------------------------------

async function init() {
  setStatus('connecting');
  try {
    const board = await fetchBoard();
    state.columns = board.columns.map((c) => ({ id: c.id, title: c.title }));
    state.cards.clear();
    for (const col of board.columns) {
      for (const card of col.cards) upsertCard(card);
    }
    render();
  } catch (err) {
    boardEl.innerHTML = `<p style="color:#e07a7a;padding:1rem;">Failed to load board: ${escapeHtml(
      err.message
    )}</p>`;
  }
  connectStream();
}

init();
