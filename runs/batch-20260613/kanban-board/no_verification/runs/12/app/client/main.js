// Collaborative Kanban frontend.
//
// State model:
//   state.columns: ordered array of { id, title, position }
//   state.cards:   Map<cardId, { id, column_id, text, position, created_at }>
//
// The DOM is rendered from this state. Drag-and-drop produces optimistic
// local mutations, sends intent to the server, and the SSE stream delivers
// canonical state that we reconcile against.

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');

const state = {
  columns: [],
  cards: new Map()
};

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

async function fetchBoard() {
  const res = await fetch('/api/board');
  if (!res.ok) throw new Error('Failed to load board');
  return res.json();
}

async function postCard(columnId, text) {
  const res = await fetch('/api/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text })
  });
  if (!res.ok) throw new Error('Failed to create card');
  return res.json();
}

async function patchMove(cardId, payload) {
  const res = await fetch(`/api/cards/${cardId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('Failed to move card');
  return res.json();
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function loadState(board) {
  state.columns = board.columns.map((c) => ({
    id: c.id,
    title: c.title,
    position: c.position
  }));
  state.cards.clear();
  for (const col of board.columns) {
    for (const card of col.cards) {
      state.cards.set(card.id, { ...card });
    }
  }
}

function cardsForColumn(columnId) {
  const list = [];
  for (const card of state.cards.values()) {
    if (card.column_id === columnId) list.push(card);
  }
  list.sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return list;
}

// Upsert a card from canonical (server) data, ensuring it lives in exactly
// one column. Because cards are keyed by id, replacing the entry guarantees
// no duplication.
function upsertCard(card) {
  state.cards.set(card.id, { ...card });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  boardEl.innerHTML = '';
  for (const col of state.columns) {
    boardEl.appendChild(renderColumn(col));
  }
}

function renderColumn(col) {
  const columnEl = document.createElement('section');
  columnEl.className = 'column';
  columnEl.dataset.columnId = col.id;

  const title = document.createElement('div');
  title.className = 'column__title';
  title.textContent = col.title;
  columnEl.appendChild(title);

  const cardsEl = document.createElement('div');
  cardsEl.className = 'column__cards';
  cardsEl.dataset.columnId = col.id;

  for (const card of cardsForColumn(col.id)) {
    cardsEl.appendChild(renderCard(card));
  }

  attachColumnDnD(cardsEl);
  columnEl.appendChild(cardsEl);
  columnEl.appendChild(renderAddCard(col.id));

  return columnEl;
}

function renderCard(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.dataset.cardId = card.id;
  el.textContent = card.text;
  attachCardDnD(el);
  return el;
}

function renderAddCard(columnId) {
  const wrap = document.createElement('div');
  wrap.className = 'add-card';

  const toggle = document.createElement('button');
  toggle.className = 'add-card__toggle';
  toggle.textContent = '+ Add a card';

  const form = document.createElement('div');
  form.className = 'hidden';

  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Enter card text…';

  const actions = document.createElement('div');
  actions.className = 'add-card__actions';

  const submit = document.createElement('button');
  submit.className = 'add-card__submit';
  submit.textContent = 'Add';

  const cancel = document.createElement('button');
  cancel.className = 'add-card__cancel';
  cancel.textContent = 'Cancel';

  actions.append(submit, cancel);
  form.append(textarea, actions);
  wrap.append(toggle, form);

  function open() {
    form.classList.remove('hidden');
    toggle.classList.add('hidden');
    textarea.focus();
  }
  function close() {
    form.classList.add('hidden');
    toggle.classList.remove('hidden');
    textarea.value = '';
  }
  async function commit() {
    const text = textarea.value.trim();
    if (!text) return close();
    close();
    try {
      // Server broadcasts the created card; SSE will add it for us.
      await postCard(columnId, text);
    } catch (err) {
      console.error(err);
    }
  }

  toggle.addEventListener('click', open);
  cancel.addEventListener('click', close);
  submit.addEventListener('click', commit);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      close();
    }
  });

  return wrap;
}

// ---------------------------------------------------------------------------
// Drag and drop
// ---------------------------------------------------------------------------

let draggingId = null;

function attachCardDnD(cardEl) {
  cardEl.addEventListener('dragstart', (e) => {
    draggingId = cardEl.dataset.cardId;
    cardEl.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', draggingId);
  });

  cardEl.addEventListener('dragend', () => {
    draggingId = null;
    cardEl.classList.remove('dragging');
    clearPlaceholders();
  });
}

function attachColumnDnD(cardsEl) {
  cardsEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    showPlaceholder(cardsEl, e.clientY);
  });

  cardsEl.addEventListener('dragleave', (e) => {
    // Only clear when leaving the whole column body.
    if (!cardsEl.contains(e.relatedTarget)) {
      cardsEl.classList.remove('drag-over');
    }
  });

  cardsEl.addEventListener('drop', (e) => {
    e.preventDefault();
    const cardId = draggingId || e.dataTransfer.getData('text/plain');
    if (!cardId) return;
    handleDrop(cardsEl, cardId);
  });
}

function getPlaceholder() {
  let ph = document.querySelector('.card-placeholder');
  if (!ph) {
    ph = document.createElement('div');
    ph.className = 'card-placeholder';
  }
  return ph;
}

function clearPlaceholders() {
  document.querySelectorAll('.card-placeholder').forEach((el) => el.remove());
  document.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
}

// Position the placeholder where the dragged card would land.
function showPlaceholder(cardsEl, clientY) {
  cardsEl.classList.add('drag-over');
  const ph = getPlaceholder();
  const siblings = [...cardsEl.querySelectorAll('.card:not(.dragging)')];

  let inserted = false;
  for (const sib of siblings) {
    const rect = sib.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    if (clientY < midpoint) {
      cardsEl.insertBefore(ph, sib);
      inserted = true;
      break;
    }
  }
  if (!inserted) cardsEl.appendChild(ph);
}

function handleDrop(cardsEl, cardId) {
  const columnId = cardsEl.dataset.columnId;
  const ph = cardsEl.querySelector('.card-placeholder');

  // Determine neighbours from the placeholder position.
  let afterId = null;
  let beforeId = null;
  if (ph) {
    const prev = ph.previousElementSibling;
    const next = ph.nextElementSibling;
    if (prev && prev.classList.contains('card')) afterId = prev.dataset.cardId;
    if (next && next.classList.contains('card')) beforeId = next.dataset.cardId;
  }

  clearPlaceholders();

  // Optimistic update: reposition the card in local state.
  optimisticMove(cardId, columnId, afterId, beforeId);
  render();

  // Send intent; SSE will deliver canonical state for reconciliation.
  patchMove(cardId, { columnId, afterId, beforeId }).catch((err) => {
    console.error('Move failed, reloading authoritative state', err);
    init();
  });
}

// Apply an optimistic local move by computing a fractional position between
// the neighbours, mirroring the server logic so the DOM matches immediately.
function optimisticMove(cardId, columnId, afterId, beforeId) {
  const card = state.cards.get(cardId);
  if (!card) return;

  const afterCard = afterId ? state.cards.get(afterId) : null;
  const beforeCard = beforeId ? state.cards.get(beforeId) : null;

  const afterPos = afterCard && afterCard.column_id === columnId ? afterCard.position : null;
  const beforePos = beforeCard && beforeCard.column_id === columnId ? beforeCard.position : null;

  let position;
  const STEP = 1000;
  if (afterPos === null && beforePos === null) position = STEP;
  else if (afterPos === null) position = beforePos - STEP;
  else if (beforePos === null) position = afterPos + STEP;
  else position = afterPos + (beforePos - afterPos) / 2;

  card.column_id = columnId;
  card.position = position;
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

let evtSource = null;

function connectSSE() {
  if (evtSource) evtSource.close();
  evtSource = new EventSource('/api/stream');

  evtSource.addEventListener('open', () => setStatus('connected'));
  evtSource.addEventListener('error', () => setStatus('disconnected'));

  evtSource.addEventListener('card:created', (e) => {
    const { card } = JSON.parse(e.data);
    upsertCard(card);
    render();
  });

  evtSource.addEventListener('card:moved', (e) => {
    const { card } = JSON.parse(e.data);
    // Canonical state replaces any optimistic guess; keyed by id => no dupes.
    upsertCard(card);
    render();
  });

  evtSource.addEventListener('column:reordered', (e) => {
    const { cards } = JSON.parse(e.data);
    // Server renormalized the column; adopt exact canonical positions.
    for (const card of cards) upsertCard(card);
    render();
  });
}

function setStatus(kind) {
  statusEl.className = `status status--${kind}`;
  statusEl.textContent = kind;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  try {
    const board = await fetchBoard();
    loadState(board);
    render();
  } catch (err) {
    console.error(err);
  }
}

init().then(connectSSE);
