import './styles.css';

const API_BASE = import.meta.env.VITE_API_URL || (location.port === '5173' ? 'http://localhost:3001' : '');

let board = { columns: [] };
let draggedCardId = null;
let eventSource = null;

const app = document.querySelector('#app');
app.innerHTML = `
  <main class="app-shell">
    <header class="header">
      <div>
        <h1>Kanban Board</h1>
        <p class="subtitle">A shared board with optimistic drag-and-drop. The server computes authoritative card ordering and all connected browsers converge through Server-Sent Events.</p>
      </div>
      <div id="status" class="status"><span class="status-dot"></span><span id="statusText">Connecting…</span></div>
    </header>
    <section id="board" class="board" aria-label="Kanban board"></section>
  </main>
  <div id="toast" class="toast hidden" role="status"></div>
`;

const boardEl = document.querySelector('#board');
const statusEl = document.querySelector('#status');
const statusTextEl = document.querySelector('#statusText');
const toastEl = document.querySelector('#toast');

function setStatus(kind, text) {
  statusEl.className = `status ${kind || ''}`.trim();
  statusTextEl.textContent = text;
}

let toastTimer;
function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3500);
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const payload = await response.json();
      detail = payload.error || detail;
    } catch {}
    throw new Error(detail);
  }
  return response.json();
}

function sanitizeBoard(nextBoard) {
  const seen = new Set();
  return {
    columns: [...(nextBoard.columns || [])]
      .sort((a, b) => Number(a.position) - Number(b.position))
      .map((column) => ({
        ...column,
        cards: [...(column.cards || [])]
          .filter((card) => {
            if (seen.has(card.id)) return false;
            seen.add(card.id);
            return true;
          })
          .sort((a, b) => Number(a.position) - Number(b.position) || String(a.id).localeCompare(String(b.id))),
      })),
  };
}

function setBoard(nextBoard) {
  board = sanitizeBoard(nextBoard);
  render();
}

