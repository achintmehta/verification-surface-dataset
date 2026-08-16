import './styles.css';

const app = document.querySelector('#app');

let board = { columns: [] };
let draggedCardId = null;
let stream = null;
let pending = new Set();

const api = {
  async board() {
    const response = await fetch('/api/board');
    if (!response.ok) throw new Error('Unable to load board');
    return response.json();
  },
  async createCard(columnId, text) {
    const response = await fetch('/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Unable to create card');
    return response.json();
  },
  async moveCard(id, intent) {
    const response = await fetch(`/api/cards/${encodeURIComponent(id)}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(intent),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Unable to move card');
    return response.json();
  },
};

function setStatus(message, tone = 'neutral') {
  const el = document.querySelector('[data-status]');
  if (!el) return;
  el.textContent = message;
  el.dataset.tone = tone;
}

function sortBoard(nextBoard) {
  const columns = [...(nextBoard.columns || [])]
    .sort((a, b) => a.position - b.position)
    .map((column) => ({
      ...column,
      cards: [...(column.cards || [])].sort((a, b) => {
        if (a.position !== b.position) return a.position - b.position;
        return String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id.localeCompare(b.id);
      }),
    }));
  return { columns };
}

function replaceBoard(nextBoard) {
  board = sortBoard(nextBoard);
  render();
}

function findCard(cardId) {
  for (const column of board.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index !== -1) return { column, card: column.cards[index], index };
  }
  return null;
}

function optimisticMove(cardId, targetColumnId, targetIndex) {
  const found = findCard(cardId);
  if (!found) return;

  const card = { ...found.card, columnId: targetColumnId, optimistic: true };
  const nextColumns = board.columns.map((column) => ({
    ...column,
    cards: column.cards.filter((candidate) => candidate.id !== cardId),
  }));
  const target = nextColumns.find((column) => column.id === targetColumnId);
  if (!target) return;
  const boundedIndex = Math.max(0, Math.min(targetIndex, target.cards.length));
  target.cards.splice(boundedIndex, 0, card);
  board = { columns: nextColumns };
  render();
}

function cardsForColumn(columnId) {
  const column = board.columns.find((candidate) => candidate.id === columnId);
  return column ? column.cards : [];
}

function getInsertionIndex(columnEl, clientY) {
  const cardEls = [...columnEl.querySelectorAll('.card:not(.dragging)')];
  const target = cardEls.find((cardEl) => {
    const rect = cardEl.getBoundingClientRect();
    return clientY < rect.top + rect.height / 2;
  });
  return target ? cardEls.indexOf(target) : cardEls.length;
}

function getMoveIntent(columnId, index, movingCardId) {
  const cards = cardsForColumn(columnId).filter((card) => card.id !== movingCardId);
  const before = cards[index] || null;
  const after = cards[index - 1] || null;
  return {
    columnId,
    beforeId: before?.id || null,
    afterId: after?.id || null,
  };
}

async function handleDrop(event) {
  event.preventDefault();
  const columnEl = event.currentTarget;
  columnEl.classList.remove('drag-over');
  const cardId = draggedCardId || event.dataTransfer?.getData('text/plain');
  if (!cardId) return;

  const columnId = columnEl.dataset.columnId;
  const index = getInsertionIndex(columnEl, event.clientY);
  const intent = getMoveIntent(columnId, index, cardId);

  optimisticMove(cardId, columnId, index);
  pending.add(cardId);
  setStatus('Saving move…');

  try {
    const payload = await api.moveCard(cardId, intent);
    pending.delete(cardId);
    if (payload.board) replaceBoard(payload.board);
    setStatus('Board synced', 'ok');
  } catch (error) {
    pending.delete(cardId);
    setStatus(error.message, 'error');
    loadBoard();
  }
}

async function handleCreate(event, columnId) {
  event.preventDefault();
  const input = event.currentTarget.querySelector('input[name="text"]');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  setStatus('Creating card…');
  try {
    const payload = await api.createCard(columnId, text);
    if (payload.board) replaceBoard(payload.board);
    setStatus('Board synced', 'ok');
  } catch (error) {
    input.value = text;
    setStatus(error.message, 'error');
  }
}

function render() {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <p class="eyebrow">PGLite + SSE</p>
        <h1>Collaborative Kanban Board</h1>
      </div>
      <div data-status data-tone="neutral" class="status">Connecting…</div>
    </header>
    <main class="board" aria-label="Kanban board"></main>
  `;

  const boardEl = app.querySelector('.board');
  for (const column of board.columns) {
    const section = document.createElement('section');
    section.className = 'column';
    section.dataset.columnId = column.id;
    section.innerHTML = `
      <div class="column-header">
        <h2>${escapeHtml(column.title)}</h2>
        <span>${column.cards.length}</span>
      </div>
      <div class="cards" data-column-id="${escapeHtml(column.id)}"></div>
      <form class="add-card">
        <input name="text" autocomplete="off" placeholder="Add a card…" aria-label="New card text for ${escapeHtml(column.title)}" />
        <button type="submit">Add</button>
      </form>
    `;

    const cardsEl = section.querySelector('.cards');
    cardsEl.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      cardsEl.classList.add('drag-over');
    });
    cardsEl.addEventListener('dragleave', (event) => {
      if (!cardsEl.contains(event.relatedTarget)) cardsEl.classList.remove('drag-over');
    });
    cardsEl.addEventListener('drop', handleDrop);

    for (const card of column.cards) {
      const cardEl = document.createElement('article');
      cardEl.className = `card${card.optimistic || pending.has(card.id) ? ' optimistic' : ''}`;
      cardEl.draggable = true;
      cardEl.dataset.cardId = card.id;
      cardEl.innerHTML = `<p>${escapeHtml(card.text)}</p>`;
      cardEl.addEventListener('dragstart', (event) => {
        draggedCardId = card.id;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', card.id);
        requestAnimationFrame(() => cardEl.classList.add('dragging'));
      });
      cardEl.addEventListener('dragend', () => {
        draggedCardId = null;
        document.querySelectorAll('.dragging,.drag-over').forEach((el) => el.classList.remove('dragging', 'drag-over'));
      });
      cardsEl.append(cardEl);
    }

    section.querySelector('form').addEventListener('submit', (event) => handleCreate(event, column.id));
    boardEl.append(section);
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

async function loadBoard() {
  try {
    replaceBoard(await api.board());
    setStatus('Board synced', 'ok');
  } catch (error) {
    app.innerHTML = `<div class="fatal"><h1>Could not load board</h1><p>${escapeHtml(error.message)}</p><button>Retry</button></div>`;
    app.querySelector('button').addEventListener('click', loadBoard);
  }
}

function connectStream() {
  stream?.close();
  stream = new EventSource('/api/stream');

  stream.addEventListener('connected', () => setStatus('Live updates connected', 'ok'));
  stream.addEventListener('board', (event) => {
    replaceBoard(JSON.parse(event.data));
    setStatus('Board synced', 'ok');
  });

  for (const eventName of ['card:create', 'card:move']) {
    stream.addEventListener(eventName, (event) => {
      const payload = JSON.parse(event.data);
      if (payload.board) replaceBoard(payload.board);
      setStatus('Board synced', 'ok');
    });
  }

  stream.onerror = () => {
    setStatus('Live updates reconnecting…', 'error');
  };
}

loadBoard().then(connectStream);
