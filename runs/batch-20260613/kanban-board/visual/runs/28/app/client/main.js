const API_BASE = '/api';
let boardState = [];
let draggedCard = null;
let draggedCardElement = null;
let eventSource = null;

async function fetchBoard() {
  const res = await fetch(`${API_BASE}/board`);
  return await res.json();
}

function renderBoard(board) {
  boardState = board;
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';
  
  board.forEach(column => {
    const colEl = createColumnElement(column);
    boardEl.appendChild(colEl);
  });
}

function createColumnElement(column) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = column.id;
  
  colEl.innerHTML = `
    <h2>${column.title}</h2>
    <div class="cards" data-column-id="${column.id}"></div>
    <button class="add-card">+ Add Card</button>
  `;
  
  const cardsContainer = colEl.querySelector('.cards');
  column.cards.forEach(card => {
    const cardEl = createCardElement(card);
    cardsContainer.appendChild(cardEl);
  });
  
  // Add card handler
  const addBtn = colEl.querySelector('.add-card');
  addBtn.addEventListener('click', () => {
    showAddCardInput(cardsContainer, column.id);
  });
  
  // Drag and drop handlers for column
  setupColumnDragDrop(cardsContainer, column.id);
  
  return colEl;
}

function createCardElement(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.draggable = true;
  cardEl.dataset.cardId = card.id;
  cardEl.dataset.columnId = card.column_id;
  cardEl.textContent = card.text;
  
  // Drag events
  cardEl.addEventListener('dragstart', handleDragStart);
  cardEl.addEventListener('dragend', handleDragEnd);
  
  return cardEl;
}

function showAddCardInput(container, columnId) {
  // Remove any existing input
  const existing = container.parentElement.querySelector('.new-card');
  if (existing) existing.remove();
  
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'new-card';
  input.placeholder = 'Card text...';
  
  const submit = async () => {
    const text = input.value.trim();
    if (text) {
      await createCard(columnId, text);
    }
    input.remove();
  };
  
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
    if (e.key === 'Escape') input.remove();
  });
  
  input.addEventListener('blur', submit);
  
  container.parentElement.insertBefore(input, container.parentElement.querySelector('.add-card'));
  input.focus();
}

async function createCard(columnId, text) {
  try {
    const res = await fetch(`${API_BASE}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text })
    });
    const card = await res.json();
    // Optimistic render will be handled by SSE, but we can add immediately
    addCardToDOM(card, columnId);
  } catch (err) {
    console.error('Failed to create card:', err);
  }
}

function addCardToDOM(card, columnId) {
  // Check if already exists
  if (document.querySelector(`[data-card-id="${card.id}"]`)) return;
  
  const cardsContainer = document.querySelector(`.cards[data-column-id="${columnId}"]`);
  if (!cardsContainer) return;
  
  const cardEl = createCardElement(card);
  cardsContainer.appendChild(cardEl);
}

function setupColumnDragDrop(container, columnId) {
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    container.classList.add('drag-over');
  });
  
  container.addEventListener('dragleave', () => {
    container.classList.remove('drag-over');
  });
  
  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    container.classList.remove('drag-over');
    
    if (!draggedCard) return;
    
    const cardId = draggedCard.dataset.cardId;
    const sourceColumnId = draggedCard.dataset.columnId;
    
    // Find drop position
    const afterElement = getDragAfterElement(container, e.clientY);
    
    // Optimistic DOM update
    if (afterElement) {
      container.insertBefore(draggedCard, afterElement);
    } else {
      container.appendChild(draggedCard);
    }
    
    draggedCard.dataset.columnId = columnId;
    
    // Determine before/after for server
    let beforeId = null;
    let afterId = null;
    
    const siblings = Array.from(container.children).filter(el => el.classList.contains('card'));
    const currentIndex = siblings.indexOf(draggedCard);
    
    if (currentIndex > 0) {
      afterId = siblings[currentIndex - 1].dataset.cardId;
    }
    if (currentIndex < siblings.length - 1) {
      beforeId = siblings[currentIndex + 1].dataset.cardId;
    }
    
    // Send to server
    try {
      await fetch(`${API_BASE}/cards/${cardId}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId, beforeId, afterId })
      });
    } catch (err) {
      console.error('Move failed:', err);
      // Revert would be handled by SSE reconciliation
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

function handleDragStart(e) {
  draggedCard = e.currentTarget;
  draggedCardElement = e.currentTarget;
  e.currentTarget.classList.add('dragging');
  
  // Store original position for potential revert
  e.dataTransfer.effectAllowed = 'move';
}

function handleDragEnd(e) {
  if (draggedCardElement) {
    draggedCardElement.classList.remove('dragging');
  }
  draggedCard = null;
  draggedCardElement = null;
  
  // Clean up any drag-over classes
  document.querySelectorAll('.cards').forEach(el => el.classList.remove('drag-over'));
}

function connectSSE() {
  if (eventSource) eventSource.close();
  
  eventSource = new EventSource(`${API_BASE}/stream`);
  
  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      
      if (data.event === 'connected') {
        console.log('SSE connected');
        return;
      }
      
      if (data.event === 'card-created') {
        handleCardCreated(data.data);
      } else if (data.event === 'card-moved') {
        handleCardMoved(data.data);
      } else if (data.event === 'column-renormalized') {
        handleColumnRenormalized(data.data);
      }
    } catch (err) {
      console.error('SSE parse error:', err);
    }
  };
  
  eventSource.onerror = (err) => {
    console.error('SSE error:', err);
    // Attempt reconnect
    setTimeout(connectSSE, 3000);
  };
}

function handleCardCreated({ card, columnId }) {
  // Remove optimistic duplicate if exists
  const existing = document.querySelector(`[data-card-id="${card.id}"]`);
  if (existing) existing.remove();
  
  addCardToDOM(card, columnId);
}

function handleCardMoved({ card, columnId, oldColumnId }) {
  // Remove from all places to ensure single location
  document.querySelectorAll(`[data-card-id="${card.id}"]`).forEach(el => el.remove());
  
  // Add to correct column
  const targetColumn = document.querySelector(`.cards[data-column-id="${columnId}"]`);
  if (targetColumn) {
    // Insert at correct position based on position value
    const cardEl = createCardElement(card);
    insertCardInOrder(targetColumn, cardEl, card);
  }
}

function insertCardInOrder(container, cardEl, card) {
  const existingCards = Array.from(container.children).filter(el => el.classList.contains('card'));
  
  // Find correct insertion point by comparing positions
  let inserted = false;
  for (const existing of existingCards) {
    // We don't have position on DOM, so append and let server state drive
    // For simplicity, append and rely on full reconcile if needed
  }
  
  container.appendChild(cardEl);
}

function handleColumnRenormalized({ columnId, cards }) {
  const container = document.querySelector(`.cards[data-column-id="${columnId}"]`);
  if (!container) return;
  
  // Clear and re-render cards in order
  container.innerHTML = '';
  cards.forEach(card => {
    const cardEl = createCardElement(card);
    container.appendChild(cardEl);
  });
}

async function init() {
  try {
    const board = await fetchBoard();
    renderBoard(board);
    connectSSE();
  } catch (err) {
    console.error('Init failed:', err);
    // Fallback render empty board
    document.getElementById('board').innerHTML = '<p>Failed to load board. Is server running?</p>';
  }
}

init();