const API_BASE = '/api';
let boardState = { columns: [] };
let draggedCard = null;
let draggedCardId = null;
let optimisticMoves = new Map(); // cardId -> {columnId, position}

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
      <button class="add-card-btn" data-column-id="${column.id}">+ Add</button>
    </div>
    <div class="cards" data-column-id="${column.id}"></div>
  `;

  const cardsContainer = colEl.querySelector('.cards');
  const addBtn = colEl.querySelector('.add-card-btn');

  // Add card handler
  addBtn.addEventListener('click', () => {
    const text = prompt('Card text:');
    if (text) {
      createCard(column.id, text);
    }
  });

  // Render cards
  if (column.cards) {
    column.cards.forEach(card => {
      const cardEl = createCardElement(card, column.id);
      cardsContainer.appendChild(cardEl);
    });
  }

  // Drag and drop handlers for column
  setupColumnDragDrop(colEl, cardsContainer, column.id);

  return colEl;
}

function createCardElement(card, columnId) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.draggable = true;
  cardEl.dataset.cardId = card.id;
  cardEl.dataset.columnId = columnId;
  cardEl.textContent = card.text;

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
    // Clear drag-over styles
    document.querySelectorAll('.column').forEach(c => c.classList.remove('drag-over'));
  });

  return cardEl;
}

function setupColumnDragDrop(colEl, cardsContainer, columnId) {
  cardsContainer.addEventListener('dragover', (e) => {
    e.preventDefault();
    colEl.classList.add('drag-over');
  });

  cardsContainer.addEventListener('dragleave', () => {
    colEl.classList.remove('drag-over');
  });

  cardsContainer.addEventListener('drop', async (e) => {
    e.preventDefault();
    colEl.classList.remove('drag-over');

    if (!draggedCardId) return;

    const cardEls = Array.from(cardsContainer.querySelectorAll('.card'));
    const dropY = e.clientY;

    // Find insertion point
    let beforeId = null;
    let afterId = null;

    for (let i = 0; i < cardEls.length; i++) {
      const rect = cardEls[i].getBoundingClientRect();
      if (dropY < rect.top + rect.height / 2) {
        beforeId = cardEls[i].dataset.cardId;
        afterId = i > 0 ? cardEls[i - 1].dataset.cardId : null;
        break;
      }
      afterId = cardEls[i].dataset.cardId;
    }

    // Optimistic update
    optimisticMoveCard(draggedCardId, columnId, beforeId, afterId);

    // Send to server
    try {
      const res = await fetch(`${API_BASE}/cards/${draggedCardId}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId, beforeId, afterId })
      });
      if (!res.ok) {
        // Revert on error? For simplicity, refetch
        await fetchBoard();
      }
    } catch (err) {
      console.error(err);
      await fetchBoard();
    }
  });
}

async function createCard(columnId, text) {
  try {
    const res = await fetch(`${API_BASE}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text })
    });
    if (res.ok) {
      // Optimistic? But SSE will handle, or refetch
      // For now, rely on SSE
    }
  } catch (err) {
    console.error(err);
  }
}

function optimisticMoveCard(cardId, newColumnId, beforeId, afterId) {
  // Find current card in state
  let foundCard = null;
  let oldColumnId = null;

  for (const col of boardState.columns) {
    const idx = col.cards.findIndex(c => c.id === cardId);
    if (idx !== -1) {
      foundCard = col.cards.splice(idx, 1)[0];
      oldColumnId = col.id;
      break;
    }
  }

  if (!foundCard) return;

  // Find target column
  const targetCol = boardState.columns.find(c => c.id === newColumnId);
  if (!targetCol) return;

  // Insert at position
  let insertIndex = targetCol.cards.length;
  if (beforeId) {
    insertIndex = targetCol.cards.findIndex(c => c.id === beforeId);
    if (insertIndex === -1) insertIndex = targetCol.cards.length;
  } else if (afterId) {
    const afterIdx = targetCol.cards.findIndex(c => c.id === afterId);
    insertIndex = afterIdx !== -1 ? afterIdx + 1 : targetCol.cards.length;
  }

  targetCol.cards.splice(insertIndex, 0, foundCard);

  // Re-render
  renderBoard();
}

function setupSSE() {
  const eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.addEventListener('connected', () => {
    console.log('SSE connected');
  });

  eventSource.addEventListener('card-created', (e) => {
    const data = JSON.parse(e.data);
    handleCardCreated(data);
  });

  eventSource.addEventListener('card-moved', (e) => {
    const data = JSON.parse(e.data);
    handleCardMoved(data);
  });

  eventSource.onerror = (err) => {
    console.error('SSE error', err);
  };
}

function handleCardCreated(data) {
  const { card, columnId } = data;
  
  // Find column and add if not present
  const column = boardState.columns.find(c => c.id === columnId);
  if (column) {
    // Avoid duplicate
    if (!column.cards.find(c => c.id === card.id)) {
      column.cards.push(card);
      // Sort by position
      column.cards.sort((a, b) => a.position - b.position);
      renderBoard();
    }
  } else {
    // Refetch if needed
    fetchBoard();
  }
}

function handleCardMoved(data) {
  const { card, columnId } = data;
  
  // Remove card from all columns
  boardState.columns.forEach(col => {
    col.cards = col.cards.filter(c => c.id !== card.id);
  });

  // Add to correct column
  const targetCol = boardState.columns.find(c => c.id === columnId);
  if (targetCol) {
    targetCol.cards.push(card);
    targetCol.cards.sort((a, b) => a.position - b.position);
  }

  renderBoard();
}

async function init() {
  await fetchBoard();
  setupSSE();
}

init();