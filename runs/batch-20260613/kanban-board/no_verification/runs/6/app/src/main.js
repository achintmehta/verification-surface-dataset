import './styles.css';

const API_BASE = '';
const app = document.querySelector('#app');

let board = { columns: [] };
let draggedCardId = null;
let draggedFromColumnId = null;
let pendingMoves = new Set();

app.innerHTML = `
  <header class="topbar">
    <div>
      <h1>Collaborative Kanban</h1>
      <p>Drag cards between columns. Every committed change is streamed from the server.</p>
    </div>
    <div id="connectionStatus" class="status status-offline">Connecting…</div>
  </header>
  <main id="board" class="board" aria-label="Kanban board"></main>
`;

const boardEl = document.querySelector('#board');
const statusEl = document.querySelector('#connectionStatus');

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setStatus(connected, text) {
  statusEl.textContent = text || (connected ? 'Live' : 'Offline');
  statusEl.className = `status ${connected ? 'status-online' : 'status-offline'}`;
}

function normalizeBoard(nextBoard) {
  const seenCards = new Set();
  return {
    columns: [...(nextBoard?.columns || [])]
      .sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id))
      .map((column) => {
        const cards = [...(column.cards || [])]
          .sort((a, b) => Number(a.position) - Number(b.position) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id.localeCompare(b.id))
          .filter((card) => {
            if (seenCards.has(card.id)) return false;
            seenCards.add(card.id);
            return true;
          });
        return { ...column, cards };
      }),
  };
}

function getColumn(columnId) {
  return board.columns.find((column) => column.id === columnId);
}

function getCardLocation(cardId) {
  for (const column of board.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index !== -1) return { column, index, card: column.cards[index] };
  }
  return null;
}

function applyBoard(nextBoard) {
  board = normalizeBoard(nextBoard);
  renderBoard();
}

function cardHtml(card) {
  const pending = pendingMoves.has(card.id) ? ' pending' : '';
  return `
    <article class="card${pending}" draggable="true" data-card-id="${escapeHtml(card.id)}">
      <div class="card-text">${escapeHtml(card.text)}</div>
      <div class="card-meta">#${escapeHtml(card.id.slice(0, 8))}</div>
    </article>
  `;
}

function renderBoard() {
  boardEl.innerHTML = board.columns.map((column) => `
    <section class="column" data-column-id="${escapeHtml(column.id)}">
      <div class="column-header">
        <h2>${escapeHtml(column.title)}</h2>
        <span class="count">${column.cards.length}</span>
      </div>
      <div class="cards" data-column-id="${escapeHtml(column.id)}" aria-label="${escapeHtml(column.title)} cards">
        ${column.cards.map(cardHtml).join('')}
      </div>
      <form class="add-card" data-column-id="${escapeHtml(column.id)}">
        <input name="text" type="text" placeholder="Add a card…" autocomplete="off" maxlength="240" aria-label="New card text" />
        <button type="submit">Add</button>
      </form>
    </section>
  `).join('');

  bindDragHandlers();
  bindCreateHandlers();
}

function bindCreateHandlers() {
  document.querySelectorAll('.add-card').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = form.elements.text;
      const text = input.value.trim();
      const columnId = form.dataset.columnId;
      if (!text || !columnId) return;

      input.value = '';
      try {
        const response = await fetch(`${API_BASE}/api/cards`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId, text }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Unable to create card');
        if (result.board) applyBoard(result.board);
      } catch (error) {
        input.value = text;
        alert(error.message);
      }
    });
  });
}

function bindDragHandlers() {
  document.querySelectorAll('.card').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (event) => {
      draggedCardId = cardEl.dataset.cardId;
      draggedFromColumnId = cardEl.closest('.cards')?.dataset.columnId || null;
      cardEl.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedCardId);
    });

    cardEl.addEventListener('dragend', () => {
      cardEl.classList.remove('dragging');
      cleanupDropIndicators();
      draggedCardId = null;
      draggedFromColumnId = null;
    });
  });

  document.querySelectorAll('.cards').forEach((listEl) => {
    listEl.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (!draggedCardId) return;
      event.dataTransfer.dropEffect = 'move';

      const afterElement = getDragAfterElement(listEl, event.clientY);
      const draggingEl = document.querySelector(`[data-card-id="${cssEscape(draggedCardId)}"]`);
      if (!draggingEl) return;

      listEl.classList.add('drop-target');
      if (afterElement == null) {
        listEl.appendChild(draggingEl);
      } else {
        listEl.insertBefore(draggingEl, afterElement);
      }
    });

    listEl.addEventListener('dragleave', (event) => {
      if (!listEl.contains(event.relatedTarget)) listEl.classList.remove('drop-target');
    });

    listEl.addEventListener('drop', async (event) => {
      event.preventDefault();
      cleanupDropIndicators();
      if (!draggedCardId) return;

      const cardId = draggedCardId;
      const targetColumnId = listEl.dataset.columnId;
      const { beforeId, afterId } = getNeighborIdsFromDom(cardId, listEl);
      draggedCardId = null;
      draggedFromColumnId = null;

      applyOptimisticMove(cardId, targetColumnId, beforeId, afterId);
      pendingMoves.add(cardId);
      renderBoard();

      try {
        const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId: targetColumnId, beforeId, afterId }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Unable to move card');
        pendingMoves.delete(cardId);
        if (result.board) applyBoard(result.board);
      } catch (error) {
        pendingMoves.delete(cardId);
        await loadBoard();
        alert(error.message);
      }
    });
  });
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function cleanupDropIndicators() {
  document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
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

function getNeighborIdsFromDom(cardId, listEl) {
  const cardEls = [...listEl.querySelectorAll('.card')];
  const index = cardEls.findIndex((el) => el.dataset.cardId === cardId);
  const before = index >= 0 ? cardEls[index + 1] : null;
  const after = index > 0 ? cardEls[index - 1] : null;
  return {
    beforeId: before?.dataset.cardId || null,
    afterId: after?.dataset.cardId || null,
  };
}

function applyOptimisticMove(cardId, columnId, beforeId, afterId) {
  const location = getCardLocation(cardId);
  if (!location) return;

  const [card] = location.column.cards.splice(location.index, 1);
  const target = getColumn(columnId);
  if (!target) {
    location.column.cards.splice(location.index, 0, card);
    return;
  }

  card.columnId = columnId;
  let insertAt = target.cards.length;
  if (beforeId) {
    const beforeIndex = target.cards.findIndex((candidate) => candidate.id === beforeId);
    if (beforeIndex !== -1) insertAt = beforeIndex;
  } else if (afterId) {
    const afterIndex = target.cards.findIndex((candidate) => candidate.id === afterId);
    if (afterIndex !== -1) insertAt = afterIndex + 1;
  }
  target.cards.splice(insertAt, 0, card);
}

async function loadBoard() {
  const response = await fetch(`${API_BASE}/api/board`);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Unable to load board');
  applyBoard(result);
}

function connectStream() {
  const source = new EventSource(`${API_BASE}/api/stream`);

  source.onopen = () => setStatus(true, 'Live');
  source.onerror = () => setStatus(false, 'Reconnecting…');
  source.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.card?.id) pendingMoves.delete(message.card.id);
      if (message.board) applyBoard(message.board);
      setStatus(true, 'Live');
    } catch (error) {
      console.error('Bad SSE message:', error);
    }
  };
}

loadBoard()
  .then(() => connectStream())
  .catch((error) => {
    boardEl.innerHTML = `<div class="fatal">${escapeHtml(error.message)}</div>`;
    setStatus(false, 'Unable to load');
  });
