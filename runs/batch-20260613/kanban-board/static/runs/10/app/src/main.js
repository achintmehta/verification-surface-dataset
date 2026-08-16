import './styles.css';

const API_BASE = '';
const app = document.querySelector('#app');

let board = { columns: [] };
let draggedCardId = null;
let eventSource = null;
let reconnectTimer = null;
let statusMessage = 'Connecting…';
let statusIsError = false;

const cardById = new Map();

function normalizeBoard(nextBoard) {
  const columns = (nextBoard?.columns || []).map((column) => ({
    ...column,
    position: Number(column.position),
    cards: [...(column.cards || [])]
      .map((card) => ({
        ...card,
        columnId: card.columnId || card.column_id,
        position: Number(card.position)
      }))
      .sort(compareCards)
  }));

  columns.sort((a, b) => Number(a.position) - Number(b.position) || a.title.localeCompare(b.title));
  return { columns };
}

function compareCards(a, b) {
  const positionDelta = Number(a.position) - Number(b.position);
  if (positionDelta !== 0) return positionDelta;
  const createdDelta = String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  if (createdDelta !== 0) return createdDelta;
  return String(a.id).localeCompare(String(b.id));
}

function rebuildCardIndex() {
  cardById.clear();
  for (const column of board.columns) {
    for (const card of column.cards) {
      cardById.set(card.id, card);
    }
  }
}

function findColumn(columnId) {
  return board.columns.find((column) => column.id === columnId);
}

function findCardLocation(cardId) {
  for (const column of board.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index !== -1) return { column, index, card: column.cards[index] };
  }
  return null;
}

function removeCardFromEverywhere(cardId) {
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

function applyCanonicalCard(card) {
  const normalized = {
    ...card,
    columnId: card.columnId || card.column_id,
    position: Number(card.position)
  };
  removeCardFromEverywhere(normalized.id);
  const targetColumn = findColumn(normalized.columnId);
  if (!targetColumn) return;
  targetColumn.cards.push(normalized);
  targetColumn.cards.sort(compareCards);
  rebuildCardIndex();
}

function setBoard(nextBoard) {
  board = normalizeBoard(nextBoard);
  rebuildCardIndex();
  render();
}

async function fetchJson(url, options) {
  const response = await fetch(`${API_BASE}${url}`, {
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
    ...options
  });

  if (!response.ok) {
    let message = `Request failed with ${response.status}`;
    try {
      const body = await response.json();
      message = body.error || message;
    } catch {
      // Keep default message.
    }
    throw new Error(message);
  }

  return response.json();
}

async function loadBoard() {
  setStatus('Loading board…');
  try {
    const data = await fetchJson('/api/board');
    setBoard(data);
    setStatus('Connected');
  } catch (error) {
    setStatus(`Unable to load board: ${error.message}`, true);
  }
}

function connectStream() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/stream');

  eventSource.addEventListener('open', () => setStatus('Live updates connected'));
  eventSource.addEventListener('connected', () => setStatus('Live updates connected'));

  eventSource.addEventListener('board:sync', (event) => {
    setBoard(JSON.parse(event.data));
    setStatus('Synced');
  });

  eventSource.addEventListener('card:create', (event) => {
    const payload = JSON.parse(event.data);
    applyCanonicalCard(payload.card);
    render();
  });

  eventSource.addEventListener('card:move', (event) => {
    const payload = JSON.parse(event.data);
    applyCanonicalCard(payload.card);
    render();
  });

  eventSource.addEventListener('error', () => {
    setStatus('Live connection interrupted; retrying…', true);
    if (reconnectTimer) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connectStream();
    }, 3000);
  });
}

function setStatus(message, isError = false) {
  statusMessage = message;
  statusIsError = isError;
  const status = document.querySelector('[data-status]');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('error', isError);
}

function cardTemplate(card) {
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}">
      <p>${escapeHtml(card.text)}</p>
    </article>
  `;
}

function render() {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. All open clients converge through server-sent events.</p>
      </div>
      <div class="status${statusIsError ? ' error' : ''}" data-status>${escapeHtml(statusMessage)}</div>
    </header>
    <main class="board" aria-label="Kanban board">
      ${board.columns.map((column) => `
        <section class="column" data-column-id="${escapeHtml(column.id)}">
          <header class="column-header">
            <h2>${escapeHtml(column.title)}</h2>
            <span>${column.cards.length}</span>
          </header>
          <form class="new-card-form" data-column-id="${escapeHtml(column.id)}">
            <input name="text" type="text" maxlength="240" placeholder="Add a card…" aria-label="New card text for ${escapeHtml(column.title)}" />
            <button type="submit">Add</button>
          </form>
          <div class="card-list" data-column-id="${escapeHtml(column.id)}">
            ${column.cards.map(cardTemplate).join('')}
          </div>
        </section>
      `).join('')}
    </main>
  `;

  attachDomHandlers();
}

