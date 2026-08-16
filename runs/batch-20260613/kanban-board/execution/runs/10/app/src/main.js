import './styles.css';

const app = document.querySelector('#app');

let board = { columns: [] };
let draggedCardId = null;
let draggedElement = null;
let queuedBoardWhileDragging = null;
const inFlightMoves = new Map();

const cardById = () => {
  const map = new Map();
  for (const column of board.columns) {
    for (const card of column.cards) map.set(card.id, card);
  }
  return map;
};

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setStatus(message, kind = 'info') {
  const status = document.querySelector('[data-status]');
  if (!status) return;
  status.textContent = message;
  status.dataset.kind = kind;
}

async function fetchJson(url, options) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function loadBoard() {
  try {
    const next = await fetchJson('/api/board');
    applyBoard(next);
    setStatus('Connected');
  } catch (error) {
    console.error(error);
    setStatus(`Failed to load board: ${error.message}`, 'error');
  }
}

function applyBoard(nextBoard) {
  if (!nextBoard?.columns) return;
  if (draggedCardId) {
    queuedBoardWhileDragging = nextBoard;
    return;
  }
  board = normalizeBoard(nextBoard);
  render();
}

function normalizeBoard(input) {
  return {
    columns: [...(input.columns || [])]
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
      .map((column) => ({
        ...column,
        cards: [...(column.cards || [])].sort(
          (a, b) => a.position - b.position || String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id)
        )
      }))
  };
}

function render() {
  app.innerHTML = `
    <header class="app-header">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Every change is persisted and broadcast with SSE.</p>
      </div>
      <div class="connection" data-status data-kind="info">Connecting…</div>
    </header>
    <main class="board" aria-label="Kanban board">
      ${board.columns.map(renderColumn).join('')}
    </main>
  `;
  bindEvents();
}

