import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || '';
const boardEl = document.querySelector('#board');
const statusEl = document.querySelector('#connection-status');

let board = { columns: [] };
let draggedCardId = null;

function byPositionThenCreated(a, b) {
  if (a.position !== b.position) return a.position - b.position;
  return String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id.localeCompare(b.id);
}

function sortBoard() {
  board.columns.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  for (const column of board.columns) {
    column.cards.sort(byPositionThenCreated);
  }
}

function getColumn(columnId) {
  return board.columns.find((column) => column.id === columnId);
}

function findCard(cardId) {
  for (const column of board.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index !== -1) return { column, card: column.cards[index], index };
  }
  return null;
}

function removeCard(cardId) {
  let removed = null;
  for (const column of board.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index !== -1) {
      removed = column.cards.splice(index, 1)[0];
    }
  }
  return removed;
}

function upsertCanonicalCard(card) {
  removeCard(card.id);
  const column = getColumn(card.columnId);
  if (!column) return;
  column.cards.push(card);
  sortBoard();
}

function render() {
  sortBoard();
  boardEl.innerHTML = '';

  for (const column of board.columns) {
    const columnEl = document.createElement('section');
    columnEl.className = 'column';
    columnEl.dataset.columnId = column.id;

    const title = document.createElement('h2');
    title.textContent = column.title;

    const list = document.createElement('div');
    list.className = 'card-list';
    list.dataset.columnId = column.id;
    list.addEventListener('dragover', handleDragOver);
    list.addEventListener('drop', handleDrop);

    for (const card of column.cards) {
      list.appendChild(createCardElement(card));
    }

    const form = document.createElement('form');
    form.className = 'new-card-form';
    form.innerHTML = `
      <input name="text" autocomplete="off" maxlength="300" placeholder="Add a card…" aria-label="New card text" />
      <button type="submit">Add</button>
    `;
    form.addEventListener('submit', (event) => createCard(event, column.id));

    columnEl.append(title, list, form);
    boardEl.appendChild(columnEl);
  }
}

function createCardElement(card) {
  const cardEl = document.createElement('article');
  cardEl.className = 'card';
  cardEl.draggable = true;
  cardEl.dataset.cardId = card.id;
  cardEl.textContent = card.text;
  cardEl.addEventListener('dragstart', handleDragStart);
  cardEl.addEventListener('dragend', handleDragEnd);
  return cardEl;
}

function getDropTarget(list, y) {
  const candidates = [...list.querySelectorAll('.card:not(.dragging)')];
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

function handleDragStart(event) {
  draggedCardId = event.currentTarget.dataset.cardId;
  event.currentTarget.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggedCardId);
}

function handleDragEnd(event) {
  event.currentTarget.classList.remove('dragging');
  draggedCardId = null;
}

function handleDragOver(event) {
  event.preventDefault();
  const list = event.currentTarget;
  const afterElement = getDropTarget(list, event.clientY);
  const dragging = document.querySelector('.dragging');
  if (!dragging) return;
  if (afterElement == null) list.appendChild(dragging);
  else list.insertBefore(dragging, afterElement);
}

async function handleDrop(event) {
  event.preventDefault();
  const cardId = event.dataTransfer.getData('text/plain') || draggedCardId;
  if (!cardId) return;

  const list = event.currentTarget;
  const targetColumnId = list.dataset.columnId;
  const orderedIds = [...list.querySelectorAll('.card')].map((el) => el.dataset.cardId);
  const index = orderedIds.indexOf(cardId);
  const afterId = index > 0 ? orderedIds[index - 1] : null;
  const beforeId = index >= 0 && index < orderedIds.length - 1 ? orderedIds[index + 1] : null;

  optimisticMove(cardId, targetColumnId, beforeId, afterId);

  try {
    const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId: targetColumnId, beforeId, afterId }),
    });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    if (payload.normalizedColumn) replaceColumn(payload.normalizedColumn);
    upsertCanonicalCard(payload.card);
    render();
  } catch (error) {
    console.error('Move failed; reloading board', error);
    await loadBoard();
  }
}

function optimisticMove(cardId, columnId, beforeId, afterId) {
  const found = findCard(cardId);
  if (!found) return;
  const card = { ...found.card, columnId };
  removeCard(cardId);
  const target = getColumn(columnId);
  if (!target) return;

  let insertIndex = target.cards.length;
  if (beforeId) {
    const beforeIndex = target.cards.findIndex((candidate) => candidate.id === beforeId);
    if (beforeIndex !== -1) insertIndex = beforeIndex;
  } else if (afterId) {
    const afterIndex = target.cards.findIndex((candidate) => candidate.id === afterId);
    if (afterIndex !== -1) insertIndex = afterIndex + 1;
  }

  const previous = insertIndex > 0 ? target.cards[insertIndex - 1]?.position : null;
  const next = insertIndex < target.cards.length ? target.cards[insertIndex]?.position : null;
  card.position = previous != null && next != null ? (previous + next) / 2 : previous != null ? previous + 1000 : next != null ? next - 1000 : 1000;
  target.cards.splice(insertIndex, 0, card);
  render();
}

async function createCard(event, columnId) {
  event.preventDefault();
  const form = event.currentTarget;
  const input = form.elements.text;
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  try {
    const response = await fetch(`${API_BASE}/api/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text }),
    });
    if (!response.ok) throw new Error(await response.text());
    const { card } = await response.json();
    upsertCanonicalCard(card);
    render();
  } catch (error) {
    console.error('Create failed', error);
    input.value = text;
    alert('Could not create the card. Please try again.');
  }
}

function replaceColumn(column) {
  const index = board.columns.findIndex((candidate) => candidate.id === column.id);
  if (index !== -1) board.columns[index] = column;
}

function connectStream() {
  const stream = new EventSource(`${API_BASE}/api/stream`);
  stream.onopen = () => {
    statusEl.textContent = 'Live';
    statusEl.className = 'status live';
  };
  stream.onerror = () => {
    statusEl.textContent = 'Reconnecting…';
    statusEl.className = 'status reconnecting';
  };

  const handleCardEvent = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.normalizedColumn) replaceColumn(payload.normalizedColumn);
    upsertCanonicalCard(payload.card);
    render();
  };

  stream.addEventListener('card:create', handleCardEvent);
  stream.addEventListener('card:move', handleCardEvent);
}

async function loadBoard() {
  const response = await fetch(`${API_BASE}/api/board`);
  if (!response.ok) throw new Error('Could not load board');
  board = await response.json();
  render();
}

loadBoard()
  .then(connectStream)
  .catch((error) => {
    console.error(error);
    boardEl.innerHTML = '<p class="error">Could not load the board. Is the server running?</p>';
  });
