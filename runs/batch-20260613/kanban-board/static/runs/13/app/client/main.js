import { fetchBoard, createCard, moveCard } from './api.js';
import { createStore } from './store.js';

const store = createStore();
const boardEl = document.getElementById('board');
const connDot = document.getElementById('conn-dot');
const connText = document.getElementById('conn-text');

// Tracks the card id currently being dragged (within this client).
let draggingId = null;
// A single reusable placeholder element shown at the prospective drop slot.
const placeholder = document.createElement('li');
placeholder.className = 'card-placeholder';

// Tracks which column currently has an open "add card" composer.
let composerColumnId = null;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  // Build the entire board from the store. Because the store keys cards by id,
  // a card can render in exactly one column.
  boardEl.innerHTML = '';
  for (const col of store.getColumns()) {
    boardEl.appendChild(renderColumn(col));
  }
}

function renderColumn(col) {
  const colEl = document.createElement('section');
  colEl.className = 'column';
  colEl.dataset.columnId = col.id;

  const cards = store.getCardsForColumn(col.id);

  const title = document.createElement('div');
  title.className = 'column__title';
  title.innerHTML = `<span>${escapeHtml(col.title)}</span><span class="column__count">${cards.length}</span>`;
  colEl.appendChild(title);

  const list = document.createElement('ul');
  list.className = 'cards';
  list.dataset.columnId = col.id;

  for (const card of cards) {
    list.appendChild(renderCard(card));
  }

  attachDropHandlers(list, col.id);
  colEl.appendChild(list);

  colEl.appendChild(renderComposer(col.id));
  return colEl;
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
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.id);
    // Defer so the drag image is captured before the opacity change.
    requestAnimationFrame(() => li.classList.add('dragging'));
  });

  li.addEventListener('dragend', () => {
    li.classList.remove('dragging');
    draggingId = null;
    if (placeholder.parentNode) placeholder.remove();
  });

  return li;
}

function renderComposer(columnId) {
  const wrap = document.createElement('div');
  wrap.className = 'add-card';

  if (composerColumnId === columnId) {
    const form = document.createElement('form');
    form.className = 'add-card__form';

    const input = document.createElement('textarea');
    input.className = 'add-card__input';
    input.rows = 2;
    input.placeholder = 'Enter a title for this card…';

    const actions = document.createElement('div');
    actions.className = 'add-card__actions';

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'btn btn--primary';
    submit.textContent = 'Add card';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn--ghost';
    cancel.textContent = 'Cancel';

    actions.append(submit, cancel);
    form.append(input, actions);
    wrap.appendChild(form);

    cancel.addEventListener('click', () => {
      composerColumnId = null;
      render();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      composerColumnId = columnId;
      try {
        // The created card arrives back via SSE (and the POST response) and is
        // upserted into the store, so we don't mutate the store here directly.
        await createCard(columnId, text);
        input.value = '';
        input.focus();
      } catch (err) {
        // eslint-disable-next-line no-alert
        console.error('Failed to create card', err);
      }
    });

    // Focus after insertion into the DOM.
    requestAnimationFrame(() => input.focus());
  } else {
    const btn = document.createElement('button');
    btn.className = 'add-card__btn';
    btn.textContent = '+ Add a card';
    btn.addEventListener('click', () => {
      composerColumnId = columnId;
      render();
    });
    wrap.appendChild(btn);
  }

  return wrap;
}

// ---------------------------------------------------------------------------
// Drag & drop
// ---------------------------------------------------------------------------

