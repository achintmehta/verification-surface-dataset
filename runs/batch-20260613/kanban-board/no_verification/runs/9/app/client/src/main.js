import './styles.css';

const API_BASE = import.meta.env.VITE_API_URL || (window.location.port === '5173' ? 'http://localhost:3000' : '');
const app = document.querySelector('#app');

let board = { columns: [] };
let draggedCardId = null;
let eventSource = null;
let pendingMoves = new Set();

app.innerHTML = `
  <main class="app-shell">
    <header class="app-header">
      <div>
        <h1>Collaborative Kanban</h1>
        <p class="subtitle">Drag cards across columns. Every connected browser converges via SSE.</p>
      </div>
      <div id="connection-status" class="connection-status">Connecting…</div>
    </header>
    <div id="error"></div>
    <section id="board" class="board" aria-label="Kanban board"></section>
  </main>
`;

const boardEl = document.querySelector('#board');
const statusEl = document.querySelector('#connection-status');
const errorEl = document.querySelector('#error');

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

function setStatus(text, className = '') {
  statusEl.textContent = text;
  statusEl.className = `connection-status ${className}`.trim();
}

function showError(message) {
  errorEl.innerHTML = message ? `<div class="error-banner">${escapeHtml(message)}</div>` : '';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function findColumn(columnId) {
  return board.columns.find((column) => column.id === columnId);
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

function sortBoard() {
  board.columns.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  for (const column of board.columns) {
    column.cards.sort((a, b) => a.position - b.position || String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
  }
}

function replaceBoard(nextBoard) {
  board = {
    columns: (nextBoard?.columns || []).map((column) => ({
      ...column,
      cards: [...(column.cards || [])],
    })),
  };
  sortBoard();
  render();
}

function render() {
  boardEl.innerHTML = '';

  for (const column of board.columns) {
    const columnEl = document.createElement('article');
    columnEl.className = 'column';
    columnEl.dataset.columnId = column.id;
    columnEl.innerHTML = `
      <div class="column-header">
        <div class="column-title-row">
          <h2>${escapeHtml(column.title)}</h2>
          <span class="count-pill" aria-label="${column.cards.length} cards">${column.cards.length}</span>
        </div>
        <form class="add-card-form" data-column-id="${escapeHtml(column.id)}">
          <input name="text" placeholder="Add a card…" maxlength="280" autocomplete="off" />
          <button type="submit" title="Create card">+</button>
        </form>
      </div>
    `;

    const listEl = document.createElement('div');
    listEl.className = 'card-list';
    listEl.dataset.columnId = column.id;

    if (column.cards.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-hint';
      empty.textContent = 'Drop a card here';
      listEl.appendChild(empty);
    } else {
      for (const card of column.cards) {
        listEl.appendChild(renderCard(card));
      }
    }

    columnEl.appendChild(listEl);
    boardEl.appendChild(columnEl);
  }
}

function renderCard(card) {
  const cardEl = document.createElement('div');
  cardEl.className = `card${pendingMoves.has(card.id) ? ' pending' : ''}`;
  cardEl.draggable = true;
  cardEl.dataset.cardId = card.id;
  cardEl.textContent = card.text;
  return cardEl;
}

async function loadBoard() {
  const response = await fetch(apiUrl('/api/board'));
  if (!response.ok) throw new Error('Unable to load board');
  replaceBoard(await response.json());
}

async function createCard(columnId, text) {
  const response = await fetch(apiUrl('/api/cards'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Unable to create card');
  return data.card;
}

function getDragAfterElement(listEl, y) {
  const cards = [...listEl.querySelectorAll('.card:not(.dragging)')];
  return cards.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      return { offset, element: child };
    }
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
}

function idsAround(listEl, cardId) {
  const allCards = [...listEl.querySelectorAll('.card')];
  const visualIndex = allCards.findIndex((el) => el.dataset.cardId === cardId);
  let insertionIndex = allCards.slice(0, visualIndex === -1 ? allCards.length : visualIndex)
    .filter((el) => el.dataset.cardId !== cardId)
    .length;
  const withoutSelfIds = allCards
    .filter((el) => el.dataset.cardId !== cardId)
    .map((el) => el.dataset.cardId)
    .filter(Boolean);
  if (visualIndex === -1) insertionIndex = withoutSelfIds.length;

  return {
    afterId: withoutSelfIds[insertionIndex - 1] || null,
    beforeId: withoutSelfIds[insertionIndex] || null,
  };
}

function optimisticallyMove(cardId, targetColumnId, beforeId, afterId) {
  const card = removeCardEverywhere(cardId);
  const target = findColumn(targetColumnId);
  if (!card || !target) return;

  card.columnId = targetColumnId;
  card.position = optimisticPosition(target, beforeId, afterId);

  let insertionIndex = target.cards.length;
  if (beforeId) {
    const index = target.cards.findIndex((candidate) => candidate.id === beforeId);
    if (index !== -1) insertionIndex = index;
  } else if (afterId) {
    const index = target.cards.findIndex((candidate) => candidate.id === afterId);
    if (index !== -1) insertionIndex = index + 1;
  }

  target.cards.splice(insertionIndex, 0, card);
  pendingMoves.add(cardId);
  render();
}

function optimisticPosition(column, beforeId, afterId) {
  const before = beforeId ? column.cards.find((card) => card.id === beforeId) : null;
  const after = afterId ? column.cards.find((card) => card.id === afterId) : null;
  if (before && after) return (before.position + after.position) / 2;
  if (after) return after.position + 1000;
  if (before) return before.position - 1000;
  return column.cards.reduce((max, card) => Math.max(max, card.position), 0) + 1000;
}

async function moveCard(cardId, columnId, beforeId, afterId) {
  pendingMoves.add(cardId);
  const response = await fetch(apiUrl(`/api/cards/${encodeURIComponent(cardId)}/move`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, beforeId, afterId }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Unable to move card');
  return data.card;
}

boardEl.addEventListener('submit', async (event) => {
  const form = event.target.closest('.add-card-form');
  if (!form) return;
  event.preventDefault();

  const input = form.elements.text;
  const text = input.value.trim();
  if (!text) return;

  const button = form.querySelector('button');
  button.disabled = true;
  showError('');
  try {
    await createCard(form.dataset.columnId, text);
    input.value = '';
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
    input.focus();
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

boardEl.addEventListener('dragend', (event) => {
  event.target.closest('.card')?.classList.remove('dragging');
  document.querySelectorAll('.card-list.drag-over').forEach((el) => el.classList.remove('drag-over'));
  draggedCardId = null;
});

boardEl.addEventListener('dragover', (event) => {
  const listEl = event.target.closest('.card-list');
  if (!listEl || !draggedCardId) return;
  event.preventDefault();
  listEl.classList.add('drag-over');

  const draggingEl = document.querySelector('.card.dragging');
  if (!draggingEl) return;

  const afterElement = getDragAfterElement(listEl, event.clientY);
  const emptyHint = listEl.querySelector('.empty-hint');
  emptyHint?.remove();
  if (afterElement == null) {
    listEl.appendChild(draggingEl);
  } else {
    listEl.insertBefore(draggingEl, afterElement);
  }
});

boardEl.addEventListener('dragleave', (event) => {
  const listEl = event.target.closest('.card-list');
  if (listEl && !listEl.contains(event.relatedTarget)) {
    listEl.classList.remove('drag-over');
  }
});

boardEl.addEventListener('drop', async (event) => {
  const listEl = event.target.closest('.card-list');
  if (!listEl || !draggedCardId) return;
  event.preventDefault();
  listEl.classList.remove('drag-over');

  const cardId = draggedCardId;
  const targetColumnId = listEl.dataset.columnId;
  const { beforeId, afterId } = idsAround(listEl, cardId);

  showError('');
  optimisticallyMove(cardId, targetColumnId, beforeId, afterId);

  try {
    await moveCard(cardId, targetColumnId, beforeId, afterId);
  } catch (error) {
    showError(error.message);
    await loadBoard().catch(() => {});
  }
});

function connectStream() {
  if (eventSource) eventSource.close();

  setStatus('Connecting…');
  eventSource = new EventSource(apiUrl('/api/stream'));

  eventSource.addEventListener('connected', () => {
    setStatus('Live', 'connected');
  });

  eventSource.addEventListener('board', (event) => {
    const payload = JSON.parse(event.data);
    pendingMoves.clear();
    replaceBoard(payload.board);
  });

  eventSource.addEventListener('mutation', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.card?.id) pendingMoves.delete(payload.card.id);
    if (payload.board) {
      replaceBoard(payload.board);
    }
  });

  eventSource.onerror = () => {
    setStatus('Reconnecting…', 'disconnected');
  };
}

loadBoard()
  .then(() => connectStream())
  .catch((error) => {
    showError(error.message);
    setStatus('Offline', 'disconnected');
  });
