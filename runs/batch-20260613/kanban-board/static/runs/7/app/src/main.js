import './styles.css';

const API = '';
const app = document.querySelector('#app');

let board = { columns: [] };
let draggedCardId = null;
let dragOverColumnId = null;
let pendingMoves = new Set();

app.innerHTML = `
  <header class="topbar">
    <div>
      <h1>Collaborative Kanban</h1>
      <p>Drag cards between columns. Changes are pushed to every connected client.</p>
    </div>
    <div id="connection-status" class="status status-warn">Connecting…</div>
  </header>
  <main id="board" class="board" aria-live="polite"></main>
`;

const boardEl = document.querySelector('#board');
const statusEl = document.querySelector('#connection-status');

function setStatus(text, kind = 'ok') {
  statusEl.textContent = text;
  statusEl.className = `status status-${kind}`;
}

function cloneBoard(value) {
  return {
    columns: value.columns.map((column) => ({
      ...column,
      cards: column.cards.map((card) => ({ ...card })),
    })),
  };
}

function sortBoard(value) {
  value.columns.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  for (const column of value.columns) {
    column.cards.sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  return value;
}

function setBoard(nextBoard) {
  board = sortBoard(cloneBoard(nextBoard));
  render();
}

function findColumn(columnId) {
  return board.columns.find((column) => column.id === columnId);
}

function findCard(cardId) {
  for (const column of board.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index !== -1) return { column, card: column.cards[index], index };
  }
  return null;
}

function removeCardEverywhere(cardId) {
  let removed = null;
  for (const column of board.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index !== -1) {
      const [card] = column.cards.splice(index, 1);
      removed = card;
    }
  }
  return removed;
}

function upsertCanonicalCard(card) {
  const next = cloneBoard(board);
  for (const column of next.columns) {
    column.cards = column.cards.filter((candidate) => candidate.id !== card.id);
  }
  const target = next.columns.find((column) => column.id === card.columnId);
  if (target) target.cards.push({ ...card });
  setBoard(next);
}

function cardHtml(card) {
  const pending = pendingMoves.has(card.id) ? '<span class="pending">syncing</span>' : '';
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}">
      <p>${escapeHtml(card.text)}</p>
      ${pending}
    </article>
  `;
}

function render() {
  boardEl.innerHTML = board.columns.map((column) => `
    <section class="column" data-column-id="${escapeHtml(column.id)}">
      <header class="column-header">
        <h2>${escapeHtml(column.title)}</h2>
        <span>${column.cards.length}</span>
      </header>
      <form class="add-card" data-column-id="${escapeHtml(column.id)}">
        <input name="text" type="text" maxlength="240" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="card-list" data-column-id="${escapeHtml(column.id)}">
        ${column.cards.map(cardHtml).join('')}
      </div>
    </section>
  `).join('');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function getDropIndex(listEl, clientY) {
  const cards = [...listEl.querySelectorAll('.card:not(.dragging)')];
  for (let index = 0; index < cards.length; index += 1) {
    const rect = cards[index].getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return index;
  }
  return cards.length;
}

function getMoveIntent(cardId, targetColumnId, targetIndex) {
  const targetColumn = findColumn(targetColumnId);
  if (!targetColumn) return null;

  const visibleCards = targetColumn.cards.filter((card) => card.id !== cardId);
  const after = visibleCards[targetIndex - 1] || null;
  const before = visibleCards[targetIndex] || null;
  return {
    columnId: targetColumnId,
    afterId: after?.id || null,
    beforeId: before?.id || null,
  };
}

function optimisticMove(cardId, targetColumnId, targetIndex) {
  const card = removeCardEverywhere(cardId);
  const targetColumn = findColumn(targetColumnId);
  if (!card || !targetColumn) return false;

  const boundedIndex = Math.max(0, Math.min(targetIndex, targetColumn.cards.length));
  card.columnId = targetColumnId;
  card.position = Date.now() / 1000;
  targetColumn.cards.splice(boundedIndex, 0, card);
  render();
  return true;
}

async function loadBoard() {
  const response = await fetch(`${API}/api/board`);
  if (!response.ok) throw new Error('Failed to load board');
  setBoard(await response.json());
}

async function createCard(columnId, text) {
  const response = await fetch(`${API}/api/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to create card');
  }
  return response.json();
}

