const API_BASE = ''; // Uses Vite proxy

let boardState = [];
let eventSource = null;

// Fetch initial board
async function fetchBoard() {
  const res = await fetch(`${API_BASE}/api/board`);
  return res.json();
}

// Render the board
function renderBoard(columns) {
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';
  
  // Update column select
  const select = document.getElementById('column-select');
  select.innerHTML = '';
  
  columns.forEach(col => {
    // Column element
    const colEl = document.createElement('div');
    colEl.className = 'column';
    colEl.dataset.columnId = col.id;
    
    colEl.innerHTML = `
      <div class="column-header">${col.title}</div>
      <div class="cards" data-column-id="${col.id}"></div>
    `;
    
    const cardsContainer = colEl.querySelector('.cards');
    
    // Render cards
    col.cards.forEach(card => {
      const cardEl = createCardElement(card, col.id);
      cardsContainer.appendChild(cardEl);
    });
    
    // Setup drop zone
    setupDropZone(cardsContainer, col.id);
    
    boardEl.appendChild(colEl);
    
    // Add to select
    const opt = document.createElement('option');
    opt.value = col.id;
    opt.textContent = col.title;
    select.appendChild(opt);
  });
  
  boardState = columns;
}

// Create card element
function createCardElement(card, columnId) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.draggable = true;
  cardEl.dataset.cardId = card.id;
  cardEl.dataset.columnId = columnId;
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
    const oldColumnId = draggedCard.dataset.columnId;
    const oldContainer = draggedCard.parentElement;
    
    // Find drop position
    const afterElement = getDragAfterElement(container, e.clientY);
    let beforeId = null;
    let afterId = null;
    
    if (afterElement) {
      beforeId = afterElement.dataset.cardId;
    } else {
      // Dropped at end, find last card
      const cards = container.querySelectorAll('.card');
      if (cards.length > 0) {
        afterId = cards[cards.length - 1].dataset.cardId;
      }
    }
    
    // Move DOM element
    if (afterElement) {
      container.insertBefore(draggedCard, afterElement);
    } else {
      container.appendChild(draggedCard);
    }
    
    draggedCard.dataset.columnId = columnId;
    
    // Send to server
    try {
      const res = await fetch(`${API_BASE}/api/cards/${cardId}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId, beforeId, afterId })
      });
      
      if (!res.ok) {
        // Revert on error? For simplicity, refetch
        await reconcileBoard();
      }
    } catch (err) {
      console.error('Move failed', err);
      await reconcileBoard();
    }
  });
}

// Helper to find element to insert before
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

// Reconcile with server state
async function reconcileBoard() {
  const columns = await fetchBoard();
  renderBoard(columns);
}

// Setup SSE
function setupSSE() {
  if (eventSource) eventSource.close();
  
  eventSource = new EventSource(`${API_BASE}/api/stream`);
  
  eventSource.addEventListener('connected', () => {
    console.log('SSE connected');
  });
  
  eventSource.addEventListener('card-created', (e) => {
    const card = JSON.parse(e.data);
    // Find column and add card if not present
    const colContainer = document.querySelector(`.cards[data-column-id="${card.columnId}"]`);
    if (colContainer && !colContainer.querySelector(`[data-card-id="${card.id}"]`)) {
      const cardEl = createCardElement(card, card.columnId);
      colContainer.appendChild(cardEl);
      // Update state
      const col = boardState.find(c => c.id === card.columnId);
      if (col) col.cards.push(card);
    }
  });
  
  eventSource.addEventListener('card-moved', (e) => {
    const data = JSON.parse(e.data);
    const { id, columnId, oldColumnId } = data;
    
    // Remove from old position if exists
    const existing = document.querySelector(`[data-card-id="${id}"]`);
    if (existing) {
      existing.remove();
    }
    
    // Add to new column at correct position? For simplicity, re-render or insert at end
    // Better: refetch for canonical state to ensure order
    reconcileBoard();
  });
  
  eventSource.onerror = (err) => {
    console.error('SSE error', err);
    // Attempt reconnect
    setTimeout(setupSSE, 3000);
  };
}

// Add card handler
async function setupAddCard() {
  const btn = document.getElementById('add-card-btn');
  const input = document.getElementById('new-card-text');
  const select = document.getElementById('column-select');
  
  btn.addEventListener('click', async () => {
    const text = input.value.trim();
    const columnId = select.value;
    if (!text || !columnId) return;
    
    try {
      const res = await fetch(`${API_BASE}/api/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId, text })
      });
      
      if (res.ok) {
        input.value = '';
        // Optimistic? SSE will handle, but to be sure
        const newCard = await res.json();
        // If not added by SSE yet, add manually
        const colContainer = document.querySelector(`.cards[data-column-id="${columnId}"]`);
        if (colContainer && !colContainer.querySelector(`[data-card-id="${newCard.id}"]`)) {
          const cardEl = createCardElement(newCard, columnId);
          colContainer.appendChild(cardEl);
        }
      }
    } catch (err) {
      console.error('Add card failed', err);
    }
  });
  
  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') btn.click();
  });
}

// Initialize app
async function init() {
  const columns = await fetchBoard();
  renderBoard(columns);
  setupAddCard();
  setupSSE();
}

init();