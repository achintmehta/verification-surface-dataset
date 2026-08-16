const API_BASE = '/api';
const EVENT_SOURCE = '/events';

let boardState = { columns: [] };
let eventSource = null;
let draggedCard = null;
let draggedCardId = null;
let optimisticMoves = new Map(); // cardId -> { columnId, position }

async function fetchBoard() {
  const res = await fetch(`${API_BASE}/board`);
  const data = await res.json();
  boardState = data;
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
    <div class="column-header">
      <span class="column-title">${column.title}</span>
      <button class="add-card-btn">+ Add</button>
    </div>
    <div class="cards" data-column-id="${column.id}"></div>
  `;

  const cardsContainer = colEl.querySelector('.cards');
  const addBtn = colEl.querySelector('.add-card-btn');

  // Add card functionality
  addBtn.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'new-card-input';
    input.placeholder = 'Card text...';
    cardsContainer.appendChild(input);
    input.focus();

    const submitCard = async () => {
      const text = input.value.trim();
      if (text) {
        await createCard(column.id, text);
      }
      input.remove();
    };

    input.addEventListener('blur', submitCard);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitCard();
      if (e.key === 'Escape') input.remove();
    });
  });

  // Setup drag and drop for the column
  setupDragAndDrop(cardsContainer, column.id);

  // Render cards
  column.cards.forEach(card => {
    const cardEl = createCardElement(card, column.id);
    cardsContainer.appendChild(cardEl);
  });

  return colEl;
}

function createCardElement(card, columnId) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.draggable = true;
  cardEl.dataset.cardId = card.id;
  cardEl.dataset.columnId = columnId;
  cardEl.innerHTML = `<div>${card.text}</div>`;

  // Drag events
  cardEl.addEventListener('dragstart', (e) => {
    draggedCard = cardEl;
    draggedCardId = card.id;
    cardEl.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('dragging');
    draggedCard = null;
    draggedCardId = null;
    // Clean up any placeholders
    document.querySelectorAll('.card-placeholder').forEach(p => p.remove());
  });

  return cardEl;
}

function setupDragAndDrop(container, columnId) {
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    if (!draggedCard) return;

    const afterElement = getDragAfterElement(container, e.clientY);
    const placeholder = document.createElement('div');
    placeholder.className = 'card-placeholder';

    // Remove existing placeholder
    const existing = container.querySelector('.card-placeholder');
    if (existing) existing.remove();

    if (afterElement) {
      container.insertBefore(placeholder, afterElement);
    } else {
      container.appendChild(placeholder);
    }
  });

  container.addEventListener('dragleave', (e) => {
    // Only remove if leaving the container
    if (!container.contains(e.relatedTarget)) {
      const placeholder = container.querySelector('.card-placeholder');
      if (placeholder) placeholder.remove();
    }
  });

  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    const placeholder = container.querySelector('.card-placeholder');
    if (placeholder) placeholder.remove();

    if (!draggedCardId || draggedCardId === null) return;

    const afterElement = getDragAfterElement(container, e.clientY);
    const beforeId = afterElement ? afterElement.dataset.cardId : null;
    const afterId = getAfterId(container, afterElement);

    // Optimistic update
    optimisticMoveCard(draggedCardId, columnId, beforeId, afterId);

    // Send to server
    try {
      await moveCard(draggedCardId, columnId, beforeId, afterId);
    } catch (err) {
      console.error('Move failed, will reconcile on next update', err);
      // Re-fetch to reconcile
      await fetchBoard();
    }
  });
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

function getAfterId(container, afterElement) {
  if (!afterElement) return null;
  // The element before the drop position
  const cards = [...container.querySelectorAll('.card')];
  const idx = cards.indexOf(afterElement);
  return idx > 0 ? cards[idx - 1].dataset.cardId : null;
}

function optimisticMoveCard(cardId, newColumnId, beforeId, afterId) {
  // Find current card and remove from old position
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

  // Insert at position
  let insertIndex = targetCol.cards.length;
  if (beforeId) {
    const beforeIdx = targetCol.cards.findIndex(c => c.id === beforeId);
    if (beforeIdx !== -1) insertIndex = beforeIdx;
  } else if (afterId) {
    const afterIdx = targetCol.cards.findIndex(c => c.id === afterId);
    if (afterIdx !== -1) insertIndex = afterIdx + 1;
  }

  targetCol.cards.splice(insertIndex, 0, foundCard);

  // Update DOM
  renderBoard();
}

async function createCard(columnId, text) {
  const res = await fetch(`${API_BASE}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text })
  });
  if (!res.ok) {
    console.error('Failed to create card');
  }
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

  eventSource = new EventSource(EVENT_SOURCE);

  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleServerUpdate(data);
  };

  eventSource.onerror = (err) => {
    console.error('SSE error', err);
    // Attempt reconnect
    setTimeout(connectSSE, 3000);
  };
}

function handleServerUpdate(data) {
  if (data.type === 'card-created' || data.type === 'card-moved') {
    const { card, columnId } = data;

    // Remove card from any existing position (to prevent duplicates)
    boardState.columns.forEach(col => {
      col.cards = col.cards.filter(c => c.id !== card.id);
    });

    // Find target column and insert at correct position or append
    const targetCol = boardState.columns.find(c => c.id === columnId);
    if (targetCol) {
      // If position provided, insert properly, else append
      if (card.position !== undefined) {
        // Simple append for now, or find position - but since server authoritative, better to re-sort or insert
        targetCol.cards.push(card);
        // Re-sort by position if needed
        targetCol.cards.sort((a, b) => a.position - b.position);
      } else {
        targetCol.cards.push(card);
      }
    }

    renderBoard();
  } else if (data.type === 'board-renormalized') {
    // Full board update
    if (data.board) {
      boardState = data.board;
      renderBoard();
    }
  }
}

async function init() {
  await fetchBoard();
  connectSSE();
}

init();