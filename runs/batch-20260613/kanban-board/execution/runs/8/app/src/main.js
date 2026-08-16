import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || '';
const app = document.querySelector('#app');

const state = {
  columns: [],
  columnsById: new Map(),
  cardsById: new Map(),
  draggingId: null,
  pendingMoves: new Map(),
  stream: null,
};

app.innerHTML = `
  <header class="topbar">
    <div>
      <h1>Collaborative Kanban</h1>
      <p>Drag cards between columns. Updates stream to every connected client.</p>
    </div>
    <div id="connection-status" class="status">Connecting…</div>
  </header>
  <main id="board" class="board" aria-live="polite"></main>
`;

const boardEl = document.querySelector('#board');
const statusEl = document.querySelector('#connection-status');

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function sortCards(cards) {
  return [...cards].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    return String(a.created_at || '').localeCompare(String(b.created_at || '')) || a.id.localeCompare(b.id);
  });
}

function setBoard(board) {
  state.columns = (board.columns || []).map((column) => ({
    ...column,
    cards: sortCards(column.cards || []),
  }));
  rebuildIndexes();
  renderBoard();
}

function rebuildIndexes() {
  state.columnsById = new Map();
  state.cardsById = new Map();

  for (const column of state.columns) {
    column.cards = sortCards(column.cards || []);
    state.columnsById.set(column.id, column);
    for (const card of column.cards) {
      state.cardsById.set(card.id, card);
    }
  }
}

function findCardLocation(cardId) {
  for (const column of state.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index !== -1) return { column, index };
  }
  return null;
}

function removeCardFromAllColumns(cardId) {
  let removed = null;
  for (const column of state.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index !== -1) {
      const [card] = column.cards.splice(index, 1);
      removed = card;
    }
  }
  return removed;
}

function applyCanonicalCard(card) {
  const canonical = { ...card, position: Number(card.position) };
  removeCardFromAllColumns(canonical.id);
  const column = state.columnsById.get(canonical.column_id);
  if (!column) return;
  column.cards.push(canonical);
  column.cards = sortCards(column.cards);
  state.cardsById.set(canonical.id, canonical);
  state.pendingMoves.delete(canonical.id);
  renderBoard();
}

function renderBoard() {
  boardEl.innerHTML = state.columns
    .map(
      (column) => `
        <section class="column" data-column-id="${escapeHtml(column.id)}">
          <div class="column__header">
            <h2>${escapeHtml(column.title)}</h2>
            <span class="count">${column.cards.length}</span>
          </div>
          <form class="add-card" data-column-id="${escapeHtml(column.id)}">
            <input type="text" name="text" placeholder="Add a card…" maxlength="200" autocomplete="off" />
            <button type="submit">Add</button>
          </form>
          <div class="card-list" data-column-id="${escapeHtml(column.id)}">
            ${column.cards
              .map(
                (card) => `
                  <article class="card${state.pendingMoves.has(card.id) ? ' card--pending' : ''}" draggable="true" data-card-id="${escapeHtml(card.id)}">
                    <p>${escapeHtml(card.text)}</p>
                  </article>
                `,
              )
              .join('')}
          </div>
        </section>
      `,
    )
    .join('');
}

function getColumnIdFromDropTarget(target) {
  const list = target.closest?.('.card-list');
  if (list) return list.dataset.columnId;
  const column = target.closest?.('.column');
  return column?.dataset.columnId || null;
}

function getInsertContext(target, draggedId) {
  const list = target.closest?.('.card-list') || target.querySelector?.('.card-list');
  if (!list) return { beforeId: null, afterId: null };

  const cards = [...list.querySelectorAll('.card:not(.dragging)')].filter((el) => el.dataset.cardId !== draggedId);
  const mouseY = window.__lastDragY ?? 0;

  let beforeEl = null;
  for (const cardEl of cards) {
    const rect = cardEl.getBoundingClientRect();
    if (mouseY < rect.top + rect.height / 2) {
      beforeEl = cardEl;
      break;
    }
  }

  const beforeId = beforeEl?.dataset.cardId || null;
  let afterId = null;
  if (beforeEl) {
    const index = cards.indexOf(beforeEl);
    afterId = index > 0 ? cards[index - 1].dataset.cardId : null;
  } else {
    afterId = cards.length ? cards[cards.length - 1].dataset.cardId : null;
  }

  return { beforeId, afterId };
}

