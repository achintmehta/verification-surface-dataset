const API_BASE = '/api';
const SSE_URL = '/events';

let boardState = { columns: [] };
let eventSource = null;

async function fetchBoard() {
  const res = await fetch(`${API_BASE}/board`);
  boardState = await res.json();
  renderBoard();
}

function renderBoard() {
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';

  boardState.columns.forEach(column => {
    const colEl = createColumnElement(column);
    boardEl.appendChild(colEl);
  });
}

function createColumnElement(column) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = column.id;

  colEl.innerHTML = `
    <div class="column-header">${column.title}</div>
    <div class="cards" data-column-id="${column.id}"></div>
    <button class="add-card" data-column-id="${column.id}">+ Add Card</button>
  `;

  const cardsContainer = colEl.querySelector('.cards');
  column.cards.forEach(card => {
    const cardEl = createCardElement(card);
    cardsContainer.appendChild(cardEl);
  });

  // Add card handler
  colEl.querySelector('.add-card').addEventListener('click', () => {
    const text = prompt('Card text:');
    if (text) {
      createCard(column.id, text);
    }
  });

  // Drag and drop for column
  setupColumnDragDrop(cardsContainer);

  return colEl;
}

function createCardElement(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.dataset.cardId = card.id;
  cardEl.draggable = true;
  cardEl.textContent = card.text;

  cardEl.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', card.id);
    cardEl.classList.add('dragging');
  });

  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('dragging');
  });

  return cardEl;
}

function setupColumnDragDrop(container) {
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
    const targetColumnId = container.dataset.columnId;

    // Find position: insert at end for simplicity, or calculate based on drop position
    const cards = Array.from(container.children);
    let beforeId = null;
    let afterId = null;

    // Simple: append to end
    if (cards.length > 0) {
      afterId = cards[cards.length - 1].dataset.cardId;
    }

    // Optimistic update
    optimisticMoveCard(cardId, targetColumnId, afterId, beforeId);

    // Send to server
    try {
      await moveCard(cardId, targetColumnId, beforeId, afterId);
    } catch (err) {
      console.error('Move failed, will reconcile on SSE', err);
      // Re-fetch on error
      fetchBoard();
    }
  });
}

function optimisticMoveCard(cardId, newColumnId, afterId, beforeId) {
  // Remove from current position
  let foundCard = null;
  boardState.columns.forEach(col => {
    const idx = col.cards.findIndex(c => c.id === cardId);
    if (idx !== -1) {
      foundCard = col.cards.splice(idx, 1)[0];
    }
  });

  if (!foundCard) return;

  // Find target column
  const targetCol = boardState.columns.find(c => c.id === newColumnId);
  if (!targetCol) return;

  // Insert based on after/before (simplified: append if no after)
  if (afterId) {
    const afterIdx = targetCol.cards.findIndex(c => c.id === afterId);
    if (afterIdx !== -1) {
      targetCol.cards.splice(afterIdx + 1, 0, foundCard);
    } else {
      targetCol.cards.push(foundCard);
    }
  } else {
    targetCol.cards.push(foundCard);
  }

  // Update column_id
  foundCard.column_id = newColumnId;

  renderBoard();
}

async function createCard(columnId, text) {
  const res = await fetch(`${API_BASE}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text })
  });
  if (!res.ok) {
    alert('Failed to create card');
  }
  // SSE will update
}

async function moveCard(cardId, columnId, beforeId, afterId) {
  const res = await fetch(`${API_BASE}/cards/${cardId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, beforeId, afterId })
  });
  if (!res.ok) {
    throw new Error('Move failed');
  }
  return res.json();
}

function connectSSE() {
  if (eventSource) eventSource.close();

  eventSource = new EventSource(SSE_URL);

  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleServerUpdate(data);
  };

  eventSource.onerror = (err) => {
    console.error('SSE error', err);
    // Reconnect logic could be added
  };
}

function handleServerUpdate(data) {
  if (data.type === 'card-created' || data.type === 'card-moved') {
    // Reconcile with server state: better to refetch or merge
    // For simplicity and correctness, refetch board
    fetchBoard();
  } else if (data.type === 'board-renormalized') {
    fetchBoard();
  }
}

async function init() {
  await fetchBoard();
  connectSSE();
}

init();