import './styles.css';

const API_BASE = import.meta.env.VITE_API_URL || (location.port === '3001' ? '' : 'http://localhost:3001');
const boardEl = document.querySelector('#board');
const statusEl = document.querySelector('#connection-status');
const columnTemplate = document.querySelector('#column-template');
const cardTemplate = document.querySelector('#card-template');

let boardState = { columns: [] };
let draggingCardId = null;
let eventSource = null;
const pendingMoves = new Set();

const cardById = () => {
  const map = new Map();
  for (const column of boardState.columns) {
    for (const card of column.cards) map.set(card.id, card);
  }
  return map;
};

function setStatus(text, className) {
  statusEl.textContent = text;
  statusEl.className = `status ${className}`;
}

function escapeText(value) {
  return String(value ?? '');
}

function sortBoard(board) {
  return {
    columns: [...(board.columns ?? [])]
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
      .map((column) => ({
        ...column,
        cards: [...(column.cards ?? [])].sort(
          (a, b) => a.position - b.position || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id)
        )
      }))
  };
}

function replaceBoard(nextBoard) {
  boardState = sortBoard(nextBoard);
  renderBoard();
}

function renderBoard() {
  boardEl.textContent = '';
  for (const column of boardState.columns) {
    const columnEl = columnTemplate.content.firstElementChild.cloneNode(true);
    columnEl.dataset.columnId = column.id;
    columnEl.querySelector('h2').textContent = column.title;
    columnEl.querySelector('.count').textContent = column.cards.length;

    const form = columnEl.querySelector('.add-card-form');
    form.addEventListener('submit', (event) => handleCreateCard(event, column.id));

    const listEl = columnEl.querySelector('.card-list');
    listEl.dataset.columnId = column.id;
    listEl.addEventListener('dragover', handleDragOver);
    listEl.addEventListener('drop', handleDrop);
    listEl.addEventListener('dragleave', (event) => {
      if (!listEl.contains(event.relatedTarget)) listEl.classList.remove('drag-over');
    });

    for (const card of column.cards) {
      listEl.appendChild(renderCard(card));
    }
    boardEl.appendChild(columnEl);
  }
}

function renderCard(card) {
  const cardEl = cardTemplate.content.firstElementChild.cloneNode(true);
  cardEl.dataset.cardId = card.id;
  cardEl.querySelector('p').textContent = escapeText(card.text);
  if (pendingMoves.has(card.id)) cardEl.classList.add('pending');

  cardEl.addEventListener('dragstart', (event) => {
    draggingCardId = card.id;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', card.id);
    requestAnimationFrame(() => cardEl.classList.add('dragging'));
  });

  cardEl.addEventListener('dragend', () => {
    draggingCardId = null;
    document.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
    document.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
  });

  return cardEl;
}

function getDropAfterElement(container, y) {
  const cards = [...container.querySelectorAll('.card:not(.dragging)')];
  return cards.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      return { offset, element: child };
    }
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
}

function handleDragOver(event) {
  event.preventDefault();
  const listEl = event.currentTarget;
  listEl.classList.add('drag-over');

  const active = document.querySelector(`.card[data-card-id="${CSS.escape(draggingCardId ?? '')}"]`);
  if (!active) return;

  const beforeEl = getDropAfterElement(listEl, event.clientY);
  if (beforeEl) listEl.insertBefore(active, beforeEl);
  else listEl.appendChild(active);
}

async function handleDrop(event) {
  event.preventDefault();
  const listEl = event.currentTarget;
  listEl.classList.remove('drag-over');
  const cardId = event.dataTransfer.getData('text/plain') || draggingCardId;
  if (!cardId) return;

  const cardEl = listEl.querySelector(`.card[data-card-id="${CSS.escape(cardId)}"]`);
  if (!cardEl) return;

  const columnId = listEl.dataset.columnId;
  const previousEl = cardEl.previousElementSibling?.classList.contains('card') ? cardEl.previousElementSibling : null;
  const nextEl = cardEl.nextElementSibling?.classList.contains('card') ? cardEl.nextElementSibling : null;
  const afterId = previousEl?.dataset.cardId ?? null;
  const beforeId = nextEl?.dataset.cardId ?? null;

  applyOptimisticMove(cardId, columnId, beforeId, afterId);
  pendingMoves.add(cardId);
  renderBoard();

  try {
    const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId })
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Move failed');
  } catch (error) {
    console.error(error);
    await loadBoard();
  } finally {
    pendingMoves.delete(cardId);
    document.querySelector(`.card[data-card-id="${CSS.escape(cardId)}"]`)?.classList.remove('pending');
  }
}

function applyOptimisticMove(cardId, columnId, beforeId, afterId) {
  const cards = cardById();
  const movingCard = cards.get(cardId);
  if (!movingCard) return;

  const next = structuredClone(boardState);
  for (const column of next.columns) {
    column.cards = column.cards.filter((card) => card.id !== cardId);
  }

  const targetColumn = next.columns.find((column) => column.id === columnId);
  if (!targetColumn) return;

  let insertIndex = targetColumn.cards.length;
  if (beforeId) {
    const idx = targetColumn.cards.findIndex((card) => card.id === beforeId);
    if (idx !== -1) insertIndex = idx;
  } else if (afterId) {
    const idx = targetColumn.cards.findIndex((card) => card.id === afterId);
    if (idx !== -1) insertIndex = idx + 1;
  }

  const prev = insertIndex > 0 ? targetColumn.cards[insertIndex - 1] : null;
  const nextCard = insertIndex < targetColumn.cards.length ? targetColumn.cards[insertIndex] : null;
  const position = prev && nextCard ? (prev.position + nextCard.position) / 2 : prev ? prev.position + 1000 : nextCard ? nextCard.position - 1000 : 1000;
  targetColumn.cards.splice(insertIndex, 0, { ...movingCard, column_id: columnId, position });
  boardState = sortBoard(next);
}

async function handleCreateCard(event, columnId) {
  event.preventDefault();
  const form = event.currentTarget;
  const input = form.elements.text;
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  form.querySelector('button').disabled = true;
  try {
    const response = await fetch(`${API_BASE}/api/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text })
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Create failed');
  } catch (error) {
    console.error(error);
    input.value = text;
    alert(error.message);
  } finally {
    form.querySelector('button').disabled = false;
    input.focus();
  }
}

async function loadBoard() {
  const response = await fetch(`${API_BASE}/api/board`);
  if (!response.ok) throw new Error('Could not load board');
  replaceBoard(await response.json());
}

function connectStream() {
  if (eventSource) eventSource.close();
  setStatus('Connecting…', 'status-connecting');
  eventSource = new EventSource(`${API_BASE}/api/stream`);

  eventSource.onopen = () => setStatus('Live', 'status-connected');
  eventSource.onerror = () => setStatus('Reconnecting…', 'status-error');

  const reconcile = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.board) replaceBoard(payload.board);
      if (payload.card?.id) pendingMoves.delete(payload.card.id);
    } catch (error) {
      console.error('Invalid SSE payload', error);
    }
  };

  eventSource.addEventListener('sync', reconcile);
  eventSource.addEventListener('card:create', reconcile);
  eventSource.addEventListener('card:move', reconcile);
}

async function start() {
  try {
    await loadBoard();
    connectStream();
  } catch (error) {
    console.error(error);
    boardEl.innerHTML = `<div class="error-banner">Unable to load the board. Is the API server running on ${API_BASE || location.origin}?</div>`;
    setStatus('Offline', 'status-error');
  }
}

start();
