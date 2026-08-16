const API_BASE = '/api';
const boardEl = document.getElementById('board');
const columnSelect = document.getElementById('column-select');
const newCardText = document.getElementById('new-card-text');
const addCardBtn = document.getElementById('add-card-btn');

let boardState = []; // Current authoritative state
let eventSource = null;

// Fetch initial board
async function fetchBoard() {
  const res = await fetch(`${API_BASE}/board`);
  const columns = await res.json();
  boardState = columns;
  renderBoard();
  populateColumnSelect();
}

// Render the board
function renderBoard() {
  boardEl.innerHTML = '';
  boardState.forEach(column => {
    const colEl = createColumnElement(column);
    boardEl.appendChild(colEl);
  });
}

// Create column DOM element
function createColumnElement(column) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = column.id;

  const titleEl = document.createElement('h2');
  titleEl.textContent = column.title;
  colEl.appendChild(titleEl);

  const cardsContainer = document.createElement('div');
  cardsContainer.className = 'cards-container';
  cardsContainer.dataset.columnId = column.id;

  column.cards.forEach(card => {
    const cardEl = createCardElement(card, column.id);
    cardsContainer.appendChild(cardEl);
  });

  // Setup drop zone
  setupDropZone(cardsContainer, column.id);

  colEl.appendChild(cardsContainer);
  return colEl;
}

// Create card DOM element
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
    // Store source info for optimistic
    window.currentDrag = { cardId: card.id, sourceColumnId: columnId };
  });

  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('dragging');
    window.currentDrag = null;
  });

  return cardEl;
}

// Setup drop zone for column
function setupDropZone(container, columnId) {
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    container.style.background = '#f0f8ff';
  });

  container.addEventListener('dragleave', () => {
    container.style.background = '';
  });

  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    container.style.background = '';

    const cardId = e.dataTransfer.getData('text/plain');
    if (!cardId || !window.currentDrag) return;

    // Find drop position: determine before/after based on mouse position
    const cards = Array.from(container.querySelectorAll('.card'));
    let beforeId = null;
    let afterId = null;

    const dropY = e.clientY;

    if (cards.length === 0) {
      // empty column
    } else {
      let found = false;
      for (let i = 0; i < cards.length; i++) {
        const rect = cards[i].getBoundingClientRect();
        if (dropY < rect.top + rect.height / 2) {
          beforeId = cards[i].dataset.cardId;
          afterId = i > 0 ? cards[i - 1].dataset.cardId : null;
          found = true;
          break;
        }
      }
      if (!found) {
        // drop at end
        afterId = cards[cards.length - 1].dataset.cardId;
      }
    }

    // Optimistic update
    optimisticMoveCard(cardId, columnId, beforeId, afterId);

    // Send to server
    try {
      const res = await fetch(`${API_BASE}/cards/${cardId}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId, beforeId, afterId })
      });
      if (!res.ok) {
        console.error('Move failed, will reconcile via SSE');
      }
    } catch (err) {
      console.error('Move error:', err);
    }
  });
}

// Optimistic move in DOM
function optimisticMoveCard(cardId, newColumnId, beforeId, afterId) {
  const cardEl = document.querySelector(`[data-card-id="${cardId}"]`);
  if (!cardEl) return;

  const targetContainer = document.querySelector(`.cards-container[data-column-id="${newColumnId}"]`);
  if (!targetContainer) return;

  // Remove from current parent
  cardEl.parentNode.removeChild(cardEl);

  // Insert at correct position
  if (beforeId) {
    const beforeEl = targetContainer.querySelector(`[data-card-id="${beforeId}"]`);
    if (beforeEl) {
      targetContainer.insertBefore(cardEl, beforeEl);
    } else {
      targetContainer.appendChild(cardEl);
    }
  } else if (afterId) {
    const afterEl = targetContainer.querySelector(`[data-card-id="${afterId}"]`);
    if (afterEl && afterEl.nextSibling) {
      targetContainer.insertBefore(cardEl, afterEl.nextSibling);
    } else {
      targetContainer.appendChild(cardEl);
    }
  } else {
    targetContainer.appendChild(cardEl);
  }

  // Update dataset
  cardEl.dataset.columnId = newColumnId;
}

// Populate column select for adding cards
function populateColumnSelect() {
  columnSelect.innerHTML = '';
  boardState.forEach(col => {
    const opt = document.createElement('option');
    opt.value = col.id;
    opt.textContent = col.title;
    columnSelect.appendChild(opt);
  });
}

// Add new card
addCardBtn.addEventListener('click', async () => {
  const text = newCardText.value.trim();
  const columnId = columnSelect.value;
  if (!text || !columnId) return;

  try {
    const res = await fetch(`${API_BASE}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text })
    });
    if (res.ok) {
      newCardText.value = '';
      // Will be added via SSE
    }
  } catch (err) {
    console.error('Add card error:', err);
  }
});

// Connect to SSE
function connectSSE() {
  if (eventSource) eventSource.close();

  eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.addEventListener('connected', () => {
    console.log('SSE connected');
  });

  eventSource.addEventListener('card-created', (e) => {
    const { card, columnId } = JSON.parse(e.data);
    handleCardCreated(card, columnId);
  });

  eventSource.addEventListener('card-moved', (e) => {
    const { card, columnId, oldColumnId } = JSON.parse(e.data);
    handleCardMoved(card, columnId, oldColumnId);
  });

  eventSource.addEventListener('column-renormalized', (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    handleColumnRenormalized(columnId, cards);
  });

  eventSource.onerror = (err) => {
    console.error('SSE error', err);
    // Reconnect logic could be added
  };
}

// Handle incoming create
function handleCardCreated(card, columnId) {
  // Find column in state
  const col = boardState.find(c => c.id === columnId);
  if (!col) return;

  // Avoid duplicate
  if (col.cards.find(c => c.id === card.id)) return;

  col.cards.push(card);
  // Re-render that column or full
  renderBoard();
}

// Handle move
function handleCardMoved(card, newColumnId, oldColumnId) {
  // Remove from old column if present
  if (oldColumnId) {
    const oldCol = boardState.find(c => c.id === oldColumnId);
    if (oldCol) {
      oldCol.cards = oldCol.cards.filter(c => c.id !== card.id);
    }
  }

  // Add/update in new column
  const newCol = boardState.find(c => c.id === newColumnId);
  if (newCol) {
    // Remove if exists (in case)
    newCol.cards = newCol.cards.filter(c => c.id !== card.id);
    newCol.cards.push(card);
    // Re-sort by position
    newCol.cards.sort((a, b) => a.position - b.position);
  }

  renderBoard();
}

// Handle renormalize
function handleColumnRenormalized(columnId, newCards) {
  const col = boardState.find(c => c.id === columnId);
  if (col) {
    col.cards = newCards;
    renderBoard();
  }
}

// Initial load
async function init() {
  await fetchBoard();
  connectSSE();
}

init();