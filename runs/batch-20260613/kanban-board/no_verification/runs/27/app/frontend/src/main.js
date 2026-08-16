const API_BASE = '/api';
let boardState = [];
let eventSource = null;

// Fetch initial board
async function fetchBoard() {
  const res = await fetch(`${API_BASE}/board`);
  boardState = await res.json();
  renderBoard();
}

// Render the board
function renderBoard() {
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';

  // Populate column select for adding cards
  const select = document.getElementById('column-select');
  select.innerHTML = '';

  boardState.forEach(column => {
    // Column element
    const colEl = document.createElement('div');
    colEl.className = 'column';
    colEl.dataset.columnId = column.id;

    colEl.innerHTML = `
      <div class="column-header">${column.title}</div>
      <div class="cards" data-column-id="${column.id}"></div>
    `;

    const cardsContainer = colEl.querySelector('.cards');

    // Add cards
    column.cards.forEach(card => {
      const cardEl = createCardElement(card);
      cardsContainer.appendChild(cardEl);
    });

    // Setup drop zone
    setupDropZone(cardsContainer, column.id);

    boardEl.appendChild(colEl);

    // Add to select
    const opt = document.createElement('option');
    opt.value = column.id;
    opt.textContent = column.title;
    select.appendChild(opt);
  });
}

// Create card DOM element
function createCardElement(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.draggable = true;
  cardEl.dataset.cardId = card.id;
  cardEl.dataset.columnId = card.column_id;
  cardEl.textContent = card.text;

  // Drag events
  cardEl.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', card.id);
    cardEl.classList.add('dragging');
  });

  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('dragging');
  });

  return cardEl;
}

// Setup drop zone for a column's cards container
function setupDropZone(container, columnId) {
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    container.classList.add('over');
  });

  container.addEventListener('dragleave', () => {
    container.classList.remove('over');
  });

  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    container.classList.remove('over');

    const cardId = e.dataTransfer.getData('text/plain');
    const draggedCard = document.querySelector(`[data-card-id="${cardId}"]`);
    if (!draggedCard) return;

    // Optimistic update: move in DOM
    const targetColumnContainer = container;
    const oldParent = draggedCard.parentNode;
    const oldColumnId = draggedCard.dataset.columnId;

    // Find insertion point based on mouse position
    const afterElement = getDragAfterElement(targetColumnContainer, e.clientY);
    if (afterElement) {
      targetColumnContainer.insertBefore(draggedCard, afterElement);
    } else {
      targetColumnContainer.appendChild(draggedCard);
    }

    draggedCard.dataset.columnId = columnId;

    // Determine beforeId and afterId for server
    const siblings = Array.from(targetColumnContainer.children);
    const cardIndex = siblings.indexOf(draggedCard);
    const beforeId = cardIndex < siblings.length - 1 ? siblings[cardIndex + 1].dataset.cardId : null;
    const afterId = cardIndex > 0 ? siblings[cardIndex - 1].dataset.cardId : null;

    // Send to server
    try {
      const res = await fetch(`${API_BASE}/cards/${cardId}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId, beforeId, afterId })
      });
      if (!res.ok) {
        // Revert on failure
        if (oldParent) oldParent.appendChild(draggedCard);
        draggedCard.dataset.columnId = oldColumnId;
        alert('Move failed, reverted.');
      }
    } catch (err) {
      // Revert
      if (oldParent) oldParent.appendChild(draggedCard);
      draggedCard.dataset.columnId = oldColumnId;
      console.error(err);
    }
  });
}

// Helper to find insertion point for drag
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

// Add new card
async function addCard() {
  const textInput = document.getElementById('new-card-text');
  const select = document.getElementById('column-select');
  const text = textInput.value.trim();
  const columnId = select.value;

  if (!text || !columnId) return;

  try {
    const res = await fetch(`${API_BASE}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text })
    });
    if (res.ok) {
      textInput.value = '';
      // Optimistic render? But SSE will handle, or fetch again
      // For simplicity, let SSE update
    }
  } catch (err) {
    console.error(err);
  }
}

// Setup SSE
function setupSSE() {
  if (eventSource) eventSource.close();

  eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.addEventListener('card-created', (e) => {
    const { card } = JSON.parse(e.data);
    applyCardCreated(card);
  });

  eventSource.addEventListener('card-moved', (e) => {
    const { card, columnId } = JSON.parse(e.data);
    applyCardMoved(card, columnId);
  });

  eventSource.onerror = () => {
    console.log('SSE error, will reconnect...');
    setTimeout(setupSSE, 3000);
  };
}

// Apply card created from server
function applyCardCreated(card) {
  // Find column and add card if not present
  const colContainer = document.querySelector(`.cards[data-column-id="${card.column_id}"]`);
  if (!colContainer) return;

  // Avoid duplicate
  if (document.querySelector(`[data-card-id="${card.id}"]`)) return;

  const cardEl = createCardElement(card);
  colContainer.appendChild(cardEl);

  // Update local state roughly
  const col = boardState.find(c => c.id === card.column_id);
  if (col) {
    col.cards = col.cards || [];
    col.cards.push(card);
  }
}

// Apply card moved from server (authoritative)
function applyCardMoved(card, targetColumnId) {
  const cardId = card.id;
  const existingCardEl = document.querySelector(`[data-card-id="${cardId}"]`);
  const targetContainer = document.querySelector(`.cards[data-column-id="${targetColumnId}"]`);

  if (!targetContainer) return;

  if (existingCardEl) {
    // Move it to correct position
    existingCardEl.dataset.columnId = targetColumnId;

    // Remove from current parent
    if (existingCardEl.parentNode) {
      existingCardEl.parentNode.removeChild(existingCardEl);
    }

    // Insert at correct position based on position value? For simplicity append or find spot
    // Since server gives canonical, we can re-sort or just place logically
    // For full correctness, we should re-render the column, but to keep simple:
    targetContainer.appendChild(existingCardEl);

    // To properly order, perhaps better to re-fetch or implement position sort
    // For this impl, since optimistic + reconcile, and renorm, appending is approx but may not be perfect order
    // Let's improve: sort cards in column after move
    sortCardsInColumn(targetContainer, targetColumnId);
  } else {
    // Card not here, create it
    const cardEl = createCardElement(card);
    targetContainer.appendChild(cardEl);
    sortCardsInColumn(targetContainer, targetColumnId);
  }

  // Update boardState
  // Remove from old columns
  boardState.forEach(col => {
    col.cards = (col.cards || []).filter(c => c.id !== cardId);
  });
  // Add to new
  const targetCol = boardState.find(c => c.id === targetColumnId);
  if (targetCol) {
    targetCol.cards = targetCol.cards || [];
    targetCol.cards.push(card);
    targetCol.cards.sort((a,b) => a.position - b.position);
  }
}

// Sort cards visually by position (requires positions in DOM? or re-render)
function sortCardsInColumn(container, columnId) {
  const col = boardState.find(c => c.id === columnId);
  if (!col || !col.cards) return;

  const sorted = [...col.cards].sort((a, b) => a.position - b.position);
  const cardEls = Array.from(container.children);

  sorted.forEach((cardData, idx) => {
    const el = document.querySelector(`[data-card-id="${cardData.id}"]`);
    if (el && container.contains(el)) {
      container.appendChild(el); // moves to end in order
    }
  });
}

// Initialize
async function init() {
  await fetchBoard();
  setupSSE();

  // Add card button
  document.getElementById('add-card-btn').addEventListener('click', addCard);
  document.getElementById('new-card-text').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addCard();
  });

  // Initial column select population happens in render
}

init();