function attachDomHandlers() {
  document.querySelectorAll('.new-card-form').forEach((form) => {
    form.addEventListener('submit', createCard);
  });

  document.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('dragstart', handleDragStart);
    card.addEventListener('dragend', handleDragEnd);
  });

  document.querySelectorAll('.card-list').forEach((list) => {
    list.addEventListener('dragover', handleDragOver);
    list.addEventListener('drop', handleDrop);
    list.addEventListener('dragleave', handleDragLeave);
  });
}

async function createCard(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const input = form.elements.text;
  const text = input.value.trim();
  const columnId = form.dataset.columnId;
  if (!text) return;

  input.value = '';
  try {
    const response = await fetchJson('/api/cards', {
      method: 'POST',
      body: JSON.stringify({ columnId, text })
    });
    if (response.board) setBoard(response.board);
  } catch (error) {
    input.value = text;
    setStatus(`Create failed: ${error.message}`, true);
  }
}

function handleDragStart(event) {
  draggedCardId = event.currentTarget.dataset.cardId;
  event.currentTarget.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggedCardId);
}

function handleDragEnd(event) {
  event.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.card-list.drag-over').forEach((list) => list.classList.remove('drag-over'));
  draggedCardId = null;
}

function handleDragLeave(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) {
    event.currentTarget.classList.remove('drag-over');
  }
}

function handleDragOver(event) {
  event.preventDefault();
  const list = event.currentTarget;
  list.classList.add('drag-over');
  const dragging = document.querySelector('.card.dragging');
  if (!dragging) return;

  const afterElement = getDragAfterElement(list, event.clientY);
  if (afterElement == null) {
    list.appendChild(dragging);
  } else {
    list.insertBefore(dragging, afterElement);
  }
}

async function handleDrop(event) {
  event.preventDefault();
  const list = event.currentTarget;
  list.classList.remove('drag-over');

  const cardId = draggedCardId || event.dataTransfer.getData('text/plain');
  if (!cardId) return;

  const targetColumnId = list.dataset.columnId;
  const ids = [...list.querySelectorAll('.card')].map((card) => card.dataset.cardId);
  const cardIndex = ids.indexOf(cardId);
  const beforeId = ids[cardIndex + 1] || null;
  const afterId = ids[cardIndex - 1] || null;

  const snapshot = JSON.parse(JSON.stringify(board));
  optimisticMove(cardId, targetColumnId, beforeId, afterId);

  try {
    const response = await fetchJson(`/api/cards/${encodeURIComponent(cardId)}/move`, {
      method: 'PATCH',
      body: JSON.stringify({ columnId: targetColumnId, beforeId, afterId })
    });
    if (response.board) setBoard(response.board);
    else if (response.card) {
      applyCanonicalCard(response.card);
      render();
    }
  } catch (error) {
    setBoard(snapshot);
    setStatus(`Move failed: ${error.message}`, true);
  }
}

function optimisticMove(cardId, targetColumnId, beforeId, afterId) {
  const moving = removeCardFromEverywhere(cardId);
  if (!moving) return;

  const targetColumn = findColumn(targetColumnId);
  if (!targetColumn) return;

  const beforeIndex = beforeId ? targetColumn.cards.findIndex((card) => card.id === beforeId) : -1;
  const afterIndex = afterId ? targetColumn.cards.findIndex((card) => card.id === afterId) : -1;

  let insertIndex = targetColumn.cards.length;
  if (beforeIndex >= 0) insertIndex = beforeIndex;
  else if (afterIndex >= 0) insertIndex = afterIndex + 1;

  const beforePosition = beforeId ? targetColumn.cards.find((card) => card.id === beforeId)?.position : null;
  const afterPosition = afterId ? targetColumn.cards.find((card) => card.id === afterId)?.position : null;

  moving.columnId = targetColumnId;
  moving.position = guessPosition(beforePosition, afterPosition, targetColumn);
  targetColumn.cards.splice(insertIndex, 0, moving);
  rebuildCardIndex();
  render();
}

function guessPosition(beforePosition, afterPosition, targetColumn) {
  if (typeof beforePosition === 'number' && typeof afterPosition === 'number') return (beforePosition + afterPosition) / 2;
  if (typeof beforePosition === 'number') return beforePosition / 2;
  if (typeof afterPosition === 'number') return afterPosition + 1000;
  const max = targetColumn.cards.reduce((highest, card) => Math.max(highest, Number(card.position) || 0), 0);
  return max + 1000;
}

function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('.card:not(.dragging)')];

  return draggableElements.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      return { offset, element: child };
    }
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

setBoard({ columns: [] });
await loadBoard();
connectStream();
