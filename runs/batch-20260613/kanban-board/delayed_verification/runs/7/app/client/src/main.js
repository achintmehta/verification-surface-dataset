import './styles.css';

const app = document.querySelector('#app');
const API = '';

let board = { columns: [] };
let draggedId = null;
let eventSource = null;
let reconnectTimer = null;

app.innerHTML = `
  <main class="app-shell">
    <header class="header">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Every connected browser converges to the server order.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    <section id="board" class="board" aria-live="polite"></section>
  </main>
`;

const boardEl = document.querySelector('#board');
const statusEl = document.querySelector('#status');

function setStatus(text, className = '') {
  statusEl.textContent = text;
  statusEl.className = `status ${className}`.trim();
}

async function requestJson(url, options) {
  const response = await fetch(`${API}${url}`, {
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
    ...options
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const error = await response.json();
      message = error.error || message;
    } catch {
      // ignore non-JSON error bodies
    }
    throw new Error(message);
  }
  return response.json();
}

async function loadBoard() {
  try {
    board = await requestJson('/api/board');
    renderBoard();
  } catch (error) {
    boardEl.innerHTML = `
      <div class="notice">
        <p>Could not load the board: ${escapeHtml(error.message)}</p>
        <button class="retry" type="button">Retry</button>
      </div>
    `;
    boardEl.querySelector('.retry')?.addEventListener('click', loadBoard);
  }
}

function renderBoard() {
  const previousActive = document.activeElement;
  const activeColumn = previousActive?.dataset?.columnId;
  const activeValue = previousActive?.value;

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
      <div class="cards" data-column-id="${escapeHtml(column.id)}"></div>
      <form class="add-card" data-column-id="${escapeHtml(column.id)}">
        <input data-column-id="${escapeHtml(column.id)}" name="text" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
    `;

    const cardsEl = columnEl.querySelector('.cards');
    cardsEl.addEventListener('dragover', handleDragOver);
    cardsEl.addEventListener('dragleave', handleDragLeave);
    cardsEl.addEventListener('drop', handleDrop);

    for (const card of column.cards) {
      cardsEl.appendChild(createCardElement(card));
    }

    columnEl.querySelector('.add-card').addEventListener('submit', handleCreateCard);
    boardEl.appendChild(columnEl);
  }

  if (activeColumn) {
    const input = boardEl.querySelector(`input[data-column-id="${cssEscape(activeColumn)}"]`);
    if (input) {
      input.value = activeValue || '';
      input.focus();
    }
  }
}

function createCardElement(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.draggable = true;
  cardEl.dataset.cardId = card.id;
  cardEl.textContent = card.text;
  cardEl.title = 'Drag to reorder or move';
  cardEl.addEventListener('dragstart', handleDragStart);
  cardEl.addEventListener('dragend', handleDragEnd);
  return cardEl;
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
    const { card } = await requestJson('/api/cards', {
      method: 'POST',
      body: JSON.stringify({ columnId, text })
    });
    // Show the author's card immediately. The following SSE mutation carries the full canonical board.
    upsertCard(card);
    renderBoard();
  } catch (error) {
    input.value = text;
    alert(`Could not create card: ${error.message}`);
  }
}

function handleDragStart(event) {
  draggedId = event.currentTarget.dataset.cardId;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggedId);
  window.setTimeout(() => event.currentTarget.classList.add('dragging'), 0);
}

function handleDragEnd() {
  document.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
  document.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
  draggedId = null;
}

function handleDragLeave(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) {
    event.currentTarget.classList.remove('drag-over');
  }
}

function handleDragOver(event) {
  event.preventDefault();
  const cardsEl = event.currentTarget;
  cardsEl.classList.add('drag-over');
  const draggedEl = document.querySelector(`.card[data-card-id="${cssEscape(draggedId || '')}"]`);
  if (!draggedEl) return;

  const beforeEl = getDragInsertionElement(cardsEl, event.clientY);
  if (beforeEl) cardsEl.insertBefore(draggedEl, beforeEl);
  else cardsEl.appendChild(draggedEl);
}

async function handleDrop(event) {
  event.preventDefault();
  const cardsEl = event.currentTarget;
  cardsEl.classList.remove('drag-over');

  const cardId = draggedId || event.dataTransfer.getData('text/plain');
  const draggedEl = document.querySelector(`.card[data-card-id="${cssEscape(cardId)}"]`);
  if (!draggedEl) return;
  if (draggedEl.parentElement !== cardsEl) cardsEl.appendChild(draggedEl);

  const columnId = cardsEl.dataset.columnId;
  const { beforeId, afterId } = getNeighborIntent(draggedEl);

  applyDomOrderOptimistically();

  try {
    const { card } = await requestJson(`/api/cards/${encodeURIComponent(cardId)}/move`, {
      method: 'PATCH',
      body: JSON.stringify({ columnId, beforeId, afterId })
    });
    upsertCard(card);
    renderBoard();
    // The following SSE mutation carries the complete canonical board for every client.
  } catch (error) {
    alert(`Could not move card: ${error.message}`);
    await loadBoard();
  }
}

function getDragInsertionElement(container, y) {
  const candidates = [...container.querySelectorAll('.card:not(.dragging)')];
  let closest = { offset: Number.NEGATIVE_INFINITY, element: null };

  for (const child of candidates) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      closest = { offset, element: child };
    }
  }
  return closest.element;
}

function getNeighborIntent(cardEl) {
  const previous = cardEl.previousElementSibling?.classList.contains('card') ? cardEl.previousElementSibling : null;
  const next = cardEl.nextElementSibling?.classList.contains('card') ? cardEl.nextElementSibling : null;
  return {
    afterId: previous?.dataset.cardId || null,
    beforeId: next?.dataset.cardId || null
  };
}

function applyDomOrderOptimistically() {
  const byId = new Map();
  for (const column of board.columns) {
    for (const card of column.cards) byId.set(card.id, card);
    column.cards = [];
  }

  for (const columnEl of boardEl.querySelectorAll('.column')) {
    const column = board.columns.find((item) => item.id === columnEl.dataset.columnId);
    if (!column) continue;
    const cardEls = [...columnEl.querySelectorAll('.card')];
    column.cards = cardEls.map((cardEl, index) => {
      const current = byId.get(cardEl.dataset.cardId) || { id: cardEl.dataset.cardId, text: cardEl.textContent };
      return { ...current, columnId: column.id, position: index + 1 };
    });
    columnEl.querySelector('.count').textContent = column.cards.length;
  }
}

function upsertCard(card) {
  for (const column of board.columns) {
    column.cards = column.cards.filter((existing) => existing.id !== card.id);
  }
  const target = board.columns.find((column) => column.id === card.columnId);
  if (target) {
    target.cards.push(card);
    target.cards.sort(compareCards);
  }
}

function connectStream() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`${API}/api/stream`);

  eventSource.addEventListener('connected', () => setStatus('Live', 'connected'));
  eventSource.addEventListener('ping', () => setStatus('Live', 'connected'));
  eventSource.addEventListener('mutation', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.board) {
      board = payload.board;
      renderBoard();
    } else if (payload.card) {
      upsertCard(payload.card);
      renderBoard();
    }
    setStatus('Live', 'connected');
  });

  eventSource.onerror = () => {
    setStatus('Reconnecting…', 'error');
    eventSource.close();
    window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(connectStream, 1500);
  };
}

function compareCards(a, b) {
  return (Number(a.position) - Number(b.position)) || a.id.localeCompare(b.id);
}

function cssEscape(value) {
  if (window.CSS?.escape) return CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

loadBoard().finally(connectStream);
