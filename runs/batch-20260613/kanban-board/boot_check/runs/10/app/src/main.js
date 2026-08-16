import './styles.css';

const API_BASE = window.location.port === '5173' ? `${window.location.protocol}//${window.location.hostname}:3000` : '';
const app = document.querySelector('#app');

let board = { columns: [] };
let draggedCardId = null;
let pendingMove = null;

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

async function request(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || response.statusText);
  }
  return response.json();
}

function cloneBoard(input) {
  return {
    columns: (input.columns || []).map((column) => ({
      ...column,
      cards: [...(column.cards || [])].sort(compareCards),
    })).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)),
  };
}

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id.localeCompare(b.id);
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

function insertCard(card, columnId, index = null) {
  const column = board.columns.find((item) => item.id === columnId);
  if (!column) return;
  const safeIndex = index == null ? column.cards.length : Math.max(0, Math.min(index, column.cards.length));
  column.cards.splice(safeIndex, 0, card);
}

function applyCanonicalCard(card) {
  removeCardEverywhere(card.id);
  const column = board.columns.find((item) => item.id === card.columnId);
  if (!column) return;
  column.cards.push(card);
  column.cards.sort(compareCards);
}

function setBoard(nextBoard) {
  board = cloneBoard(nextBoard);
  render();
}

function cardHtml(card) {
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
        <p>Drag cards between columns. Updates are broadcast to every connected client.</p>
      </div>
      <span id="status" class="status">Live</span>
    </header>
    <main class="board">
      ${board.columns.map((column) => `
        <section class="column" data-column-id="${escapeHtml(column.id)}">
          <header class="column-header">
            <h2>${escapeHtml(column.title)}</h2>
            <span>${column.cards.length}</span>
          </header>
          <form class="new-card-form" data-column-id="${escapeHtml(column.id)}">
            <input name="text" autocomplete="off" placeholder="Add a card..." />
            <button type="submit">Add</button>
          </form>
          <div class="cards" data-column-id="${escapeHtml(column.id)}">
            ${column.cards.map(cardHtml).join('')}
          </div>
        </section>
      `).join('')}
    </main>
  `;

  bindDomEvents();
}

function bindDomEvents() {
  document.querySelectorAll('.new-card-form').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const columnId = form.dataset.columnId;
      const input = form.elements.text;
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      try {
        await request('/api/cards', {
          method: 'POST',
          body: JSON.stringify({ columnId, text }),
        });
      } catch (error) {
        setStatus(error.message, true);
        input.value = text;
      }
    });
  });

  document.querySelectorAll('.card').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (event) => {
      draggedCardId = cardEl.dataset.cardId;
      cardEl.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedCardId);
    });

    cardEl.addEventListener('dragend', () => {
      draggedCardId = null;
      document.querySelectorAll('.dragging, .drop-target').forEach((el) => el.classList.remove('dragging', 'drop-target'));
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      const afterElement = getDragAfterElement(list, event.clientY);
      const dragging = document.querySelector('.card.dragging');
      if (!dragging) return;
      if (afterElement == null) list.appendChild(dragging);
      else list.insertBefore(dragging, afterElement);
    });

    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      const cardId = draggedCardId || event.dataTransfer.getData('text/plain');
      if (!cardId) return;
      const columnId = list.dataset.columnId;
      await optimisticMoveFromDom(cardId, columnId, list);
    });
  });
}

async function optimisticMoveFromDom(cardId, columnId, list) {
  const cardEl = list.querySelector(`[data-card-id="${cssEscape(cardId)}"]`);
  if (!cardEl) return;
  const ids = [...list.querySelectorAll('.card')].map((el) => el.dataset.cardId);
  const index = ids.indexOf(cardId);
  const afterId = index > 0 ? ids[index - 1] : null;
  const beforeId = index >= 0 && index < ids.length - 1 ? ids[index + 1] : null;

  const found = findCard(cardId);
  if (!found) return;
  const optimisticCard = { ...found.card, columnId, position: optimisticPosition(columnId, beforeId, afterId) };
  removeCardEverywhere(cardId);
  insertCard(optimisticCard, columnId, index);
  pendingMove = { cardId, columnId, beforeId, afterId };
  render();

  try {
    const response = await request(`/api/cards/${encodeURIComponent(cardId)}/move`, {
      method: 'PATCH',
      body: JSON.stringify({ columnId, beforeId, afterId }),
    });
    applyCanonicalCard(response.card);
    pendingMove = null;
    render();
  } catch (error) {
    pendingMove = null;
    setStatus(error.message, true);
    await loadBoard();
  }
}

function optimisticPosition(columnId, beforeId, afterId) {
  const column = board.columns.find((item) => item.id === columnId);
  if (!column) return Date.now();
  const before = beforeId ? column.cards.find((card) => card.id === beforeId) : null;
  const after = afterId ? column.cards.find((card) => card.id === afterId) : null;
  if (before && after) return (Number(before.position) + Number(after.position)) / 2;
  if (after) return Number(after.position) + 1024;
  if (before) return Number(before.position) / 2;
  return 1024;
}

function getDragAfterElement(container, y) {
  const elements = [...container.querySelectorAll('.card:not(.dragging)')];
  return elements.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) return { offset, element: child };
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
}

function connectStream() {
  const stream = new EventSource(apiUrl('/api/stream'));

  stream.addEventListener('connected', () => setStatus('Live'));
  stream.addEventListener('board', (event) => {
    setBoard(JSON.parse(event.data));
    if (pendingMove) {
      const found = findCard(pendingMove.cardId);
      if (!found || found.column.id !== pendingMove.columnId) pendingMove = null;
    }
  });
  stream.addEventListener('create', (event) => {
    const { card } = JSON.parse(event.data);
    applyCanonicalCard(card);
    render();
  });
  stream.addEventListener('move', (event) => {
    const { card } = JSON.parse(event.data);
    applyCanonicalCard(card);
    if (pendingMove?.cardId === card.id) pendingMove = null;
    render();
  });
  stream.onerror = () => setStatus('Reconnecting...', true);
}

async function loadBoard() {
  setStatus('Loading...');
  setBoard(await request('/api/board'));
  setStatus('Live');
}

function setStatus(message, warn = false) {
  const status = document.querySelector('#status');
  if (status) {
    status.textContent = message;
    status.classList.toggle('warn', warn);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[char]));
}

function cssEscape(value) {
  if (window.CSS?.escape) return CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

loadBoard().then(connectStream).catch((error) => {
  app.innerHTML = `<div class="fatal">Failed to load board: ${escapeHtml(error.message)}</div>`;
});