function attachDropHandlers(list, columnId) {
  list.addEventListener('dragover', (e) => {
    if (!draggingId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    list.classList.add('drag-over');
    positionPlaceholder(list, e.clientY);
  });

  list.addEventListener('dragleave', (e) => {
    // Only clear when leaving the list entirely (not moving between children).
    if (e.relatedTarget && list.contains(e.relatedTarget)) return;
    list.classList.remove('drag-over');
  });

  list.addEventListener('drop', async (e) => {
    e.preventDefault();
    list.classList.remove('drag-over');
    const cardId = draggingId;
    if (!cardId) return;

    // Determine the neighbours at the drop slot from the placeholder location.
    const { afterId, beforeId } = neighboursAtPlaceholder(list, cardId);
    if (placeholder.parentNode) placeholder.remove();

    await commitMove(cardId, columnId, { afterId, beforeId });
  });
}

/**
 * Inserts the placeholder at the correct slot based on cursor Y position,
 * skipping the card currently being dragged.
 */
function positionPlaceholder(list, clientY) {
  const cards = [...list.querySelectorAll('.card')].filter(
    (el) => el.dataset.cardId !== draggingId
  );

  let reference = null;
  for (const el of cards) {
    const rect = el.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    if (clientY < midpoint) {
      reference = el;
      break;
    }
  }

  if (reference) {
    list.insertBefore(placeholder, reference);
  } else {
    list.appendChild(placeholder);
  }
}

/**
 * Reads the card ids immediately above (afterId) and below (beforeId) the
 * placeholder, ignoring the dragged card itself.
 */
function neighboursAtPlaceholder(list, cardId) {
  if (!placeholder.parentNode || placeholder.parentNode !== list) {
    return { afterId: null, beforeId: null };
  }

  let afterId = null;
  let prev = placeholder.previousElementSibling;
  while (prev) {
    if (prev.classList.contains('card') && prev.dataset.cardId !== cardId) {
      afterId = prev.dataset.cardId;
      break;
    }
    prev = prev.previousElementSibling;
  }

  let beforeId = null;
  let next = placeholder.nextElementSibling;
  while (next) {
    if (next.classList.contains('card') && next.dataset.cardId !== cardId) {
      beforeId = next.dataset.cardId;
      break;
    }
    next = next.nextElementSibling;
  }

  return { afterId, beforeId };
}

/**
 * Optimistically applies the move locally, then sends the canonical request.
 * The server response (and the broadcast SSE event) reconciles the position.
 */
async function commitMove(cardId, columnId, { afterId, beforeId }) {
  const card = store.getCard(cardId);
  if (!card) return;

  // Optimistic position: midpoint of the local neighbours, or append/prepend.
  const optimisticPos = optimisticPosition(columnId, afterId, beforeId, cardId);
  store.upsertCard({ ...card, columnId, position: optimisticPos });
  render();

  try {
    const result = await moveCard(cardId, { columnId, afterId, beforeId });
    // Reconcile against the server's authoritative ordering.
    if (result.normalized) {
      store.applyNormalized(result.normalized);
    }
    store.upsertCard(result.card);
    render();
  } catch (err) {
    // On failure, fall back to the server's truth.
    console.error('Move failed, refetching board', err);
    await reload();
  }
}

/**
 * Computes a local optimistic position consistent with the server's midpoint
 * strategy, using the current store state.
 */
function optimisticPosition(columnId, afterId, beforeId, movingId) {
  const STEP = 1000;
  const siblings = store
    .getCardsForColumn(columnId)
    .filter((c) => c.id !== movingId);

  const after = afterId ? store.getCard(afterId) : null;
  const before = beforeId ? store.getCard(beforeId) : null;

  const lower = after && after.columnId === columnId ? after.position : null;
  const upper = before && before.columnId === columnId ? before.position : null;

  if (lower !== null && upper !== null) return (lower + upper) / 2;
  if (lower !== null) {
    // append after `lower`: use next sibling above lower if any.
    return lower + STEP;
  }
  if (upper !== null) {
    return upper - STEP;
  }
  // Empty column or no neighbours: append at the end.
  if (siblings.length === 0) return STEP;
  return siblings[siblings.length - 1].position + STEP;
}

// ---------------------------------------------------------------------------
// SSE real-time sync
// ---------------------------------------------------------------------------

function connectStream() {
  const es = new EventSource('/api/stream');

  es.addEventListener('hello', () => setConnected(true));

  es.addEventListener('card:create', (e) => {
    const { card } = JSON.parse(e.data);
    store.upsertCard(card);
    render();
  });

  es.addEventListener('card:move', (e) => {
    const { card, normalized } = JSON.parse(e.data);
    if (normalized) store.applyNormalized(normalized);
    // Upsert the moved card; because it's keyed by id it lands in exactly one
    // column — never duplicated.
    store.upsertCard(card);
    render();
  });

  es.onopen = () => setConnected(true);
  es.onerror = () => {
    setConnected(false);
    // EventSource auto-reconnects; nothing else to do.
  };
}

function setConnected(ok) {
  connDot.className = `dot ${ok ? 'dot--on' : 'dot--off'}`;
  connText.textContent = ok ? 'live' : 'reconnecting…';
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function reload() {
  const board = await fetchBoard();
  store.setBoard(board);
  render();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function init() {
  try {
    await reload();
  } catch (err) {
    console.error('Failed to load board', err);
    boardEl.innerHTML =
      '<p style="color:#f5703e;padding:20px">Failed to load board. Is the server running?</p>';
  }
  connectStream();
}

init();
