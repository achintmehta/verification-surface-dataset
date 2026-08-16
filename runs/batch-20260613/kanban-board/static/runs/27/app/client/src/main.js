const API_BASE = '/api';
let boardState = { columns: [] };
let eventSource = null;

// Fetch initial board
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

  // Update column select for adding cards
  const select = document.getElementById('column-select');
  select.innerHTML = '';

  boardState.columns.forEach(column => {
    // Add to select
    const option = document.createElement('option');
    option.value = column.id;
    option.textContent = column.title;
    select.appendChild(option);

    // Create column element
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
      <span>${column.title}</span>
      <span class="card-count">${column.cards.length}</span>
    </div>
    <div class="cards" data-column-id="${column.id}"></div>
  `;

  const cardsContainer = colEl.querySelector('.cards');
  
  column.cards.forEach(card => {
    const cardEl = createCardElement(card);
    cardsContainer.appendChild(cardEl);
  });

  // Setup drop zone
  setupDropZone(cardsContainer, column.id);

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
  cardEl.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', card.id);
    cardEl.classList.add('dragging');
  });

  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('dragging');
  });

  return cardEl;
}

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
    const cardEl = document.querySelector(`[data-card-id="${cardId}"]`);
    if (!cardEl) return;

    // Optimistic update: move in DOM
    const oldParent = cardEl.parentElement;
    const oldColumnId = oldParent.dataset.columnId;

    // Determine position: insert before/after based on drop position
    const afterElement = getDragAfterElement(container, e.clientY);
    let beforeId = null;
    let afterId = null;

    if (afterElement) {
      afterId = afterElement.dataset.cardId;
    } else {
      // dropped at end
      const lastCard = container.lastElementChild;
      if (lastCard && lastCard.dataset.cardId !== cardId) {
        beforeId = lastCard.dataset.cardId;
      }
    }onst lastCard = container.lastElementChild;
      if (lastCard && lastCard.dataset.cardId !== cardId) {
        afterId = lastCard.dataset.cardId;
      }
    }

    // Move DOM element
    if (afterElement) {
      container.insertBefore(cardEl, afterElement);
    } else {
      container.appendChild(cardEl);
    }

    // Update dataset
    cardEl.dataset.columnId = columnId;

    // Send to server
    try {
      await fetch(`${API_BASE}/cards/${cardId}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId, beforeId, afterId })
      });
      // Server will broadcast update via SSE, which will reconcile
    } catch (err) {
      console.error('Move failed, will reconcile via SSE', err);
      // Re-fetch board on error
      fetchBoard();
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
    const card = await res.json();
    // Optimistic? But since broadcast will handle, or render immediately
    textInput.value = '';
    // Let SSE handle rendering for consistency
  } catch (err) {
    console.error(err);
    alert('Failed to add card');
  }
}

// SSE connection for real-time updates
function connectSSE() {
  if (eventSource) eventSource.close();

  eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.addEventListener('connected', () => {
    console.log('SSE connected');
  });

  eventSource.addEventListener('card-created', (event) => {
    const { card, columnId } = JSON.parse(event.data);
    applyCardCreated(card, columnId);
  });

  eventSource.addEventListener('card-moved', (event) => {
    const { card, columnId, oldColumnId } = JSON.parse(event.data);
    applyCardMoved(card, columnId, oldColumnId);
  });

  eventSource.onerror = (err) => {
    console.error('SSE error', err);
    // Attempt reconnect
    setTimeout(connectSSE, 3000);
  };
}

function applyCardCreated(card, columnId) {
  // Find column and add card if not present
  const column = boardState.columns.find(c => c.id === columnId);
  if (!column) return;

  // Avoid duplicates
  if (column.cards.find(c => c.id === card.id)) return;

  column.cards.push(card);
  // Re-render for simplicity (or surgically update)
  renderBoard();
}

function applyCardMoved(card, newColumnId, oldColumnId) {
  // Remove from old column if different
  if (oldColumnId && oldColumnId !== newColumnId) {
    const oldCol = boardState.columns.find(c => c.id === oldColumnId);
    if (oldCol) {
      oldCol.cards = oldCol.cards.filter(c => c.id !== card.id);
    }
  }

  // Update or add to new column
  const newCol = boardState.columns.find(c => c.id === newColumnId);
  if (newCol) {
    // Remove if exists (to update position)
    newCol.cards = newCol.cards.filter(c => c.id !== card.id);
    
    // Insert at correct position
    const sorted = [...newCol.cards, card].sort((a, b) => a.position - b.position);
    newCol.cards = sorted;
  }

  // Re-render board to canonical state
  renderBoard();
}

// Initialize everything
async function init() {
  await fetchBoard();
  connectSSE();

  // Add card button
  document.getElementById('add-card-btn').addEventListener('click', addCard);
  document.getElementById('new-card-text').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addCard();
  });

  // Initial column select will be populated on render
}

init();