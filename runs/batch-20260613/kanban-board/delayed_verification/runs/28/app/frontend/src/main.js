const API_BASE = 'http://localhost:3000/api';
const SSE_URL = 'http://localhost:3000/api/stream';

let boardState = { columns: [] };
let eventSource = null;
let optimisticCards = new Map(); // cardId -> optimistic position info

// Generate simple unique ID
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Fetch initial board state
async function fetchBoard() {
  const res = await fetch(`${API_BASE}/board`);
  if (!res.ok) throw new Error('Failed to fetch board');
  boardState = await res.json();
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

  const header = document.createElement('div');
  header.className = 'column-header';
  header.textContent = column.title;
  colEl.appendChild(header);

  const cardsContainer = document.createElement('div');
  cardsContainer.className = 'cards';
  cardsContainer.dataset.columnId = column.id;

  // Sort cards by position
  const sortedCards = [...(column.cards || [])].sort((a, b) => a.position - b.position);

  sortedCards.forEach(card => {
    const cardEl = createCardElement(card);
    cardsContainer.appendChild(cardEl);
  });

  setupDropZone(cardsContainer, column.id);
  colEl.appendChild(cardsContainer);

  // Add card button
  const addBtn = document.createElement('div');
  addBtn.className = 'add-card';
  addBtn.textContent = '+ Add card';
  addBtn.onclick = () => showAddCardInput(cardsContainer, column.id);
  colEl.appendChild(addBtn);

  return colEl;
}

// Create a card element
function createCardElement(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.draggable = true;
  cardEl.dataset.cardId = card.id;
  cardEl.dataset.columnId = card.column_id;
  cardEl.textContent = card.text;

  cardEl.addEventListener('dragstart', handleDragStart);
  cardEl.addEventListener('dragend', handleDragEnd);

  return cardEl;
}

// Setup drop zone for a cards container
function setupDropZone(container, columnId) {
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    // Remove existing indicators
    container.querySelectorAll('.drop-indicator').forEach(el => el.remove());

    const afterElement = getDragAfterElement(container, e.clientY);
    const indicator = document.createElement('div');
    indicator.className = 'drop-indicator';

    if (afterElement) {
      container.insertBefore(indicator, afterElement);
    } else {
      container.appendChild(indicator);
    }
  });

  container.addEventListener('dragleave', () => {
    container.querySelectorAll('.drop-indicator').forEach(el => el.remove());
  });

  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    container.querySelectorAll('.drop-indicator').forEach(el => el.remove());

    const cardId = e.dataTransfer.getData('text/plain');

    const afterElement = getDragAfterElement(container, e.clientY);
    // afterElement is the element that will come AFTER the dropped card
    const beforeId = afterElement ? afterElement.dataset.cardId : null;
    // Find the card that will come BEFORE the dropped card
    let afterId = null;
    if (afterElement) {
      const prev = afterElement.previousElementSibling;
      if (prev && prev.classList.contains('card')) {
        afterId = prev.dataset.cardId;
      }
    } else {
      // Dropping at the end: find last card
      const cards = container.querySelectorAll('.card:not(.dragging)');
      if (cards.length > 0) {
        afterId = cards[cards.length - 1].dataset.cardId;
      }
    }

    // Optimistic update
    optimisticMoveCard(cardId, columnId, beforeId, afterId);

    // Send to server
    try {
      await fetch(`${API_BASE}/cards/${cardId}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          columnId,
          beforeId,
          afterId
        })
      });
    } catch (err) {
      console.error('Move failed:', err);
      // Re-fetch to reconcile
      await fetchBoard();
    }
  });
}

function getDragAfterElement(container, y) {
  const cards = [...container.querySelectorAll('.card:not(.dragging)')];
  return cards.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      return { offset, element: child };
    } else {
      return closest;
    }
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}



// Handle drag start
function handleDragStart(e) {
  e.dataTransfer.setData('text/plain', e.target.dataset.cardId);
  e.dataTransfer.setData('source-column', e.target.dataset.columnId);
  e.target.classList.add('dragging');
}

// Handle drag end
function handleDragEnd(e) {
  e.target.classList.remove('dragging');
  // Clean up any remaining indicators
  document.querySelectorAll('.drop-indicator').forEach(el => el.remove());
}

// Optimistic move
function optimisticMoveCard(cardId, newColumnId, beforeId, afterId) {
  // Find and remove from current position in DOM and state
  const cardEl = document.querySelector(`[data-card-id="${cardId}"]`);
  if (cardEl) {
    const oldColumn = cardEl.parentElement;
    cardEl.remove();

    // Update local state optimistically
    removeCardFromState(cardId);
  }

  // Insert into new position
  insertCardOptimistically(cardId, newColumnId, beforeId, afterId);
}

function removeCardFromState(cardId) {
  boardState.columns.forEach(col => {
    if (col.cards) {
      col.cards = col.cards.filter(c => c.id !== cardId);
    }
  });
}

function insertCardOptimistically(cardId, columnId, beforeId, afterId) {
  // Find the column
  const column = boardState.columns.find(c => c.id === columnId);
  if (!column) return;

  if (!column.cards) column.cards = [];

  // Create a temp card (we'll get real data from server later)
  const tempCard = {
    id: cardId,
    column_id: columnId,
    text: document.querySelector(`[data-card-id="${cardId}"]`)?.textContent || 'Card',
    position: computeOptimisticPosition(column.cards, beforeId, afterId)
  };

  // Insert at correct spot
  let insertIndex = column.cards.length;
  if (beforeId) {
    const beforeIdx = column.cards.findIndex(c => c.id === beforeId);
    if (beforeIdx !== -1) insertIndex = beforeIdx;
  } else if (afterId) {
    const afterIdx = column.cards.findIndex(c => c.id === afterId);
    if (afterIdx !== -1) insertIndex = afterIdx + 1;
  }

  column.cards.splice(insertIndex, 0, tempCard);

  // Re-render just this column for simplicity? Or update DOM
  // For now, since optimistic, better to manipulate DOM directly
  updateColumnDOM(columnId);
}

function computeOptimisticPosition(cards, beforeId, afterId) {
  // Simple optimistic position
  if (!beforeId && !afterId) return (cards.length > 0 ? Math.max(...cards.map(c => c.position)) + 1 : 1000);
  const beforePos = beforeId ? cards.find(c => c.id === beforeId)?.position : null;
  const afterPos = afterId ? cards.find(c => c.id === afterId)?.position : null;
  if (beforePos && afterPos) return (beforePos + afterPos) / 2;
  if (beforePos) return beforePos - 0.5;
  if (afterPos) return afterPos + 0.5;
  return 1000;
}

function updateColumnDOM(columnId) {
  const container = document.querySelector(`.cards[data-column-id="${columnId}"]`);
  if (!container) return;

  const column = boardState.columns.find(c => c.id === columnId);
  if (!column) return;

  container.innerHTML = '';
  const sorted = [...(column.cards || [])].sort((a, b) => a.position - b.position);
  sorted.forEach(card => {
    const cardEl = createCardElement(card);
    container.appendChild(cardEl);
  });
}

// Show add card input
function showAddCardInput(container, columnId) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'new-card-input';
  input.placeholder = 'Card text...';
  input.onkeydown = async (e) => {
    if (e.key === 'Enter' && input.value.trim()) {
      await createCard(columnId, input.value.trim());
      input.remove();
    } else if (e.key === 'Escape') {
      input.remove();
    }
  };
  container.appendChild(input);
  input.focus();
}

// Create new card
async function createCard(columnId, text) {
  const res = await fetch(`${API_BASE}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text })
  });
  if (res.ok) {
    const card = await res.json();
    // Server will broadcast via SSE, but add optimistically too
    addCardToDOM(card);
  }
}