function renderColumn(column) {
  return `
    <section class="column" data-column-id="${escapeHtml(column.id)}">
      <header class="column-header">
        <h2>${escapeHtml(column.title)}</h2>
        <span>${column.cards.length}</span>
      </header>
      <form class="add-card" data-add-card>
        <input name="text" maxlength="280" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-card-list="${escapeHtml(column.id)}">
        ${column.cards.map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const pending = inFlightMoves.has(card.id) ? ' pending' : '';
  return `
    <article class="card${pending}" draggable="true" data-card-id="${escapeHtml(card.id)}">
      <p>${escapeHtml(card.text)}</p>
      <small>${new Date(card.createdAt).toLocaleString()}</small>
    </article>
  `;
}

function bindEvents() {
  document.querySelectorAll('[data-add-card]').forEach((form) => {
    form.addEventListener('submit', onAddCard);
  });

  document.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('dragstart', onDragStart);
    card.addEventListener('dragend', onDragEnd);
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', onDragOver);
    list.addEventListener('drop', onDrop);
    list.addEventListener('dragleave', () => list.classList.remove('drag-over'));
  });
}

async function onAddCard(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const column = form.closest('[data-column-id]');
  const input = form.elements.text;
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  input.disabled = true;
  try {
    const payload = await fetchJson('/api/cards', {
      method: 'POST',
      body: JSON.stringify({ columnId: column.dataset.columnId, text })
    });
    if (payload.board) applyBoard(payload.board);
  } catch (error) {
    console.error(error);
    input.value = text;
    setStatus(`Create failed: ${error.message}`, 'error');
  } finally {
    input.disabled = false;
    input.focus();
  }
}

function onDragStart(event) {
  draggedElement = event.currentTarget;
  draggedCardId = draggedElement.dataset.cardId;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggedCardId);
  requestAnimationFrame(() => draggedElement?.classList.add('dragging'));
}

function onDragOver(event) {
  event.preventDefault();
  const list = event.currentTarget;
  list.classList.add('drag-over');
  if (!draggedElement) return;

  const afterElement = getDragAfterElement(list, event.clientY);
  if (afterElement == null) {
    list.appendChild(draggedElement);
  } else {
    list.insertBefore(draggedElement, afterElement);
  }
}

async function onDrop(event) {
  event.preventDefault();
  const list = event.currentTarget;
  list.classList.remove('drag-over');
  const cardId = event.dataTransfer.getData('text/plain') || draggedCardId;
  if (!cardId) return;

  const cardElement = document.querySelector(`[data-card-id="${CSS.escape(cardId)}"]`);
  if (!cardElement) return;

  const targetColumnId = list.dataset.cardList;
  const beforeId = cardElement.nextElementSibling?.dataset.cardId || null;
  const afterId = cardElement.previousElementSibling?.dataset.cardId || null;

  applyOptimisticDomOrderToState();
  inFlightMoves.set(cardId, { columnId: targetColumnId, beforeId, afterId });
  cardElement.classList.add('pending');

  try {
    const payload = await fetchJson(`/api/cards/${encodeURIComponent(cardId)}/move`, {
      method: 'PATCH',
      body: JSON.stringify({ columnId: targetColumnId, beforeId, afterId })
    });
    inFlightMoves.delete(cardId);
    if (payload.board) applyBoard(payload.board);
  } catch (error) {
    console.error(error);
    inFlightMoves.delete(cardId);
    setStatus(`Move failed: ${error.message}`, 'error');
    await loadBoard();
  }
}

function onDragEnd() {
  document.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
  draggedElement?.classList.remove('dragging');
  draggedElement = null;
  draggedCardId = null;

  if (queuedBoardWhileDragging) {
    const queued = queuedBoardWhileDragging;
    queuedBoardWhileDragging = null;
    applyBoard(queued);
  }
}

function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('.card:not(.dragging)')];
  return draggableElements.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) {
        return { offset, element: child };
      }
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null }
  ).element;
}

function applyOptimisticDomOrderToState() {
  const allCards = cardById();
  const nextColumns = board.columns.map((column) => ({ ...column, cards: [] }));
  const nextById = new Map(nextColumns.map((column) => [column.id, column]));
  const seen = new Set();

  document.querySelectorAll('[data-card-list]').forEach((list) => {
    const column = nextById.get(list.dataset.cardList);
    if (!column) return;
    [...list.querySelectorAll('[data-card-id]')].forEach((el, index) => {
      const card = allCards.get(el.dataset.cardId);
      if (!card || seen.has(card.id)) return;
      seen.add(card.id);
      column.cards.push({ ...card, columnId: column.id, position: (index + 1) * 1000 });
    });
  });

  // Preserve any cards that were not rendered for some unexpected reason.
  for (const card of allCards.values()) {
    if (seen.has(card.id)) continue;
    const column = nextById.get(card.columnId) || nextColumns[0];
    if (column) column.cards.push(card);
  }
  board = { columns: nextColumns };
  updateColumnCounts();
}

function updateColumnCounts() {
  document.querySelectorAll('.column').forEach((columnEl) => {
    const count = columnEl.querySelectorAll('.card').length;
    const badge = columnEl.querySelector('.column-header span');
    if (badge) badge.textContent = String(count);
  });
}

function connectStream() {
  const source = new EventSource('/api/stream');

  source.addEventListener('open', () => setStatus('Live updates connected'));
  source.addEventListener('error', () => setStatus('Live update reconnecting…', 'warn'));

  const handleBoardPayload = (event) => {
    try {
      const payload = JSON.parse(event.data);
      applyBoard(payload.board ? payload.board : payload);
      setStatus('Live updates connected');
    } catch (error) {
      console.error('Bad SSE payload', error);
    }
  };

  source.addEventListener('board', handleBoardPayload);
  source.addEventListener('card:create', handleBoardPayload);
  source.addEventListener('card:move', (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.card?.id) inFlightMoves.delete(payload.card.id);
      applyBoard(payload.board);
      setStatus('Live updates connected');
    } catch (error) {
      console.error('Bad SSE payload', error);
    }
  });
}

render();
loadBoard();
connectStream();