function cardCount(column) {
  return column.cards?.length || 0;
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
          <span class="count">${cardCount(column)}</span>
        </div>
        <form class="add-card-form" data-column-id="${column.id}">
          <input name="text" maxlength="500" autocomplete="off" placeholder="Add a card…" aria-label="Add card to ${escapeHtml(column.title)}" />
          <button type="submit" title="Add card">+</button>
        </form>
      </div>
      <div class="card-list" data-column-id="${column.id}"></div>
    `;

    const listEl = columnEl.querySelector('.card-list');
    for (const card of column.cards || []) {
      listEl.appendChild(createCardEl(card));
    }
    if (!column.cards?.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Drop a card here';
      listEl.appendChild(empty);
    }

    boardEl.appendChild(columnEl);
  }

  wireColumnEvents();
}

function createCardEl(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.draggable = true;
  cardEl.dataset.cardId = card.id;
  cardEl.innerHTML = `
    <div>${escapeHtml(card.text)}</div>
    <div class="card-meta"><span>drag to move</span><span>${formatPosition(card.position)}</span></div>
  `;
  cardEl.addEventListener('dragstart', () => {
    draggedCardId = card.id;
    cardEl.classList.add('dragging');
    requestAnimationFrame(() => cardEl.classList.add('dragging'));
  });
  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('dragging');
    draggedCardId = null;
    clearDragOverStates();
    render();
  });
  return cardEl;
}

function wireColumnEvents() {
  document.querySelectorAll('.add-card-form').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = form.elements.text;
      const text = input.value.trim();
      if (!text) return;
      const button = form.querySelector('button');
      button.disabled = true;
      try {
        await api('/api/cards', {
          method: 'POST',
          body: JSON.stringify({ columnId: form.dataset.columnId, text }),
        });
        input.value = '';
      } catch (error) {
        showToast(`Could not create card: ${error.message}`);
      } finally {
        button.disabled = false;
        input.focus();
      }
    });
  });

  document.querySelectorAll('.card-list').forEach((listEl) => {
    listEl.addEventListener('dragenter', () => listEl.classList.add('drag-over'));
    listEl.addEventListener('dragleave', (event) => {
      if (!listEl.contains(event.relatedTarget)) listEl.classList.remove('drag-over');
    });
    listEl.addEventListener('dragover', (event) => {
      event.preventDefault();
      const dragging = document.querySelector('.card.dragging');
      if (!dragging) return;
      listEl.querySelector('.empty')?.remove();
      const afterElement = getDragAfterElement(listEl, event.clientY);
      if (afterElement == null) {
        listEl.appendChild(dragging);
      } else {
        listEl.insertBefore(dragging, afterElement);
      }
    });
    listEl.addEventListener('drop', async (event) => {
      event.preventDefault();
      listEl.classList.remove('drag-over');
      const cardEl = document.querySelector('.card.dragging');
      const id = draggedCardId || cardEl?.dataset.cardId;
      if (!id) return;

      const ids = [...listEl.querySelectorAll('.card')].map((el) => el.dataset.cardId);
      const index = ids.indexOf(id);
      const afterId = index > 0 ? ids[index - 1] : null;
      const beforeId = index >= 0 && index < ids.length - 1 ? ids[index + 1] : null;
      const columnId = listEl.dataset.columnId;

      optimisticMove(id, columnId, beforeId, afterId);
      try {
        const result = await api(`/api/cards/${encodeURIComponent(id)}/move`, {
          method: 'PATCH',
          body: JSON.stringify({ columnId, beforeId, afterId }),
        });
        if (result.board) setBoard(result.board);
      } catch (error) {
        showToast(`Move rejected by server: ${error.message}`);
        await loadBoard();
      }
    });
  });
}

function optimisticMove(cardId, columnId, beforeId, afterId) {
  let movingCard = null;
  const next = {
    columns: board.columns.map((column) => {
      const cards = [];
      for (const card of column.cards || []) {
        if (card.id === cardId) movingCard = { ...card, columnId };
        else cards.push(card);
      }
      return { ...column, cards };
    }),
  };
  if (!movingCard) return;

  const target = next.columns.find((column) => column.id === columnId);
  if (!target) return;
  let insertAt = target.cards.length;
  if (afterId) {
    const afterIndex = target.cards.findIndex((card) => card.id === afterId);
    if (afterIndex !== -1) insertAt = afterIndex + 1;
  } else if (beforeId) {
    const beforeIndex = target.cards.findIndex((card) => card.id === beforeId);
    if (beforeIndex !== -1) insertAt = beforeIndex;
  }
  const prev = target.cards[insertAt - 1];
  const nextCard = target.cards[insertAt];
  movingCard.columnId = columnId;
  movingCard.column_id = columnId;
  movingCard.position = fractionalPosition(prev?.position, nextCard?.position);
  target.cards.splice(insertAt, 0, movingCard);
  setBoard(next);
}

function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('.card:not(.dragging)')];
  return draggableElements.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) return { offset, element: child };
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
}

function clearDragOverStates() {
  document.querySelectorAll('.card-list.drag-over').forEach((el) => el.classList.remove('drag-over'));
}

function fractionalPosition(prev, next) {
  const p = prev == null ? null : Number(prev);
  const n = next == null ? null : Number(next);
  if (p != null && Number.isFinite(p) && n != null && Number.isFinite(n) && p < n) return (p + n) / 2;
  if (p != null && Number.isFinite(p)) return p + 1000;
  if (n != null && Number.isFinite(n)) return n - 1000;
  return 1000;
}

function formatPosition(position) {
  const value = Number(position);
  return Number.isFinite(value) ? `#${Math.round(value)}` : '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function loadBoard() {
  const nextBoard = await api('/api/board');
  setBoard(nextBoard);
}

function connectStream() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`${API_BASE}/api/stream`);

  eventSource.addEventListener('open', () => setStatus('connected', 'Live updates connected'));
  eventSource.addEventListener('error', () => setStatus('error', 'Reconnecting live updates…'));

  const handleMutation = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.board) setBoard(payload.board);
    } catch (error) {
      console.warn('Ignoring malformed SSE payload', error);
    }
  };

  eventSource.addEventListener('card:create', handleMutation);
  eventSource.addEventListener('card:move', handleMutation);
  eventSource.addEventListener('board', handleMutation);
}

loadBoard()
  .then(() => connectStream())
  .catch((error) => {
    setStatus('error', 'Backend unavailable');
    showToast(`Could not load board: ${error.message}`);
  });
