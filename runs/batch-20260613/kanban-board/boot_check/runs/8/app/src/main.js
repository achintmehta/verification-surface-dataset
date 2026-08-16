import './styles.css';

const API_BASE = '';
const app = document.querySelector('#app');

let board = { columns: [] };
let draggedCardId = null;
let draggedFromColumnId = null;
let connectionStatus = 'connecting';

function cardById(cardId) {
  for (const column of board.columns) {
    const card = column.cards.find((item) => item.id === cardId);
    if (card) return { card, column };
  }
  return null;
}

function removeCardEverywhere(cardId) {
  let removed = null;
  for (const column of board.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index >= 0) {
      const [card] = column.cards.splice(index, 1);
      removed = card;
    }
  }
  return removed;
}

function sortedCards(cards) {
  return [...cards].sort((a, b) => (a.position - b.position) || String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
}

function normalizeBoard(nextBoard) {
  board = {
    columns: [...(nextBoard.columns || [])]
      .sort((a, b) => (a.position - b.position) || a.id.localeCompare(b.id))
      .map((column) => ({
        ...column,
        cards: sortedCards(column.cards || [])
      }))
  };
}

function applyCanonicalCard(card) {
  removeCardEverywhere(card.id);
  const column = board.columns.find((item) => item.id === card.columnId);
  if (!column) return;
  column.cards.push(card);
  column.cards = sortedCards(column.cards);
}

function getDropIntent(columnEl, clientY, movingCardId = draggedCardId) {
  const cardEls = [...columnEl.querySelectorAll('.card:not(.dragging)')].filter((el) => el.dataset.cardId !== movingCardId);
  let beforeId = null;
  let afterId = null;

  for (const cardEl of cardEls) {
    const rect = cardEl.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      beforeId = cardEl.dataset.cardId;
      break;
    }
    afterId = cardEl.dataset.cardId;
  }

  return { beforeId, afterId };
}

function optimisticMove(cardId, columnId, beforeId, afterId) {
  const existing = cardById(cardId);
  const moving = removeCardEverywhere(cardId) || existing?.card;
  const target = board.columns.find((column) => column.id === columnId);
  if (!moving || !target) return;

  moving.columnId = columnId;
  const targetCards = target.cards;
  const beforeIndex = beforeId ? targetCards.findIndex((card) => card.id === beforeId) : -1;
  const afterIndex = afterId ? targetCards.findIndex((card) => card.id === afterId) : -1;
  let insertIndex = targetCards.length;
  if (beforeIndex >= 0) insertIndex = beforeIndex;
  else if (afterIndex >= 0) insertIndex = afterIndex + 1;

  targetCards.splice(insertIndex, 0, moving);
}

async function loadBoard() {
  const response = await fetch(`${API_BASE}/api/board`);
  if (!response.ok) throw new Error('Unable to load board');
  normalizeBoard(await response.json());
  render();
}

async function createCard(columnId, text) {
  const response = await fetch(`${API_BASE}/api/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text })
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw new Error(details.error || 'Unable to create card');
  }
  const card = await response.json();
  applyCanonicalCard(card);
  render();
}

async function moveCard(cardId, columnId, beforeId, afterId) {
  const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, beforeId, afterId })
  });
  if (!response.ok) {
    await loadBoard();
    const details = await response.json().catch(() => ({}));
    throw new Error(details.error || 'Unable to move card');
  }
  const card = await response.json();
  applyCanonicalCard(card);
  render();
}

function render() {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast live by SSE.</p>
      </div>
      <span class="status status-${connectionStatus}">${connectionStatus}</span>
    </header>
    <main class="board" aria-label="Kanban board">
      ${board.columns.map((column) => `
        <section class="column" data-column-id="${column.id}">
          <div class="column-header">
            <h2>${escapeHtml(column.title)}</h2>
            <span>${column.cards.length}</span>
          </div>
          <div class="cards" data-column-id="${column.id}">
            ${column.cards.map((card) => `
              <article class="card" draggable="true" data-card-id="${card.id}">
                <p>${escapeHtml(card.text)}</p>
              </article>
            `).join('')}
          </div>
          <form class="add-card" data-column-id="${column.id}">
            <input name="text" type="text" maxlength="240" placeholder="Add a card…" aria-label="Card text for ${escapeHtml(column.title)}" />
            <button type="submit">Add</button>
          </form>
        </section>
      `).join('')}
    </main>
  `;

  bindDomEvents();
}

function bindDomEvents() {
  document.querySelectorAll('.add-card').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = form.elements.text;
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      try {
        await createCard(form.dataset.columnId, text);
      } catch (error) {
        input.value = text;
        showToast(error.message);
      }
    });
  });

  document.querySelectorAll('.card').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (event) => {
      draggedCardId = cardEl.dataset.cardId;
      draggedFromColumnId = cardEl.closest('.cards').dataset.columnId;
      cardEl.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedCardId);
    });

    cardEl.addEventListener('dragend', () => {
      cardEl.classList.remove('dragging');
      clearDropMarkers();
      draggedCardId = null;
      draggedFromColumnId = null;
    });
  });

  document.querySelectorAll('.cards').forEach((columnEl) => {
    columnEl.addEventListener('dragover', (event) => {
      if (!draggedCardId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      markDropTarget(columnEl, event.clientY);
    });

    columnEl.addEventListener('dragleave', (event) => {
      if (!columnEl.contains(event.relatedTarget)) columnEl.classList.remove('drop-target');
    });

    columnEl.addEventListener('drop', async (event) => {
      event.preventDefault();
      if (!draggedCardId) return;
      const cardId = event.dataTransfer.getData('text/plain') || draggedCardId;
      const columnId = columnEl.dataset.columnId;
      const { beforeId, afterId } = getDropIntent(columnEl, event.clientY, cardId);
      const previousBoard = structuredClone(board);

      optimisticMove(cardId, columnId, beforeId, afterId);
      render();

      try {
        await moveCard(cardId, columnId, beforeId, afterId);
      } catch (error) {
        board = previousBoard;
        render();
        showToast(error.message);
      }
    });
  });
}

function markDropTarget(columnEl, clientY) {
  clearDropMarkers();
  columnEl.classList.add('drop-target');
  const { beforeId } = getDropIntent(columnEl, clientY);
  if (beforeId) {
    const beforeEl = columnEl.querySelector(`[data-card-id="${CSS.escape(beforeId)}"]`);
    beforeEl?.classList.add('drop-before');
  } else {
    columnEl.classList.add('drop-end');
  }
}

function clearDropMarkers() {
  document.querySelectorAll('.drop-target, .drop-before, .drop-end').forEach((el) => {
    el.classList.remove('drop-target', 'drop-before', 'drop-end');
  });
}

function connectStream() {
  const source = new EventSource(`${API_BASE}/api/stream`);

  source.onopen = () => {
    connectionStatus = 'live';
    render();
  };

  source.onerror = () => {
    connectionStatus = 'reconnecting';
    render();
  };

  source.addEventListener('board-state', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.board) {
      normalizeBoard(payload.board);
      render();
    }
  });

  source.addEventListener('card-created', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.card) {
      applyCanonicalCard(payload.card);
      render();
    }
  });

  source.addEventListener('card-moved', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.card) {
      applyCanonicalCard(payload.card);
      render();
    }
  });
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

loadBoard().catch((error) => {
  app.innerHTML = `<div class="fatal"><h1>Unable to load board</h1><p>${escapeHtml(error.message)}</p></div>`;
});
connectStream();
