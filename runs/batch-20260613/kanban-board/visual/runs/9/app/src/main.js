import './styles.css';

const app = document.querySelector('#app');

let board = { columns: [] };
let draggedCardId = null;
let eventSource = null;
let streamState = 'Connecting…';

const api = {
  async board() {
    const res = await fetch('/api/board');
    if (!res.ok) throw new Error('Failed to load board');
    return res.json();
  },
  async createCard(columnId, text) {
    const res = await fetch('/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text })
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Failed to create card');
    return res.json();
  },
  async moveCard(cardId, columnId, beforeId, afterId) {
    const res = await fetch(`/api/cards/${encodeURIComponent(cardId)}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId })
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Failed to move card');
    return res.json();
  }
};

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
}

function sortBoard(nextBoard) {
  const seen = new Set();
  const columns = [...(nextBoard.columns || [])]
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    .map((column) => {
      const cards = [...(column.cards || [])]
        .filter((card) => {
          if (seen.has(card.id)) return false;
          seen.add(card.id);
          return true;
        })
        .sort((a, b) => a.position - b.position || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id));
      return { ...column, cards };
    });
  return { columns };
}

function findCard(cardId) {
  for (const column of board.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index !== -1) return { column, card: column.cards[index], index };
  }
  return null;
}

function applyBoard(nextBoard) {
  board = sortBoard(nextBoard);
  render();
}

function render() {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are pushed live with Server-Sent Events.</p>
      </div>
      <span class="status ${streamState === 'Live' ? 'live' : streamState === 'Reconnecting…' ? 'reconnecting' : ''}" id="connection-status">${streamState}</span>
    </header>
    <main class="board" aria-label="Kanban board">
      ${board.columns.map(renderColumn).join('')}
    </main>
  `;

  wireForms();
  wireDragAndDrop();
}

function renderColumn(column) {
  return `
    <section class="column" data-column-id="${escapeHtml(column.id)}">
      <div class="column-header">
        <h2>${escapeHtml(column.title)}</h2>
        <span>${column.cards.length}</span>
      </div>
      <div class="cards" data-column-id="${escapeHtml(column.id)}">
        ${column.cards.map(renderCard).join('')}
      </div>
      <form class="add-card" data-column-id="${escapeHtml(column.id)}">
        <input name="text" autocomplete="off" maxlength="500" placeholder="Add a card…" aria-label="New card text" />
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

function wireForms() {
  document.querySelectorAll('.add-card').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = form.elements.text;
      const text = input.value.trim();
      if (!text) return;

      input.value = '';
      input.disabled = true;
      try {
        await api.createCard(form.dataset.columnId, text);
        // The SSE broadcast (also received by this client) is the canonical update.
      } catch (error) {
        input.value = text;
        showToast(error.message);
      } finally {
        input.disabled = false;
        input.focus();
      }
    });
  });
}

function wireDragAndDrop() {
  document.querySelectorAll('.card').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (event) => {
      draggedCardId = cardEl.dataset.cardId;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedCardId);
      requestAnimationFrame(() => cardEl.classList.add('dragging'));
    });

    cardEl.addEventListener('dragend', () => {
      cardEl.classList.remove('dragging');
      document.querySelectorAll('.cards.drag-over').forEach((el) => el.classList.remove('drag-over'));
      draggedCardId = null;
    });
  });

  document.querySelectorAll('.cards').forEach((cardsEl) => {
    cardsEl.addEventListener('dragover', (event) => {
      event.preventDefault();
      cardsEl.classList.add('drag-over');
      const dragging = document.querySelector('.card.dragging');
      if (!dragging) return;
      const afterElement = getDragAfterElement(cardsEl, event.clientY);
      if (afterElement == null) cardsEl.appendChild(dragging);
      else cardsEl.insertBefore(dragging, afterElement);
    });

    cardsEl.addEventListener('dragleave', (event) => {
      if (!cardsEl.contains(event.relatedTarget)) cardsEl.classList.remove('drag-over');
    });

    cardsEl.addEventListener('drop', async (event) => {
      event.preventDefault();
      cardsEl.classList.remove('drag-over');
      const cardId = draggedCardId || event.dataTransfer.getData('text/plain');
      if (!cardId) return;

      const columnId = cardsEl.dataset.columnId;
      const order = [...cardsEl.querySelectorAll('.card')].map((el) => el.dataset.cardId);
      const index = order.indexOf(cardId);
      const afterId = index > 0 ? order[index - 1] : null;
      const beforeId = index >= 0 && index < order.length - 1 ? order[index + 1] : null;

      optimisticMove(cardId, columnId, beforeId, afterId);

      try {
        await api.moveCard(cardId, columnId, beforeId, afterId);
        // Canonical reconciliation happens when the SSE move event arrives.
      } catch (error) {
        showToast(error.message);
        reloadBoard();
      }
    });
  });
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

function optimisticMove(cardId, columnId, beforeId, afterId) {
  const found = findCard(cardId);
  if (!found) return;

  for (const column of board.columns) {
    column.cards = column.cards.filter((card) => card.id !== cardId);
  }

  const target = board.columns.find((column) => column.id === columnId);
  if (!target) return;

  const card = { ...found.card, column_id: columnId, position: optimisticPosition(target, beforeId, afterId) };
  let insertAt = target.cards.length;
  if (beforeId) {
    const idx = target.cards.findIndex((c) => c.id === beforeId);
    if (idx !== -1) insertAt = idx;
  } else if (afterId) {
    const idx = target.cards.findIndex((c) => c.id === afterId);
    if (idx !== -1) insertAt = idx + 1;
  }
  target.cards.splice(insertAt, 0, card);
  render();
}

function optimisticPosition(column, beforeId, afterId) {
  const before = beforeId ? column.cards.find((card) => card.id === beforeId) : null;
  const after = afterId ? column.cards.find((card) => card.id === afterId) : null;
  if (before && after) return (before.position + after.position) / 2;
  if (after) return after.position + 1000;
  if (before) return before.position - 1000;
  return 1000;
}

async function reloadBoard() {
  try {
    applyBoard(await api.board());
  } catch (error) {
    showToast(error.message);
  }
}

function connectStream() {
  eventSource?.close();
  eventSource = new EventSource('/api/stream');

  const status = () => document.querySelector('#connection-status');
  eventSource.onopen = () => {
    streamState = 'Live';
    const el = status();
    if (el) {
      el.textContent = streamState;
      el.className = 'status live';
    }
  };
  eventSource.onerror = () => {
    streamState = 'Reconnecting…';
    const el = status();
    if (el) {
      el.textContent = streamState;
      el.className = 'status reconnecting';
    }
  };

  const handle = (event) => {
    const message = JSON.parse(event.data);
    if (message.board) applyBoard(message.board);
  };
  eventSource.addEventListener('connected', handle);
  eventSource.addEventListener('create', handle);
  eventSource.addEventListener('move', handle);
}

let toastTimer;
function showToast(message) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3500);
}

reloadBoard();
connectStream();
