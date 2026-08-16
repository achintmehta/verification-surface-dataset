import './styles.css';

const app = document.querySelector('#app');

let board = { columns: [] };
let draggedCardId = null;
let toastTimer = null;

app.innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <h1>Collaborative Kanban Board</h1>
      <p>Create cards, drag to reorder, and watch all connected clients converge in real time.</p>
      <div id="status" class="status disconnected"><span class="status-dot"></span><span id="status-text">Connecting…</span></div>
    </header>
    <main id="board" class="board" aria-label="Kanban board"></main>
  </div>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
`;

const boardEl = document.querySelector('#board');
const statusEl = document.querySelector('#status');
const statusTextEl = document.querySelector('#status-text');
const toastEl = document.querySelector('#toast');

function setStatus(kind, text) {
  statusEl.classList.remove('connected', 'disconnected');
  statusEl.classList.add(kind);
  statusTextEl.textContent = text;
}

function showToast(message, type = '') {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.className = `toast visible ${type}`.trim();
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('visible');
  }, 3200);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return payload;
}

function normalizeBoard(incoming) {
  const seenCards = new Set();
  const columns = [...(incoming.columns || [])]
    .sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id))
    .map((column) => {
      const cards = [...(column.cards || [])]
        .filter((card) => {
          if (seenCards.has(card.id)) return false;
          seenCards.add(card.id);
          return true;
        })
        .sort((a, b) => Number(a.position) - Number(b.position) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id.localeCompare(b.id));
      return { ...column, cards };
    });
  return { columns };
}

function applyBoard(incoming) {
  board = normalizeBoard(incoming);
  renderBoard();
}

function cardElement(card) {
  const el = document.createElement('article');
  el.className = 'card';
  el.draggable = true;
  el.dataset.cardId = card.id;
  el.textContent = card.text;

  el.addEventListener('dragstart', (event) => {
    draggedCardId = card.id;
    el.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', card.id);
  });

  el.addEventListener('dragend', () => {
    draggedCardId = null;
    el.classList.remove('dragging');
    document.querySelectorAll('.card-list.drop-target').forEach((list) => list.classList.remove('drop-target'));
  });

  return el;
}

function renderBoard() {
  boardEl.replaceChildren();

  for (const column of board.columns) {
    const columnEl = document.createElement('section');
    columnEl.className = 'column';
    columnEl.dataset.columnId = column.id;

    const header = document.createElement('div');
    header.className = 'column-header';
    header.innerHTML = `<h2 class="column-title"></h2><span class="count"></span>`;
    header.querySelector('.column-title').textContent = column.title;
    header.querySelector('.count').textContent = column.cards.length;

    const list = document.createElement('div');
    list.className = 'card-list';
    list.dataset.columnId = column.id;
    list.setAttribute('aria-label', `${column.title} cards`);

    installDropZone(list);

    if (column.cards.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'Drop cards here';
      list.append(empty);
    } else {
      for (const card of column.cards) {
        list.append(cardElement(card));
      }
    }

    const form = document.createElement('form');
    form.className = 'add-card';
    form.dataset.columnId = column.id;
    form.innerHTML = `
      <textarea name="text" maxlength="1000" placeholder="Add a card…" aria-label="New card text for ${escapeHtml(column.title)}"></textarea>
      <button type="submit">Add card</button>
    `;
    form.addEventListener('submit', handleCreateCard);

    columnEl.append(header, list, form);
    boardEl.append(columnEl);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

function installDropZone(list) {
  list.addEventListener('dragover', (event) => {
    if (!draggedCardId) return;
    event.preventDefault();
    list.classList.add('drop-target');
    const afterElement = getDragAfterElement(list, event.clientY);
    const dragging = document.querySelector(`[data-card-id="${CSS.escape(draggedCardId)}"]`);
    if (!dragging) return;
    removeEmptyPlaceholder(list);
    if (afterElement == null) {
      list.appendChild(dragging);
    } else {
      list.insertBefore(dragging, afterElement);
    }
  });

  list.addEventListener('dragleave', (event) => {
    if (!list.contains(event.relatedTarget)) list.classList.remove('drop-target');
  });

  list.addEventListener('drop', async (event) => {
    event.preventDefault();
    list.classList.remove('drop-target');
    const cardId = event.dataTransfer.getData('text/plain') || draggedCardId;
    if (!cardId) return;

    const cardEl = document.querySelector(`[data-card-id="${CSS.escape(cardId)}"]`);
    if (!cardEl) return;
    cardEl.classList.add('pending');

    const { beforeId, afterId } = getNeighborIds(cardEl);
    const columnId = cardEl.closest('.card-list').dataset.columnId;

    optimisticallyMove(cardId, columnId, beforeId, afterId);

    try {
      const result = await requestJson(`/api/cards/${encodeURIComponent(cardId)}/move`, {
        method: 'PATCH',
        body: JSON.stringify({ columnId, beforeId, afterId })
      });
      if (result.board) applyBoard(result.board);
    } catch (error) {
      showToast(error.message, 'error');
      await loadBoard();
    }
  });
}

function removeEmptyPlaceholder(list) {
  list.querySelectorAll('.empty-state').forEach((el) => el.remove());
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

function getNeighborIds(cardEl) {
  const cards = [...cardEl.parentElement.querySelectorAll('.card')];
  const index = cards.indexOf(cardEl);
  const after = cards[index - 1] || null;
  const before = cards[index + 1] || null;
  return {
    afterId: after?.dataset.cardId || null,
    beforeId: before?.dataset.cardId || null
  };
}

function findCard(cardId) {
  for (const column of board.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index !== -1) return { column, index, card: column.cards[index] };
  }
  return null;
}

function optimisticallyMove(cardId, columnId, beforeId, afterId) {
  const found = findCard(cardId);
  if (!found) return;
  const [card] = found.column.cards.splice(found.index, 1);
  card.columnId = columnId;
  card.position = optimisticPosition(columnId, beforeId, afterId);

  const destination = board.columns.find((column) => column.id === columnId);
  if (!destination) return;
  let insertIndex = destination.cards.length;
  if (beforeId) {
    const beforeIndex = destination.cards.findIndex((candidate) => candidate.id === beforeId);
    if (beforeIndex !== -1) insertIndex = beforeIndex;
  } else if (afterId) {
    const afterIndex = destination.cards.findIndex((candidate) => candidate.id === afterId);
    if (afterIndex !== -1) insertIndex = afterIndex + 1;
  }
  destination.cards.splice(insertIndex, 0, card);
}

function optimisticPosition(columnId, beforeId, afterId) {
  const column = board.columns.find((candidate) => candidate.id === columnId);
  const before = column?.cards.find((card) => card.id === beforeId)?.position;
  const after = column?.cards.find((card) => card.id === afterId)?.position;
  if (before != null && after != null) return (Number(before) + Number(after)) / 2;
  if (after != null) return Number(after) + 1024;
  if (before != null) return Number(before) - 1024;
  return Math.max(0, ...(column?.cards || []).map((card) => Number(card.position) || 0)) + 1024;
}

async function handleCreateCard(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const textArea = form.elements.text;
  const button = form.querySelector('button');
  const text = textArea.value.trim();
  if (!text) return;

  button.disabled = true;
  try {
    const result = await requestJson('/api/cards', {
      method: 'POST',
      body: JSON.stringify({ columnId: form.dataset.columnId, text })
    });
    textArea.value = '';
    if (result.board) applyBoard(result.board);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function loadBoard() {
  const data = await requestJson('/api/board');
  applyBoard(data);
}

function connectStream() {
  const source = new EventSource('/api/stream');

  source.addEventListener('open', () => setStatus('connected', 'Live sync connected'));
  source.addEventListener('connected', () => setStatus('connected', 'Live sync connected'));
  source.addEventListener('board', (event) => applyBoard(JSON.parse(event.data)));

  // These event-specific updates are intentionally followed by the canonical board
  // broadcast from the server. They keep the UI responsive even if an intermediary
  // buffers individual events, while the board event remains the convergence source.
  source.addEventListener('card-created', () => {});
  source.addEventListener('card-moved', () => {});

  source.addEventListener('error', () => {
    setStatus('disconnected', 'Reconnecting live sync…');
  });
}

loadBoard()
  .then(connectStream)
  .catch((error) => {
    showToast(error.message, 'error');
    setStatus('disconnected', 'Could not load board');
  });
