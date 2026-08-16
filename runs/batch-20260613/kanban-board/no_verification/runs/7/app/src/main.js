import './styles.css';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let draggedCardId = null;
let eventSource = null;
let reconnectTimer = null;

function cardById(cardId) {
  for (const column of board.columns) {
    const card = column.cards.find((item) => item.id === cardId);
    if (card) return { card, column };
  }
  return null;
}

function removeCardFromBoard(cardId) {
  let removed = null;
  for (const column of board.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index !== -1) {
      [removed] = column.cards.splice(index, 1);
    }
  }
  return removed;
}

function sortBoard() {
  board.columns.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  for (const column of board.columns) {
    column.cards.sort((a, b) => {
      if (a.position !== b.position) return a.position - b.position;
      return String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id.localeCompare(b.id);
    });
  }
}

function normalizeIncomingBoard(nextBoard) {
  board = {
    columns: (nextBoard?.columns || []).map((column) => ({
      id: column.id,
      title: column.title,
      position: Number(column.position),
      cards: (column.cards || []).map((card) => ({
        id: card.id,
        columnId: card.columnId || card.column_id || column.id,
        text: card.text,
        position: Number(card.position),
        createdAt: card.createdAt || card.created_at
      }))
    }))
  };
  sortBoard();
}

function render() {
  sortBoard();
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast with Server-Sent Events.</p>
      </div>
      <button id="reload-board" title="Reload authoritative server state">Reload</button>
    </header>
    <main class="board" aria-label="Kanban board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    <div id="toast" role="status" aria-live="polite"></div>
  `;

  document.querySelector('#reload-board')?.addEventListener('click', loadBoard);
  for (const form of document.querySelectorAll('.new-card-form')) {
    form.addEventListener('submit', handleCreateCard);
  }
  for (const card of document.querySelectorAll('.card')) {
    card.addEventListener('dragstart', handleDragStart);
    card.addEventListener('dragend', handleDragEnd);
  }
  for (const dropZone of document.querySelectorAll('.cards')) {
    dropZone.addEventListener('dragover', handleDragOver);
    dropZone.addEventListener('dragleave', handleDragLeave);
    dropZone.addEventListener('drop', handleDrop);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderColumn(column) {
  return `
    <section class="column" data-column-id="${escapeHtml(column.id)}">
      <h2>${escapeHtml(column.title)} <span>${column.cards.length}</span></h2>
      <div class="cards" data-column-id="${escapeHtml(column.id)}">
        ${column.cards.map(renderCard).join('')}
      </div>
      <form class="new-card-form" data-column-id="${escapeHtml(column.id)}">
        <input type="text" name="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
    </section>
  `;
}

function renderCard(card) {
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}">
      <p>${escapeHtml(card.text)}</p>
    </article>
  `;
}

function showToast(message, isError = false) {
  const toast = document.querySelector('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = isError ? 'error' : 'show';
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    toast.textContent = '';
    toast.className = '';
  }, 3000);
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      message = body.error || message;
    } catch {}
    throw new Error(message);
  }
  return response.json();
}

async function loadBoard() {
  try {
    normalizeIncomingBoard(await api('/api/board'));
    render();
  } catch (error) {
    console.error(error);
    showToast(error.message, true);
  }
}

async function handleCreateCard(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const input = form.elements.text;
  const text = input.value.trim();
  const columnId = form.dataset.columnId;
  if (!text) return;

  input.value = '';
  try {
    const result = await api('/api/cards', {
      method: 'POST',
      body: JSON.stringify({ columnId, text })
    });
    if (result.board) {
      normalizeIncomingBoard(result.board);
      render();
    }
  } catch (error) {
    input.value = text;
    console.error(error);
    showToast(error.message, true);
  }
}

function handleDragStart(event) {
  draggedCardId = event.currentTarget.dataset.cardId;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggedCardId);
  event.currentTarget.classList.add('dragging');
}

function handleDragEnd(event) {
  event.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.cards.drag-over').forEach((zone) => zone.classList.remove('drag-over'));
  draggedCardId = null;
}

function handleDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  event.currentTarget.classList.add('drag-over');
}

function handleDragLeave(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) {
    event.currentTarget.classList.remove('drag-over');
  }
}

function getDropIndex(dropZone, y) {
  const cards = [...dropZone.querySelectorAll('.card:not(.dragging)')];
  for (let i = 0; i < cards.length; i += 1) {
    const rect = cards[i].getBoundingClientRect();
    if (y < rect.top + rect.height / 2) return i;
  }
  return cards.length;
}

function neighborIds(columnId, cardId) {
  const column = board.columns.find((item) => item.id === columnId);
  if (!column) return { beforeId: null, afterId: null };
  const index = column.cards.findIndex((card) => card.id === cardId);
  const afterId = index > 0 ? column.cards[index - 1].id : null;
  const beforeId = index >= 0 && index < column.cards.length - 1 ? column.cards[index + 1].id : null;
  return { beforeId, afterId };
}

function optimisticMove(cardId, targetColumnId, targetIndex) {
  const card = removeCardFromBoard(cardId);
  const targetColumn = board.columns.find((column) => column.id === targetColumnId);
  if (!card || !targetColumn) return null;

  card.columnId = targetColumnId;
  const boundedIndex = Math.max(0, Math.min(targetIndex, targetColumn.cards.length));
  targetColumn.cards.splice(boundedIndex, 0, card);
  const neighbors = neighborIds(targetColumnId, cardId);

  // Give the optimistic card a temporary order so render() keeps it near the chosen slot.
  const previous = targetColumn.cards[boundedIndex - 1]?.position;
  const next = targetColumn.cards[boundedIndex + 1]?.position;
  if (previous == null && next == null) card.position = 1000;
  else if (previous == null) card.position = next - 1000;
  else if (next == null) card.position = previous + 1000;
  else card.position = (previous + next) / 2;

  return neighbors;
}

async function handleDrop(event) {
  event.preventDefault();
  const dropZone = event.currentTarget;
  dropZone.classList.remove('drag-over');
  const cardId = event.dataTransfer.getData('text/plain') || draggedCardId;
  const targetColumnId = dropZone.dataset.columnId;
  if (!cardId || !targetColumnId) return;

  const targetIndex = getDropIndex(dropZone, event.clientY);
  const previousBoard = structuredClone(board);
  const neighbors = optimisticMove(cardId, targetColumnId, targetIndex);
  if (!neighbors) return;
  render();

  try {
    const result = await api(`/api/cards/${encodeURIComponent(cardId)}/move`, {
      method: 'PATCH',
      body: JSON.stringify({ columnId: targetColumnId, ...neighbors })
    });
    if (result.board) {
      normalizeIncomingBoard(result.board);
      render();
    }
  } catch (error) {
    console.error(error);
    board = previousBoard;
    render();
    showToast(error.message, true);
  }
}

function applyCanonicalPayload(payload) {
  if (payload?.board) {
    normalizeIncomingBoard(payload.board);
    render();
    return;
  }

  // Fallback for event payloads without a full board: remove first so a card never appears twice.
  const card = payload?.card;
  if (!card) return;
  removeCardFromBoard(card.id);
  const targetColumn = board.columns.find((column) => column.id === (card.columnId || payload.columnId));
  if (!targetColumn) return;
  targetColumn.cards.push({
    id: card.id,
    columnId: card.columnId || payload.columnId,
    text: card.text,
    position: Number(card.position),
    createdAt: card.createdAt
  });
  render();
}

function connectStream() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`${API_BASE}/api/stream`);

  eventSource.addEventListener('connected', () => {});
  eventSource.addEventListener('card:create', (event) => applyCanonicalPayload(JSON.parse(event.data)));
  eventSource.addEventListener('card:move', (event) => applyCanonicalPayload(JSON.parse(event.data)));
  eventSource.onerror = () => {
    eventSource?.close();
    if (!reconnectTimer) {
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connectStream();
        loadBoard();
      }, 2000);
    }
  };
}

loadBoard();
connectStream();
