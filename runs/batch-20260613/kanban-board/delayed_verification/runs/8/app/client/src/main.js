import './styles.css';

const API_BASE = import.meta.env.VITE_API_URL || (location.port === '5173' ? 'http://localhost:3000' : '');
const app = document.querySelector('#app');

let board = { columns: [] };
let eventSource;
const pendingMoves = new Set();

app.innerHTML = `
  <main class="app-shell">
    <header class="topbar">
      <h1>Collaborative Kanban</h1>
      <span id="connection-status" class="status disconnected"><span class="status-dot"></span><span>Connecting…</span></span>
    </header>
    <section id="messages"></section>
    <section id="board" class="board" aria-label="Kanban board"></section>
  </main>
`;

const boardEl = document.querySelector('#board');
const messagesEl = document.querySelector('#messages');
const statusEl = document.querySelector('#connection-status');

function setStatus(state, label) {
  statusEl.className = `status ${state}`;
  statusEl.querySelector('span:last-child').textContent = label;
}

function showError(message) {
  messagesEl.innerHTML = `<div class="error">${escapeHtml(message)}</div>`;
  setTimeout(() => {
    if (messagesEl.textContent.includes(message)) messagesEl.innerHTML = '';
  }, 5000);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function sortBoard(input) {
  return {
    columns: [...(input.columns || [])]
      .map((column) => ({
        ...column,
        cards: [...(column.cards || [])].sort(compareCards)
      }))
      .sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id))
  };
}

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.created_at || '').localeCompare(String(b.created_at || '')) || a.id.localeCompare(b.id);
}

function render() {
  board = sortBoard(board);
  boardEl.innerHTML = '';

  for (const column of board.columns) {
    const columnEl = document.createElement('article');
    columnEl.className = 'column';
    columnEl.dataset.columnId = column.id;
    columnEl.innerHTML = `
      <div class="column-header">
        <h2>${escapeHtml(column.title)}</h2>
        <span class="count">${column.cards.length}</span>
      </div>
      <div class="card-list" data-column-id="${escapeHtml(column.id)}"></div>
      <form class="add-card-form" data-column-id="${escapeHtml(column.id)}">
        <input name="text" autocomplete="off" maxlength="300" placeholder="Add a card…" aria-label="New card text for ${escapeHtml(column.title)}" />
        <button type="submit">Add</button>
      </form>
    `;

    const listEl = columnEl.querySelector('.card-list');
    if (column.cards.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'empty';
      emptyEl.textContent = 'Drop cards here';
      listEl.append(emptyEl);
    }

    for (const card of column.cards) {
      listEl.append(createCardElement(card));
    }

    boardEl.append(columnEl);
  }
}

function createCardElement(card) {
  const cardEl = document.createElement('div');
  cardEl.className = `card${pendingMoves.has(card.id) ? ' pending' : ''}`;
  cardEl.draggable = true;
  cardEl.dataset.cardId = card.id;
  cardEl.textContent = card.text;
  cardEl.title = 'Drag to move or reorder';
  return cardEl;
}

async function loadBoard() {
  const response = await fetch(`${API_BASE}/api/board`);
  if (!response.ok) throw new Error('Unable to load board');
  board = sortBoard(await response.json());
  render();
}

function connectStream() {
  eventSource?.close();
  eventSource = new EventSource(`${API_BASE}/api/stream`);
  eventSource.onopen = () => setStatus('connected', 'Live');
  eventSource.onerror = () => setStatus('disconnected', 'Reconnecting…');
  eventSource.addEventListener('board', (event) => {
    try {
      const message = JSON.parse(event.data);
        if (message.board) {
        // The server sends the committed, authoritative board after every
        // mutation. Replacing local state avoids duplicate cards and reconciles
        // any optimistic order that differs from the canonical fractional order.
        board = sortBoard(message.board);
        if (message.card?.id) pendingMoves.delete(message.card.id);
        render();
      }
    } catch (error) {
      console.error('Bad SSE payload', error);
    }
  });
}

