const API_BASE = '';
let boardState = { columns: [] };
let draggedCard = null;
let draggedCardId = null;

// Fetch initial board
async function fetchBoard() {
  const res = await fetch(`${API_BASE}/api/board`);
  boardState = await res.json();
  renderBoard();
}

// Render the entire board
function renderBoard() {
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';

  boardState.columns.forEach(column => {
    const columnEl = createColumnElement(column);
    boardEl.appendChild(columnEl);
  });
}

function createColumnElement(column) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = column.id;

  colEl.innerHTML = `
    <div class="column-header">${column.title}</div>
    <div class="cards" data-column-id="${column.id}"></div>
  `;

  const cardsContainer = colEl.querySelector('.cards');

  // Render cards
  column.cards.forEach(card => {
    const cardEl = createCardElement(card);
    cardsContainer.appendChild(cardEl);
  });

  // Setup drop zone
  setupDropZone(cardsContainer, column.id);

  return colEl;
}

function createCardElement(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.dataset.cardId = card.id;
  cardEl.draggable = true;
  cardEl.textContent = card.text;

  // Drag events
  cardEl.addEventListener('dragstart', (e) => {
    draggedCard = cardEl;
    draggedCardId = card.id;
    cardEl.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  cardEl.addEventListener('dragend', () => {
    if (draggedCard) {
      draggedCard.classList.remove('dragging');
    }
    draggedCard = null;
    draggedCardId = null;
    // Clean up any placeholders
    document.querySelectorAll('.card-placeholder').forEach(el => el.remove());
  });

  return cardEl;
}

function setupDropZone(container, columnId) {
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    container.classList.add('drag-over');

    // Show placeholder
    const afterElement = getDragAfterElement(container, e.clientY);
    const placeholder = document.querySelector('.card-placeholder') || createPlaceholder();

    if (afterElement == null) {
      container.appendChild(placeholder);
    } else {
      container.insertBefore(placeholder, afterElement);
    }
  });

  container.addEventListener('dragleave', () => {
    container.classList.remove('drag-over');
    const placeholder = document.querySelector('.card-placeholder');
    if (placeholder) placeholder.remove();
  });

  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    container.classList.remove('drag-over');

    const placeholder = document.querySelector('.card-placeholder');
    if (!draggedCardId || !placeholder) {
      if (placeholder) placeholder.remove();
      return;
    }

    const afterElement = placeholder.nextElementSibling;
    const beforeElement = placeholder.previousElementSibling;

    const beforeId = beforeElement && beforeElement.dataset.cardId ? beforeElement.dataset.cardId : null;
    const afterId = afterElement && afterElement.dataset.cardId ? afterElement.dataset.cardId : null;

    placeholder.remove();

    // Optimistic update
    performOptimisticMove(draggedCardId, columnId, beforeId, afterId);

    // Send to server
    try {
      await fetch(`${API_BASE}/api/cards/${draggedCardId}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId, beforeId, afterId })
      });
    } catch (err) {
      console.error('Move failed, will reconcile on next update', err);
    }
  });
}

function createPlaceholder() {
  const placeholder = document.createElement('div');
  placeholder.className = 'card-placeholder';
  return placeholder;
}

function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('.card:not(.dragging)')];

  return draggableElements.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;

    if (offset < 0 && offset > closest.offset) {
      return { offset: offset, element: child };
    } else {
      return closest;
    }
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// Optimistic move in DOM
function performOptimisticMove(cardId, newColumnId, beforeId, afterId) {
  // Find current position
  let currentColumn = null;
  let cardData = null;

  for (const col of boardState.columns) {
    const idx = col.cards.findIndex(c => c.id === cardId);
    if (idx !== -1) {
      currentColumn = col;
      cardData = col.cards.splice(idx, 1)[0];
      break;
    }
  }

  if (!cardData) return;

  // Find target column
  const targetColumn = boardState.columns.find(c => c.id === newColumnId);
  if (!targetColumn) return;

  // Update card's column
  cardData.column_id = newColumnId;

  // Insert at correct position
  let insertIndex = targetColumn.cards.length;
  if (beforeId) {
    const beforeIdx = targetColumn.cards.findIndex(c => c.id === beforeId);
    if (beforeIdx !== -1) insertIndex = beforeIdx;
  } else if (afterId) {
    const afterIdx = targetColumn.cards.findIndex(c => c.id === afterId);
    if (afterIdx !== -1) insertIndex = afterIdx + 1;
  }

  targetColumn.cards.splice(insertIndex, 0, cardData);

  // Re-render
  renderBoard();
}

// SSE connection
function connectSSE() {
  const eventSource = new EventSource(`${API_BASE}/api/stream`);

  eventSource.addEventListener('card-created', (e) => {
    const { card, columnId } = JSON.parse(e.data);
    applyServerCardCreated(card, columnId);
  });

  eventSource.addEventListener('card-moved', (e) => {
    const { card, fromColumnId, toColumnId } = JSON.parse(e.data);
    applyServerCardMoved(card, fromColumnId, toColumnId);
  });

  eventSource.addEventListener('board-update', (e) => {
    const board = JSON.parse(e.data);
    boardState = board;
    renderBoard();
  });

  eventSource.onerror = (err) => {
    console.error('SSE error', err);
    // Reconnect logic could be added
  };
}

function applyServerCardCreated(card, columnId) {
  const column = boardState.columns.find(c => c.id === columnId);
  if (!column) return;

  // Avoid duplicates
  if (column.cards.some(c => c.id === card.id)) return;

  column.cards.push(card);
  // Re-sort by position
  column.cards.sort((a, b) => a.position - b.position);
  renderBoard();
}

function applyServerCardMoved(card, fromColumnId, toColumnId) {
  // Remove from old column if present
  for (const col of boardState.columns) {
    const idx = col.cards.findIndex(c => c.id === card.id);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      break;
    }
  }

  // Add to new column
  const targetCol = boardState.columns.find(c => c.id === toColumnId);
  if (targetCol) {
    // Remove if already there (shouldn't be)
    targetCol.cards = targetCol.cards.filter(c => c.id !== card.id);
    targetCol.cards.push(card);
    targetCol.cards.sort((a, b) => a.position - b.position);
  }

  renderBoard();
}

// Add card handler
function setupAddCard() {
  const btn = document.getElementById('add-card-btn');
  const input = document.getElementById('new-card-text');
  const select = document.getElementById('new-card-column');

  btn.addEventListener('click', async () => {
    const text = input.value.trim();
    if (!text) return;

    const columnId = select.value;

    try {
      const res = await fetch(`${API_BASE}/api/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId, text })
      });
      if (res.ok) {
        input.value = '';
      }
    } catch (err) {
      console.error('Failed to add card', err);
    }
  });

  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') btn.click();
  });
}

// Initialize
async function init() {
  await fetchBoard();
  connectSSE();
  setupAddCard();
}

init();