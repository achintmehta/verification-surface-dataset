const API_BASE = '/api';
let boardState = { columns: [] };
let eventSource = null;
let optimisticCards = new Map(); // cardId -> optimistic data for reconciliation

// Fetch initial board state
async function fetchBoard() {
  const res = await fetch(`${API_BASE}/board`);
  const data = await res.json();
  boardState = data;
  renderBoard();
}

// Render the entire board
function renderBoard() {
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';

  boardState.columns.forEach(column => {
    const colEl = createColumnElement(column);
    boardEl.appendChild(colEl);
  });
}

// Create a column element
function createColumnElement(column) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = column.id;

  colEl.innerHTML = `
    <div class="column-header">
      <span class="column-title">${column.title}</span>
    </div>
    <div class="cards" data-column-id="${column.id}"></div>
  `;

  const cardsContainer = colEl.querySelector('.cards');
  column.cards.forEach(card => {
    const cardEl = createCardElement(card, column.id);
    cardsContainer.appendChild(cardEl);
  });

  setupDropZone(cardsContainer, column.id);
  return colEl;
}

// Create a card element
function createCardElement(card, columnId) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.draggable = true;
  cardEl.dataset.cardId = card.id;
  cardEl.dataset.columnId = columnId;
  cardEl.textContent = card.text;

  cardEl.addEventListener('dragstart', handleDragStart);
  cardEl.addEventListener('dragend', handleDragEnd);

  return cardEl;
}

// Setup drop zone for a column's cards container
function setupDropZone(container, columnId) {
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    container.parentElement.classList.add('drag-over');
  });

  container.addEventListener('dragleave', () => {
    container.parentElement.classList.remove('drag-over');
  });

  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    container.parentElement.classList.remove('drag-over');

    const cardId = e.dataTransfer.getData('text/plain');
    const sourceColumnId = e.dataTransfer.getData('source-column');

    if (!cardId) return;

    // Find drop position
    const afterElement = getDragAfterElement(container, e.clientY);
    const beforeId = afterElement ? afterElement.dataset.cardId : null;
    const afterId = getAfterId(container, afterElement);

    // Optimistic update
    performOptimisticMove(cardId, columnId, beforeId, afterId);

    // Send to server
    try {
      await fetch(`${API_BASE}/cards/${cardId}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId, beforeId, afterId })
      });
    } catch (err) {
      console.error('Move failed, will reconcile on next SSE', err);
    }
  });
}

function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('.card:not(.dragging)')];

  return draggableElements.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      return { offset, element: child };
    } else {
      return closest;
    }
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

function getAfterId(container, afterElement) {
  if (!afterElement) return null;
  const cards = [...container.querySelectorAll('.card')];
  const idx = cards.indexOf(afterElement);
  return idx > 0 ? cards[idx - 1].dataset.cardId : null;
}

// Drag handlers
let draggedCard = null;

function handleDragStart(e) {
  draggedCard = e.target;
  e.dataTransfer.setData('text/plain', e.target.dataset.cardId);
  e.dataTransfer.setData('source-column', e.target.dataset.columnId);
  e.target.classList.add('dragging');
}

function handleDragEnd(e) {
  e.target.classList.remove('dragging');
  draggedCard = null;
  // Clean up any drag-over states
  document.querySelectorAll('.column').forEach(col => col.classList.remove('drag-over'));
}

// Optimistic move in DOM
function performOptimisticMove(cardId, newColumnId, beforeId, afterId) {
  const cardEl = document.querySelector(`[data-card-id="${cardId}"]`);
  if (!cardEl) return;

  const newContainer = document.querySelector(`.cards[data-column-id="${newColumnId}"]`);
  if (!newContainer) return;

  // Remove from current position
  cardEl.parentElement.removeChild(cardEl);

  // Insert at new position
  if (beforeId) {
    const beforeEl = newContainer.querySelector(`[data-card-id="${beforeId}"]`);
    if (beforeEl) {
      newContainer.insertBefore(cardEl, beforeEl);
    } else {
      newContainer.appendChild(cardEl);
    }
  } else if (afterId) {
    const afterEl = newContainer.querySelector(`[data-card-id="${afterId}"]`);
    if (afterEl && afterEl.nextSibling) {
      newContainer.insertBefore(cardEl, afterEl.nextSibling);
    } else {
      newContainer.appendChild(cardEl);
    }
  } else {
    newContainer.appendChild(cardEl);
  }

  // Update dataset
  cardEl.dataset.columnId = newColumnId;

  // Store optimistic state
  optimisticCards.set(cardId, { columnId: newColumnId, beforeId, afterId });
}

// Reconcile with server state
function reconcileState(serverCard, serverColumnId) {
  const cardId = serverCard.id;
  const optimistic = optimisticCards.get(cardId);

  // Remove from wherever it is currently in DOM
  const existingCard = document.querySelector(`[data-card-id="${cardId}"]`);
  if (existingCard) {
    existingCard.parentElement.removeChild(existingCard);
  }

  // Find correct container
  const targetContainer = document.querySelector(`.cards[data-column-id="${serverColumnId}"]`);
  if (!targetContainer) return;

  // Create fresh card element with server data
  const newCardEl = createCardElement(serverCard, serverColumnId);

  // Insert based on server position (we'll re-render the column for accuracy if needed)
  // For simplicity, append and rely on full re-render for complex cases, but try insert
  if (optimistic && optimistic.beforeId) {
    const beforeEl = targetContainer.querySelector(`[data-card-id="${optimistic.beforeId}"]`);
    if (beforeEl) {
      targetContainer.insertBefore(newCardEl, beforeEl);
    } else {
      targetContainer.appendChild(newCardEl);
    }
  } else {
    targetContainer.appendChild(newCardEl);
  }

  optimisticCards.delete(cardId);
}

// SSE connection
function connectSSE() {
  if (eventSource) eventSource.close();

  eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'card-created') {
      handleCardCreated(data.card, data.columnId);
    } else if (data.type === 'card-moved' || data.type === 'board-update') {
      handleCardMoved(data.card, data.columnId);
    } else if (data.type === 'column-renormalized') {
      // Full refresh for renormalization
      fetchBoard();
    }
  };

  eventSource.onerror = () => {
    console.log('SSE error, reconnecting...');
    setTimeout(connectSSE, 3000);
  };
}

function handleCardCreated(card, columnId) {
  const container = document.querySelector(`.cards[data-column-id="${columnId}"]`);
  if (container) {
    const cardEl = createCardElement(card, columnId);
    container.appendChild(cardEl);
  }
}

function handleCardMoved(card, columnId) {
  reconcileState(card, columnId);
}

// Add new card
async function addNewCard() {
  // For simplicity, add to first column ("To Do")
  const firstColumn = boardState.columns[0];
  if (!firstColumn) return;

  const text = prompt('Card text:', 'New task');
  if (!text) return;

  const res = await fetch(`${API_BASE}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId: firstColumn.id, text })
  });

  if (res.ok) {
    const newCard = await res.json();
    // Optimistic already handled by SSE, but add locally if needed
  }
}

// Initialize everything
async function init() {
  await fetchBoard();
  connectSSE();

  document.getElementById('add-card-btn').addEventListener('click', addNewCard);

  // Keyboard support etc. optional
  console.log('Kanban board initialized');
}

init();