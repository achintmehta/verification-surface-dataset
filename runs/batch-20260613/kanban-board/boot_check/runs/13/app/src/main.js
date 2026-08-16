// Collaborative Kanban frontend.
// State model: an in-memory map mirroring server-authoritative board state.
// Drag-and-drop applies an optimistic DOM reposition, sends a move request,
// and reconciles against canonical state delivered via SSE / the PATCH response.

const boardEl = document.getElementById('board');
const connEl = document.getElementById('conn-status');

// --- State ---
// columns: ordered array of { id, title, position, cards: [{id, column_id, text, position}] }
let state = { columns: [] };
let columnOrder = [];

// --- API helpers ---
async function fetchBoard() {
  const res = await fetch('/api/board');
  if (!res.ok) throw new Error('failed to load board');
  return res.json();
}

async function apiCreateCard(columnId, text) {
  const res = await fetch('/api/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text }),
  });
  if (!res.ok) throw new Error('failed to create card');
  return res.json();
}

async function apiMoveCard(cardId, columnId, beforeId, afterId) {
  const res = await fetch(`/api/cards/${cardId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, beforeId, afterId }),
  });
  if (!res.ok) throw new Error('failed to move card');
  return res.json();
}

// --- State manipulation (authoritative) ---
function getColumn(columnId) {
  return state.columns.find((c) => Number(c.id) === Number(columnId));
}

// Remove a card from wherever it currently lives.
function removeCardEverywhere(cardId) {
  for (const col of state.columns) {
    const idx = col.cards.findIndex((c) => Number(c.id) === Number(cardId));
    if (idx !== -1) col.cards.splice(idx, 1);
  }
}

// Apply a canonical card (from server) ensuring it exists in exactly one column.
function applyCanonicalCard(card) {
  removeCardEverywhere(card.id);
  const col = getColumn(card.column_id);
  if (!col) return;
  col.cards.push({ ...card });
  col.cards.sort((a, b) => Number(a.position) - Number(b.position) || Number(a.id) - Number(b.id));
}

// Replace an entire column's card list with canonical ordering from server.
function applyCanonicalColumn(columnId, cards) {
  const col = getColumn(columnId);
  if (!col) return;
  // Remove any of these cards from other columns first (defensive against
  // a card appearing in two columns during cross-column moves).
  for (const c of cards) removeCardEverywhere(c.id);
  col.cards = cards
    .map((c) => ({ ...c }))
    .sort((a, b) => Number(a.position) - Number(b.position) || Number(a.id) - Number(b.id));
}

// --- Rendering ---
function render() {
  boardEl.innerHTML = '';
  for (const col of state.columns) {
    boardEl.appendChild(renderColumn(col));
  }
}

function renderColumn(col) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = col.id;

  const title = document.createElement('div');
  title.className = 'column-title';
  title.textContent = col.title;
  colEl.appendChild(title);

  const list = document.createElement('ul');
  list.className = 'cards';
  list.dataset.columnId = col.id;
  for (const card of col.cards) {
    list.appendChild(renderCard(card));
  }
  attachListDnD(list);
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
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(card.id));
  });
  li.addEventListener('dragend', () => {
    li.classList.remove('dragging');
    clearPlaceholders();
  });
  return li;
}

function renderAddCard(columnId) {
  const wrap = document.createElement('div');
  wrap.className = 'add-card';

  const btn = document.createElement('button');
  btn.className = 'add-card-btn';
  btn.textContent = '+ Add a card';
  wrap.appendChild(btn);

  btn.addEventListener('click', () => {
    wrap.innerHTML = '';
    const form = document.createElement('form');
    form.className = 'add-card-form';
    const ta = document.createElement('textarea');
    ta.placeholder = 'Enter a title for this card…';
    const actions = document.createElement('div');
    actions.className = 'add-card-actions';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'btn-primary';
    submit.textContent = 'Add card';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn-cancel';
    cancel.textContent = '✕';
    actions.append(submit, cancel);
    form.append(ta, actions);
    wrap.appendChild(form);
    ta.focus();

    const close = () => {
      wrap.innerHTML = '';
      wrap.appendChild(btn);
    };
    cancel.addEventListener('click', close);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text) return close();
      submit.disabled = true;
      try {
        // Server is authoritative; the SSE broadcast (or this response) adds it.
        const { card } = await apiCreateCard(columnId, text);
        applyCanonicalCard(card);
        render();
      } catch (err) {
        console.error(err);
        submit.disabled = false;
      }
    });
  });
  return wrap;
}

// --- Drag and drop ---
function clearPlaceholders() {
  document.querySelectorAll('.drop-placeholder').forEach((el) => el.remove());
  document.querySelectorAll('.cards.drag-over').forEach((el) => el.classList.remove('drag-over'));
}

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
  return closest.element;
}

function attachListDnD(list) {
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    list.classList.add('drag-over');
    const dragging = document.querySelector('.card.dragging');
    if (!dragging) return;
    const placeholder = ensurePlaceholder();
    const afterEl = getDragAfterElement(list, e.clientY);
    if (afterEl == null) {
      list.appendChild(placeholder);
    } else {
      list.insertBefore(placeholder, afterEl);
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
    const cardId = e.dataTransfer.getData('text/plain');
    const dragging = document.querySelector('.card.dragging');
    const placeholder = document.querySelector('.drop-placeholder');
    list.classList.remove('drag-over');
    if (!dragging || !placeholder) {
      clearPlaceholders();
      return;
    }

    // Optimistic DOM reposition: drop the card where the placeholder is.
    list.insertBefore(dragging, placeholder);
    placeholder.remove();

    const targetColumnId = Number(list.dataset.columnId);

    // Determine neighbors in the optimistic DOM order.
    const prev = dragging.previousElementSibling;
    const next = dragging.nextElementSibling;
    const afterId = prev && prev.classList.contains('card') ? Number(prev.dataset.cardId) : null;
    const beforeId = next && next.classList.contains('card') ? Number(next.dataset.cardId) : null;

    // Optimistically update local state too.
    optimisticMove(Number(cardId), targetColumnId, beforeId, afterId);

    try {
      const { card, columns } = await apiMoveCard(Number(cardId), targetColumnId, beforeId, afterId);
      // Reconcile against canonical state from the server response.
      if (columns) {
        for (const [cid, cards] of Object.entries(columns)) {
          applyCanonicalColumn(Number(cid), cards);
        }
      } else if (card) {
        applyCanonicalCard(card);
      }
      render();
    } catch (err) {
      console.error('move failed, resyncing', err);
      await resync();
    }
  });
}

let _placeholder = null;
function ensurePlaceholder() {
  if (_placeholder && document.body.contains(_placeholder)) return _placeholder;
  _placeholder = document.createElement('li');
  _placeholder.className = 'drop-placeholder';
  return _placeholder;
}

// Optimistically move a card in local state between afterId and beforeId.
function optimisticMove(cardId, columnId, beforeId, afterId) {
  // Pull the card object out (preserve its data).
  let moved = null;
  for (const col of state.columns) {
    const idx = col.cards.findIndex((c) => Number(c.id) === cardId);
    if (idx !== -1) {
      moved = col.cards.splice(idx, 1)[0];
      break;
    }
  }
  if (!moved) return;
  moved.column_id = columnId;
  const col = getColumn(columnId);
  if (!col) return;

  let insertIdx = col.cards.length;
  if (beforeId != null) {
    const bi = col.cards.findIndex((c) => Number(c.id) === Number(beforeId));
    if (bi !== -1) insertIdx = bi;
  } else if (afterId != null) {
    const ai = col.cards.findIndex((c) => Number(c.id) === Number(afterId));
    if (ai !== -1) insertIdx = ai + 1;
  }
  col.cards.splice(insertIdx, 0, moved);
}

// --- SSE ---
function connectSSE() {
  const es = new EventSource('/api/stream');

  es.addEventListener('open', () => setConn('online'));
  es.addEventListener('error', () => setConn('offline'));

  es.addEventListener('card.created', (e) => {
    const data = JSON.parse(e.data);
    applyCanonicalCard(data.card);
    render();
  });

  es.addEventListener('card.moved', (e) => {
    const data = JSON.parse(e.data);
    if (data.columns) {
      for (const [cid, cards] of Object.entries(data.columns)) {
        applyCanonicalColumn(Number(cid), cards);
      }
    } else if (data.card) {
      applyCanonicalCard(data.card);
    }
    render();
  });

  return es;
}

function setConn(status) {
  connEl.className = 'conn ' + status;
  connEl.textContent = status === 'online' ? 'live' : status === 'offline' ? 'reconnecting…' : 'connecting…';
}

// --- Bootstrap ---
async function resync() {
  const board = await fetchBoard();
  state.columns = board.columns.map((c) => ({
    ...c,
    cards: (c.cards || []).slice().sort((a, b) => Number(a.position) - Number(b.position) || Number(a.id) - Number(b.id)),
  }));
  columnOrder = state.columns.map((c) => c.id);
  render();
}

async function init() {
  try {
    await resync();
  } catch (err) {
    console.error(err);
    boardEl.innerHTML = '<p style="padding:20px;color:#e2483d">Failed to load board.</p>';
    return;
  }
  connectSSE();
}

init();
