const API_BASE = '/api';
let boardState = { columns: [] };
let eventSource = null;
let draggedCard = null;
let draggedFromColumn = null;

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
      <span class="title">${column.title}</span>
      <button class="add-card" title="Add card">+</button>
    </div>
    <div class="cards"></div>
  `;

  const cardsContainer = colEl.querySelector('.cards');
  const addBtn = colEl.querySelector('.add-card');

  // Add card handler
  addBtn.addEventListener('click', () => {
    const text = prompt('Card text:');
    if (text) {
      createCard(column.id, text);
    }
  });

  // Render cards
  column.cards.forEach(card => {
    const cardEl = createCardElement(card, column.id);
    cardsContainer.appendChild(cardEl);
  });

  // Drag and drop for column
  setupColumnDragDrop(colEl, cardsContainer, column.id);

  return colEl;
}

function createCardElement(card, columnId) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.dataset.cardId = card.id;
  cardEl.draggable = true;
  cardEl.textContent = card.text;

  // Drag events
  cardEl.addEventListener('dragstart', (e) => {
    draggedCard = card;
    draggedFromColumn = columnId;
    cardEl.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('dragging');
    draggedCard = null;
    draggedFromColumn = null;
    // Remove any over states
    document.querySelectorAll('.card.over, .column.drag-over').forEach(el => {
      el.classList.remove('over', 'drag-over');
    });
  });

  cardEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    cardEl.classList.add('over');
  });

  cardEl.addEventListener('dragleave', () => {
    cardEl.classList.remove('over');
  });

  cardEl.addEventListener('drop', (e) => {
    e.preventDefault();
    cardEl.classList.remove('over');
    if (draggedCard && draggedCard.id !== card.id) {
      handleDrop(columnId, card.id, 'before');
    }
  });

  return cardEl;
}

function setupColumnDragDrop(colEl, cardsContainer, columnId) {
  colEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    colEl.classList.add('drag-over');
  });

  colEl.addEventListener('dragleave', (e) => {
    if (!colEl.contains(e.relatedTarget)) {
      colEl.classList.remove('drag-over');
    }
  });

  colEl.addEventListener('drop', (e) => {
    e.preventDefault();
    colEl.classList.remove('drag-over');
    if (draggedCard) {
      // Drop at end of column if not on specific card
      handleDrop(columnId, null, 'end');
    }
  });

  // Also allow drop on cards container
  cardsContainer.addEventListener('drop', (e) => {
    e.preventDefault();
    if (draggedCard) {
      handleDrop(columnId, null, 'end');
    }
  });
}

async function createCard(columnId, text) {
  // Optimistic? For create, just send and let SSE handle, but for simplicity send and refresh or wait SSE
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

function handleDrop(targetColumnId, targetCardId, position) {
  if (!draggedCard) return;

  const sourceColumnId = draggedFromColumn;
  let beforeId = null;
  let afterId = null;

  if (position === 'end') {
    afterId = null;
    beforeId = null;
  } else if (position === 'before') {
    beforeId = targetCardId;
    // Find after: the one before target in current render? But for simplicity, server will handle
    afterId = null; // We'll let server compute based on before
  }

  // For better, we need to determine before/after properly.
  // Let's improve: find the card's siblings in DOM for accurate before/after.

  // Actually, to make it correct, let's query the current DOM order for the target column.
  const targetCol = document.querySelector(`.column[data-column-id="${targetColumnId}"]`);
  const cardsInTarget = Array.from(targetCol.querySelectorAll('.card'));

  if (targetCardId) {
    const targetIndex = cardsInTarget.findIndex(c => c.dataset.cardId === targetCardId);
    if (targetIndex > 0) {
      afterId = cardsInTarget[targetIndex - 1].dataset.cardId;
    }
    beforeId = targetCardId;
  } else {
    // end
    if (cardsInTarget.length > 0) {
      afterId = cardsInTarget[cardsInTarget.length - 1].dataset.cardId;
    }
  }

  // Optimistic update
  optimisticMove(draggedCard.id, targetColumnId, beforeId, afterId);

  // Send to server
  fetch(`${API_BASE}/cards/${draggedCard.id}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId: targetColumnId, beforeId, afterId })
  }).catch(err => {
    console.error('Move failed', err);
    // On error, refetch board
    fetchBoard();
  });

  draggedCard = null;
  draggedFromColumn = null;
}

function optimisticMove(cardId, newColumnId, beforeId, afterId) {
  // Find and move in local state and DOM
  const cardEl = document.querySelector(`.card[data-card-id="${cardId}"]`);
  if (!cardEl) return;

  const targetCol = document.querySelector(`.column[data-column-id="${newColumnId}"]`);
  if (!targetCol) return;

  const cardsContainer = targetCol.querySelector('.cards');

  // Remove from current parent
  cardEl.parentNode.removeChild(cardEl);

  // Insert at correct position
  if (beforeId) {
    const beforeEl = cardsContainer.querySelector(`.card[data-card-id="${beforeId}"]`);
    if (beforeEl) {
      cardsContainer.insertBefore(cardEl, beforeEl);
    } else {
      cardsContainer.appendChild(cardEl);
    }
  } else if (afterId) {
    const afterEl = cardsContainer.querySelector(`.card[data-card-id="${afterId}"]`);
    if (afterEl && afterEl.nextSibling) {
      cardsContainer.insertBefore(cardEl, afterEl.nextSibling);
    } else {
      cardsContainer.appendChild(cardEl);
    }
  } else {
    cardsContainer.appendChild(cardEl);
  }

  // Also update boardState if needed, but SSE will reconcile
}

function connectSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'card-created' || data.type === 'card-moved') {
      // Reconcile with server state - simplest is refetch board for correctness
      // But to be efficient, could merge, but for now refetch
      fetchBoard();
    } else if (data.type === 'board-renormalized') {
      fetchBoard();
    }
  };

  eventSource.onerror = () => {
    console.log('SSE error, will reconnect...');
    setTimeout(connectSSE, 3000);
  };
}

function init() {
  fetchBoard().then(() => {
    connectSSE();
  });
}

init();