async function moveCard(cardId, intent) {
  pendingMoves.add(cardId);
  render();
  try {
    const response = await fetch(`${API}/api/cards/${encodeURIComponent(cardId)}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(intent),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to move card');
    }
    const card = await response.json();
    pendingMoves.delete(cardId);
    upsertCanonicalCard(card);
  } catch (error) {
    pendingMoves.delete(cardId);
    console.error(error);
    setStatus('Move failed; reloading canonical board', 'bad');
    await loadBoard();
  }
}

boardEl.addEventListener('submit', async (event) => {
  const form = event.target.closest('.add-card');
  if (!form) return;
  event.preventDefault();
  const input = form.elements.text;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  try {
    await createCard(form.dataset.columnId, text);
  } catch (error) {
    console.error(error);
    input.value = text;
    setStatus(error.message, 'bad');
  }
});

boardEl.addEventListener('dragstart', (event) => {
  const cardEl = event.target.closest('.card');
  if (!cardEl) return;
  draggedCardId = cardEl.dataset.cardId;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggedCardId);
  requestAnimationFrame(() => cardEl.classList.add('dragging'));
});

boardEl.addEventListener('dragend', () => {
  draggedCardId = null;
  dragOverColumnId = null;
  document.querySelectorAll('.dragging, .drop-target').forEach((el) => el.classList.remove('dragging', 'drop-target'));
});

boardEl.addEventListener('dragover', (event) => {
  const list = event.target.closest('.card-list');
  if (!list || !draggedCardId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  dragOverColumnId = list.dataset.columnId;
  document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
  list.classList.add('drop-target');
});

boardEl.addEventListener('drop', (event) => {
  const list = event.target.closest('.card-list');
  const cardId = draggedCardId || event.dataTransfer.getData('text/plain');
  if (!list || !cardId) return;
  event.preventDefault();

  const columnId = list.dataset.columnId;
  const targetIndex = getDropIndex(list, event.clientY);
  const intent = getMoveIntent(cardId, columnId, targetIndex);
  if (!intent) return;

  const current = findCard(cardId);
  const visibleTargetCards = findColumn(columnId)?.cards.filter((card) => card.id !== cardId) || [];
  const alreadyThere = current?.column.id === columnId
    && visibleTargetCards[targetIndex - 1]?.id === intent.afterId
    && visibleTargetCards[targetIndex]?.id === intent.beforeId;
  if (alreadyThere) return;

  optimisticMove(cardId, columnId, targetIndex);
  moveCard(cardId, intent);
});

function connectStream() {
  const stream = new EventSource(`${API}/api/stream`);

  stream.addEventListener('open', () => setStatus('Live', 'ok'));
  stream.addEventListener('connected', () => setStatus('Live', 'ok'));
  stream.addEventListener('ping', () => setStatus('Live', 'ok'));

  stream.addEventListener('board', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.board) {
      if (payload.card?.id) pendingMoves.delete(payload.card.id);
      setBoard(payload.board);
      setStatus('Live', 'ok');
    }
  });

  stream.addEventListener('card-created', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.card) upsertCanonicalCard(payload.card);
  });

  stream.addEventListener('card-moved', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.card) {
      pendingMoves.delete(payload.card.id);
      upsertCanonicalCard(payload.card);
    }
  });

  stream.addEventListener('error', () => {
    setStatus('Reconnecting…', 'warn');
  });
}

loadBoard()
  .then(() => {
    connectStream();
  })
  .catch((error) => {
    console.error(error);
    setStatus('Unable to load board', 'bad');
  });