function optimisticMove(cardId, columnId, beforeId, afterId) {
  const existing = removeCardFromAllColumns(cardId);
  if (!existing) return;

  const targetColumn = state.columnsById.get(columnId);
  if (!targetColumn) return;

  let insertIndex = targetColumn.cards.length;
  if (beforeId) {
    const beforeIndex = targetColumn.cards.findIndex((card) => card.id === beforeId);
    if (beforeIndex !== -1) insertIndex = beforeIndex;
  } else if (afterId) {
    const afterIndex = targetColumn.cards.findIndex((card) => card.id === afterId);
    if (afterIndex !== -1) insertIndex = afterIndex + 1;
  }

  const optimisticCard = { ...existing, column_id: columnId, optimistic: true };
  targetColumn.cards.splice(insertIndex, 0, optimisticCard);
  state.cardsById.set(cardId, optimisticCard);
  state.pendingMoves.set(cardId, { columnId, beforeId, afterId });
  renderBoard();
}

async function createCard(columnId, text, form) {
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const response = await fetch(`${API_BASE}/api/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Unable to create card');
    form.reset();
    const payload = await response.json();
    if (payload.board) setBoard(payload.board);
    else if (payload.card) applyCanonicalCard(payload.card);
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
}

async function sendMove(cardId, columnId, beforeId, afterId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Unable to move card');
    const payload = await response.json();
    if (payload.board) setBoard(payload.board);
    else if (payload.card) applyCanonicalCard(payload.card);
  } catch (error) {
    console.error(error);
    await loadBoard();
  }
}

async function loadBoard() {
  const response = await fetch(`${API_BASE}/api/board`);
  if (!response.ok) throw new Error('Unable to load board');
  setBoard(await response.json());
}

function connectStream() {
  if (state.stream) state.stream.close();
  const stream = new EventSource(`${API_BASE}/api/stream`);
  state.stream = stream;

  stream.addEventListener('open', () => {
    statusEl.textContent = 'Live';
    statusEl.className = 'status status--live';
  });

  stream.addEventListener('error', () => {
    statusEl.textContent = 'Reconnecting…';
    statusEl.className = 'status status--stale';
  });

  stream.addEventListener('board', (event) => setBoard(JSON.parse(event.data)));
  stream.addEventListener('create', (event) => {
    const { card } = JSON.parse(event.data);
    applyCanonicalCard(card);
  });
  stream.addEventListener('move', (event) => {
    const { card } = JSON.parse(event.data);
    applyCanonicalCard(card);
  });
  stream.addEventListener('column-order', async () => {
    // A renormalization means many positions may have changed. The following board
    // event normally arrives too; reloading is a safe fallback if event ordering is odd.
    await loadBoard().catch(console.error);
  });
}

boardEl.addEventListener('submit', (event) => {
  const form = event.target.closest('.add-card');
  if (!form) return;
  event.preventDefault();
  const text = new FormData(form).get('text')?.trim();
  if (!text) return;
  createCard(form.dataset.columnId, text, form);
});

boardEl.addEventListener('dragstart', (event) => {
  const card = event.target.closest('.card');
  if (!card) return;
  state.draggingId = card.dataset.cardId;
  card.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', state.draggingId);
});

boardEl.addEventListener('dragend', (event) => {
  event.target.closest('.card')?.classList.remove('dragging');
  document.querySelectorAll('.card-list--over').forEach((el) => el.classList.remove('card-list--over'));
  state.draggingId = null;
});

boardEl.addEventListener('dragover', (event) => {
  const columnId = getColumnIdFromDropTarget(event.target);
  if (!columnId || !state.draggingId) return;
  event.preventDefault();
  window.__lastDragY = event.clientY;
  document.querySelectorAll('.card-list--over').forEach((el) => el.classList.remove('card-list--over'));
  const list = event.target.closest('.card-list') || event.target.closest('.column')?.querySelector('.card-list');
  list?.classList.add('card-list--over');
});

boardEl.addEventListener('drop', (event) => {
  const cardId = event.dataTransfer.getData('text/plain') || state.draggingId;
  const columnId = getColumnIdFromDropTarget(event.target);
  if (!cardId || !columnId) return;
  event.preventDefault();
  const { beforeId, afterId } = getInsertContext(event.target.closest('.card-list') || event.target.closest('.column'), cardId);

  optimisticMove(cardId, columnId, beforeId, afterId);
  sendMove(cardId, columnId, beforeId, afterId);
});

loadBoard()
  .then(connectStream)
  .catch((error) => {
    statusEl.textContent = 'Offline';
    statusEl.className = 'status status--stale';
    boardEl.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
  });
