const API_BASE = '';
const boardEl = document.getElementById('board');
const statusEl = document.getElementById('connectionStatus');
const columnTemplate = document.getElementById('columnTemplate');
const cardTemplate = document.getElementById('cardTemplate');

let state = { columns: [] };
let draggedCardId = null;
let dragOriginSnapshot = null;
const pendingMoves = new Set();

function setStatus(text, className) {
  statusEl.textContent = text;
  statusEl.className = `status ${className}`;
}

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error || response.statusText);
  }
  return response.json();
}

function cloneBoard(board) {
  return { columns: board.columns.map((column) => ({ ...column, cards: column.cards.map((card) => ({ ...card })) })) };
}

function findCard(cardId) {
  for (const column of state.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index !== -1) return { column, index, card: column.cards[index] };
  }
  return null;
}

function removeCardEverywhere(cardId) {
  let card = null;
  for (const column of state.columns) {
    const remaining = [];
    for (const candidate of column.cards) {
      if (candidate.id === cardId) card = candidate;
      else remaining.push(candidate);
    }
    column.cards = remaining;
  }
  return card;
}

function applyBoard(board) {
  state = cloneBoard(board);
  for (const column of state.columns) {
    const seen = new Set();
    column.cards = column.cards
      .filter((card) => {
        if (seen.has(card.id)) return false;
        seen.add(card.id);
        return true;
      })
      .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  render();
}

function render() {
  boardEl.replaceChildren();
  for (const column of state.columns) {
    const columnNode = columnTemplate.content.firstElementChild.cloneNode(true);
    columnNode.dataset.columnId = column.id;
    columnNode.querySelector('h2').textContent = column.title;
    columnNode.querySelector('.count').textContent = `${column.cards.length}`;

    const list = columnNode.querySelector('.card-list');
    list.dataset.columnId = column.id;
    list.addEventListener('dragover', handleDragOver);
    list.addEventListener('dragleave', () => list.classList.remove('drag-over'));
    list.addEventListener('drop', handleDrop);

    for (const card of column.cards) {
      const cardNode = cardTemplate.content.firstElementChild.cloneNode(true);
      cardNode.dataset.cardId = card.id;
      cardNode.textContent = card.text;
      cardNode.classList.toggle('pending', pendingMoves.has(card.id));
      cardNode.addEventListener('dragstart', handleDragStart);
      cardNode.addEventListener('dragend', handleDragEnd);
      list.appendChild(cardNode);
    }

    const form = columnNode.querySelector('.new-card-form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = form.elements.text;
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      try {
        const result = await request('/api/cards', { method: 'POST', body: JSON.stringify({ columnId: column.id, text }) });
        if (result.board) applyBoard(result.board);
      } catch (error) {
        input.value = text;
        alert(error.message);
      }
    });

    boardEl.appendChild(columnNode);
  }
}

function handleDragStart(event) {
  draggedCardId = event.currentTarget.dataset.cardId;
  dragOriginSnapshot = cloneBoard(state);
  event.currentTarget.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggedCardId);
}

function handleDragEnd(event) {
  event.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.card-list.drag-over').forEach((el) => el.classList.remove('drag-over'));
  draggedCardId = null;
  dragOriginSnapshot = null;
}

function getDropBeforeCard(list, clientY) {
  const cards = [...list.querySelectorAll('.card:not(.dragging)')];
  let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
  for (const card of cards) {
    const box = card.getBoundingClientRect();
    const offset = clientY - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, element: card };
  }
  return closest.element;
}

function handleDragOver(event) {
  event.preventDefault();
  const list = event.currentTarget;
  list.classList.add('drag-over');
  const dragging = document.querySelector('.card.dragging');
  if (!dragging) return;
  const before = getDropBeforeCard(list, event.clientY);
  if (before) list.insertBefore(dragging, before);
  else list.appendChild(dragging);
}

function optimisticMove(cardId, targetColumnId, beforeId, afterId) {
  const card = removeCardEverywhere(cardId);
  const targetColumn = state.columns.find((column) => column.id === targetColumnId);
  if (!card || !targetColumn) return;
  card.columnId = targetColumnId;
  let index = targetColumn.cards.length;
  if (afterId) {
    const afterIndex = targetColumn.cards.findIndex((candidate) => candidate.id === afterId);
    if (afterIndex !== -1) index = afterIndex + 1;
  } else if (beforeId) {
    const beforeIndex = targetColumn.cards.findIndex((candidate) => candidate.id === beforeId);
    if (beforeIndex !== -1) index = beforeIndex;
  }
  const previous = targetColumn.cards[index - 1]?.position;
  const next = targetColumn.cards[index]?.position;
  if (previous == null && next == null) card.position = 1024;
  else if (previous == null) card.position = Number(next) / 2;
  else if (next == null) card.position = Number(previous) + 1024;
  else card.position = (Number(previous) + Number(next)) / 2;
  targetColumn.cards.splice(index, 0, card);
}

async function handleDrop(event) {
  event.preventDefault();
  const list = event.currentTarget;
  list.classList.remove('drag-over');
  const cardId = draggedCardId || event.dataTransfer.getData('text/plain');
  if (!cardId) return;

  const orderedIds = [...list.querySelectorAll('.card')].map((card) => card.dataset.cardId);
  const index = orderedIds.indexOf(cardId);
  const beforeId = index >= 0 ? orderedIds[index + 1] || null : null;
  const afterId = index > 0 ? orderedIds[index - 1] : null;
  const columnId = list.dataset.columnId;

  pendingMoves.add(cardId);
  optimisticMove(cardId, columnId, beforeId, afterId);
  render();

  try {
    const result = await request(`/api/cards/${encodeURIComponent(cardId)}/move`, {
      method: 'PATCH',
      body: JSON.stringify({ columnId, beforeId, afterId })
    });
    pendingMoves.delete(cardId);
    if (result.board) applyBoard(result.board);
    else render();
  } catch (error) {
    pendingMoves.delete(cardId);
    if (dragOriginSnapshot) applyBoard(dragOriginSnapshot);
    else loadBoard();
    alert(error.message);
  }
}

function handleRealtime(payload) {
  if (!payload) return;
  if (payload.card?.id) pendingMoves.delete(payload.card.id);
  if (payload.board) applyBoard(payload.board);
}

async function loadBoard() {
  const board = await request('/api/board');
  applyBoard(board);
}

function connectStream() {
  const source = new EventSource('/api/stream');
  source.addEventListener('open', () => setStatus('Live', 'status-open'));
  source.addEventListener('error', () => setStatus('Reconnecting…', 'status-error'));
  for (const eventName of ['board', 'card_created', 'card_moved', 'message']) {
    source.addEventListener(eventName, (event) => {
      try { handleRealtime(JSON.parse(event.data)); } catch (error) { console.warn('Bad SSE payload', error); }
    });
  }
}

loadBoard().catch((error) => {
  boardEl.textContent = `Failed to load board: ${error.message}`;
});
connectStream();
