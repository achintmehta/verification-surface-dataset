const API_BASE = '/api';
let boardState = [];
let draggedCard = null;
let draggedCardId = null;
let optimisticMoves = new Map(); // cardId -> {columnId, position}

async function fetchBoard() {
  const res = await fetch(`${API_BASE}/board`);
  boardState = await res.json();
  renderBoard();
}

function renderBoard() {
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';
  boardEl.className = 'board';

  // Update column select
  const select = document.getElementById('column-select');
  select.innerHTML = '';

  boardState.forEach(column => {
    // Column element
    const colEl = document.createElement('div');
    colEl.className = 'column';
    colEl.dataset.columnId = column.id;

    // Header
    const header = document.createElement('div');
    header.className = 'column-header';
    header.textContent = column.title;
    colEl.appendChild(header);

    // Cards container
    const cardsContainer = document.createElement('div');
    cardsContainer.className = 'cards';
    cardsContainer.dataset.columnId = column.id;

    // Sort cards by position, apply optimistic if any
    let cards = [...(column.cards || [])];
    cards.sort((a, b) => a.position - b.position);

    cards.forEach(card => {
      const cardEl = createCardElement(card, column.id);
      cardsContainer.appendChild(cardEl);
    });

    // Setup drag and drop for container
    setupDropZone(cardsContainer, column.id);

    colEl.appendChild(cardsContainer);
    boardEl.appendChild(colEl);

    // Add to select
    const opt = document.createElement('option');
    opt.value = column.id;
    opt.textContent = column.title;
    select.appendChild(opt);
  });
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
    if (draggedCard) {
      draggedCard.classList.remove('dragging');
    }
    draggedCard = null;
    draggedCardId = null;
    // Clear any drag-over styles
    document.querySelectorAll('.column').forEach(c => c.classList.remove('drag-over'));
  });

  return cardEl;
}

function setupDropZone(container, columnId) {
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    container.parentElement.classList.add('drag-over');
  });

  container.addEventListener('dragleave', () => {
    container.parentElement.classList.remove('drag-over');
  });

  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    container.parentElement.classList.remove('drag-over');

    if (!draggedCardId || !draggedCard) return;

    const cardId = draggedCardId;
    const sourceColumnId = draggedCard.dataset.columnId;

    // Optimistic update: move in DOM immediately
    const targetContainer = container;
    let insertBeforeEl = null;

    // Find insertion point based on mouse position
    const afterElements = Array.from(targetContainer.children).filter(el => el.classList.contains('card'));
    for (const el of afterElements) {
      const rect = el.getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) {
        insertBeforeEl = el;
        break;
      }
    }

    // Optimistically move DOM element
    if (insertBeforeEl) {
      targetContainer.insertBefore(draggedCard, insertBeforeEl);
    } else {
      targetContainer.appendChild(draggedCard);
    }

    // Update dataset
    draggedCard.dataset.columnId = columnId;

    // Determine before/after for server
    let beforeId = null;
    let afterId = null;
    const currentCards = Array.from(targetContainer.children).filter(el => el.classList.contains('card'));
    const idx = currentCards.indexOf(draggedCard);
    if (idx > 0) afterId = currentCards[idx - 1].dataset.cardId;
    if (idx < currentCards.length - 1) beforeId = currentCards[idx + 1].dataset.cardId;

    // Store optimistic move
    optimisticMoves.set(cardId, { columnId, beforeId, afterId });

    // Send to server
    try {
      const res = await fetch(`${API_BASE}/cards/${cardId}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId, beforeId, afterId })
      });
      if (!res.ok) throw new Error('Move failed');
      // Server will broadcast via SSE, which will reconcile
    } catch (err) {
      console.error('Move error:', err);
      // Revert optimistic? For simplicity, refetch board
      await fetchBoard();
    }
  });
}

function setupAddCard() {
  const btn = document.getElementById('add-card-btn');
  const input = document.getElementById('new-card-text');
  const select = document.getElementById('column-select');

  btn.addEventListener('click', async () => {
    const text = input.value.trim();
    const columnId = select.value;
    if (!text || !columnId) return;

    try {
      const res = await fetch(`${API_BASE}/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId, text })
      });
      if (res.ok) {
        input.value = '';
        // SSE will handle adding to UI
      }
    } catch (err) {
      console.error('Add card error:', err);
    }
  });

  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') btn.click();
  });
}

function setupSSE() {
  const eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.addEventListener('card-created', (event) => {
    const data = JSON.parse(event.data);
    handleCardCreated(data);
  });

  eventSource.addEventListener('card-moved', (event) => {
    const data = JSON.parse(event.data);
    handleCardMoved(data);
  });

  eventSource.addEventListener('error', (e) => {
    console.log('SSE error, will reconnect...');
  });
}

function handleCardCreated(data) {
  const { card, columnId } = data;
  // Find column and add card if not already present
  const column = boardState.find(c => c.id === columnId);
  if (column) {
    if (!column.cards) column.cards = [];
    if (!column.cards.find(c => c.id === card.id)) {
      column.cards.push(card);
    }
  }
  renderBoard();
}

function handleCardMoved(data) {
  const { card, columnId } = data;
  const cardId = card.id;

  // Remove from all columns
  boardState.forEach(col => {
    if (col.cards) {
      col.cards = col.cards.filter(c => c.id !== cardId);
    }
  });

  // Add to target column with correct data
  const targetCol = boardState.find(c => c.id === columnId);
  if (targetCol) {
    if (!targetCol.cards) targetCol.cards = [];
    // Update card with new column and position from server
    const updatedCard = { ...card, column_id: columnId };
    targetCol.cards.push(updatedCard);
  }

  // Clear optimistic for this card
  optimisticMoves.delete(cardId);

  renderBoard();
}

function reconcileOptimistic() {
  // Periodically or on demand, but SSE handles reconciliation
  // This is called implicitly via SSE updates
}

// Initial setup
async function init() {
  await fetchBoard();
  setupAddCard();
  setupSSE();

  // Optional: refresh board periodically as fallback
  setInterval(() => {
    if (optimisticMoves.size === 0) {
      // fetchBoard(); // Uncomment if needed, but SSE should suffice
    }
  }, 30000);
}

init();