function addCardToDOM(card) {
  const container = document.querySelector(`.cards[data-column-id="${card.column_id}"]`);
  if (container) {
    const cardEl = createCardElement(card);
    container.appendChild(cardEl);
  }
  // Update state
  const col = boardState.columns.find(c => c.id === card.column_id);
  if (col) {
    if (!col.cards) col.cards = [];
    col.cards.push(card);
  }
}

// Setup SSE connection
function setupSSE() {
  if (eventSource) eventSource.close();

  eventSource = new EventSource(SSE_URL);

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleServerEvent(data);
    } catch (e) {
      console.error('SSE parse error', e);
    }
  };

  eventSource.onerror = (err) => {
    console.error('SSE error', err);
    // Attempt reconnect after delay
    setTimeout(setupSSE, 3000);
  };
}

function handleServerEvent(data) {
  if (data.type === 'card-created') {
    // Remove optimistic if any, add canonical
    removeOptimisticCard(data.card.id);
    addOrUpdateCardFromServer(data.card);
  } else if (data.type === 'card-moved' || data.type === 'card-updated') {
    removeOptimisticCard(data.card.id);
    addOrUpdateCardFromServer(data.card);
  } else if (data.type === 'column-renormalized') {
    // Handle full column update
    updateColumnFromServer(data.columnId, data.cards);
  }
}

function removeOptimisticCard(cardId) {
  // Remove from optimistic tracking and any temp
  optimisticCards.delete(cardId);
}

function addOrUpdateCardFromServer(card) {
  // Remove card from wherever it is currently in DOM/state
  const existingEls = document.querySelectorAll(`[data-card-id="${card.id}"]`);
  existingEls.forEach(el => el.remove());

  removeCardFromState(card.id);

  // Add to correct column
  const column = boardState.columns.find(c => c.id === card.column_id);
  if (column) {
    if (!column.cards) column.cards = [];
    column.cards.push(card);
    updateColumnDOM(card.column_id);
  }
}

function updateColumnFromServer(columnId, cards) {
  const column = boardState.columns.find(c => c.id === columnId);
  if (column) {
    column.cards = cards;
    updateColumnDOM(columnId);
  }
}

// Initialize the app
async function init() {
  await fetchBoard();
  setupSSE();

  // Optional: seed a card for demo if empty, but server seeds columns
  console.log('Kanban board initialized');
}

init();