function findColumn(columnId) {
  return board.columns.find((column) => column.id === columnId);
}

function removeCardFromBoard(cardId) {
  for (const column of board.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index !== -1) {
      return column.cards.splice(index, 1)[0];
    }
  }
  return null;
}

function applyOptimisticMove(cardId, targetColumnId, orderIds) {
  const card = removeCardFromBoard(cardId);
  const targetColumn = findColumn(targetColumnId);
  if (!card || !targetColumn) return;

  card.column_id = targetColumnId;
  const targetIndex = Math.max(0, orderIds.indexOf(cardId));
  targetColumn.cards.splice(targetIndex, 0, card);

  // Assign temporary monotonic positions purely so this client's render matches
  // the drop immediately. The next SSE board replaces these guesses.
  targetColumn.cards.forEach((item, index) => {
    item.position = (index + 1) * 1000;
  });
  pendingMoves.add(cardId);
  render();
}

function getDropIntent(listEl, cardId) {
  const ids = [...listEl.querySelectorAll('.card')].map((card) => card.dataset.cardId);
  const index = ids.indexOf(cardId);
  return {
    columnId: listEl.dataset.columnId,
    afterId: index > 0 ? ids[index - 1] : null,
    beforeId: index !== -1 && index < ids.length - 1 ? ids[index + 1] : null,
    orderIds: ids
  };
}

function getCardAfterPointer(listEl, y) {
  const cards = [...listEl.querySelectorAll('.card:not(.dragging)')];
  return cards.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) return { offset, element: child };
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null }
  ).element;
}

boardEl.addEventListener('submit', async (event) => {
  const form = event.target.closest('.add-card-form');
  if (!form) return;
  event.preventDefault();

  const input = form.elements.text;
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  try {
    const response = await fetch(`${API_BASE}/api/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId: form.dataset.columnId, text })
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Could not create card');
    // All clients, including this one, update through the SSE board event.
  } catch (error) {
    input.value = text;
    showError(error.message);
  }
});

boardEl.addEventListener('dragstart', (event) => {
  const card = event.target.closest('.card');
  if (!card) return;
  card.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', card.dataset.cardId);
});

boardEl.addEventListener('dragend', (event) => {
  const card = event.target.closest('.card');
  card?.classList.remove('dragging');
  document.querySelectorAll('.card-list.drag-over').forEach((list) => list.classList.remove('drag-over'));
});

boardEl.addEventListener('dragover', (event) => {
  const list = event.target.closest('.card-list');
  const dragging = document.querySelector('.card.dragging');
  if (!list || !dragging) return;

  event.preventDefault();
  list.classList.add('drag-over');
  list.querySelector('.empty')?.remove();
  const afterElement = getCardAfterPointer(list, event.clientY);
  if (afterElement == null) list.append(dragging);
  else list.insertBefore(dragging, afterElement);
});

boardEl.addEventListener('dragleave', (event) => {
  const list = event.target.closest('.card-list');
  if (list && !list.contains(event.relatedTarget)) list.classList.remove('drag-over');
});

boardEl.addEventListener('drop', async (event) => {
  const list = event.target.closest('.card-list');
  const cardId = event.dataTransfer.getData('text/plain');
  if (!list || !cardId) return;

  event.preventDefault();
  list.classList.remove('drag-over');
  const intent = getDropIntent(list, cardId);
  if (!intent.orderIds.includes(cardId)) return;

  applyOptimisticMove(cardId, intent.columnId, intent.orderIds);

  try {
    const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        columnId: intent.columnId,
        beforeId: intent.beforeId,
        afterId: intent.afterId
      })
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Could not move card');
  } catch (error) {
    pendingMoves.delete(cardId);
    showError(error.message);
    // Reload from the authoritative server state if the optimistic mutation was rejected.
    loadBoard().catch((loadError) => showError(loadError.message));
  }
});

loadBoard()
  .then(connectStream)
  .catch((error) => {
    showError(error.message);
    setStatus('disconnected', 'Offline');
  });
