const API_BASE = '/api';
let boardState = { columns: [] };
let eventSource = null;
let draggedCard = null;
let draggedCardOriginalParent = null;
let draggedCardOriginalIndex = null;

async function fetchBoard() {
  const res = await fetch(`${API_BASE}/board`);
  if (!res.ok) throw new Error('Failed to fetch board');
  boardState = await res.json();
  renderBoard();
}

function renderBoard() {
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';

  boardState.columns.forEach(column => {
    const columnEl = createColumnElement(column);
    boardEl.appendChild(columnEl);
  });
}

function createColumnElement(column) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = column.id;

  colEl.innerHTML = `
    <div class="column-header">
      <span class="column-title">${escapeHtml(column.title)}</span>
      <span class="card-count">${column.cards.length}</span>
    </div>
    <div class="cards drop-zone" data-column-id="${column.id}"></div>
    <button class="add-card">Add a card</button>
  `;

  const cardsContainer = colEl.querySelector('.cards');
  column.cards.forEach(card => {
    const cardEl = createCardElement(card, column.id);
    cardsContainer.appendChild(cardEl);
  });

  // Add card functionality
  const addBtn = colEl.querySelector('.add-card');
  addBtn.addEventListener('click', () => showAddCardInput(cardsContainer, column.id));

  // Drag and drop setup
  setupDropZone(cardsContainer, column.id);

  return colEl;
}

function createCardElement(card, columnId) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.dataset.cardId = card.id;
  cardEl.dataset.columnId = columnId;
  cardEl.draggable = true;
  cardEl.innerHTML = `<div>${escapeHtml(card.text)}</div>`;

  cardEl.addEventListener('dragstart', handleDragStart);
  cardEl.addEventListener('dragend', handleDragEnd);

  return cardEl;
}

function setupDropZone(container, columnId) {
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
    // afterElement = the card that will be immediately AFTER the dropped card (i.e. below it)
    const afterElement = getDragAfterElement(container, e.clientY);
    const beforeId = afterElement ? afterElement.dataset.cardId : null;
    
    // Find the card immediately before the drop position (above)
    let afterId = null;
    const allCards = [...container.querySelectorAll('.card:not(.dragging)')];
    if (afterElement) {
      const idx = allCards.indexOf(afterElement);
      if (idx > 0) afterId = allCards[idx - 1].dataset.cardId;
    } else if (allCards.length > 0) {
      // Dropping at the end
      afterId = allCards[allCards.length - 1].dataset.cardId;
    }

    // Optimistic update
    performOptimisticMove(cardId, columnId, beforeId, afterId);

    // Send to server
    try {
      await moveCard(cardId, columnId, beforeId, afterId);
    } catch (err) {
      console.error('Move failed, will reconcile on next update', err);
      // Re-fetch to reconcile
      await fetchBoard();
    }
  });
}

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
  }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
}

function getAfterId(container, afterElement) {
  if (!afterElement) return null;
  const cards = [...container.querySelectorAll('.card')];
  const idx = cards.indexOf(afterElement);
  return idx > 0 ? cards[idx - 1].dataset.cardId : null;
}

function performOptimisticMove(cardId, newColumnId, beforeId, afterId) {
  // Find current card
  let sourceCol, cardIndex, card;
  for (const col of boardState.columns) {
    cardIndex = col.cards.findIndex(c => c.id === cardId);
    if (cardIndex !== -1) {
      sourceCol = col;
      card = col.cards[cardIndex];
      break;
    }
  }
  if (!card) return;

  // Remove from source
  sourceCol.cards.splice(cardIndex, 1);

  // Find target column
  const targetCol = boardState.columns.find(c => c.id === newColumnId);
  if (!targetCol) return;

  // Insert at position: afterId = prev card, beforeId = next card
  let insertIndex = targetCol.cards.length;
  if (beforeId) {
    const beforeIdx = targetCol.cards.findIndex(c => c.id === beforeId);
    if (beforeIdx !== -1) insertIndex = beforeIdx;
  } else if (afterId) {
    const afterIdx = targetCol.cards.findIndex(c => c.id === afterId);
    if (afterIdx !== -1) insertIndex = afterIdx + 1;
  }

  targetCol.cards.splice(insertIndex, 0, { ...card, column_id: newColumnId });

  // Re-render just the affected columns
  renderColumn(sourceCol.id);
  renderColumn(newColumnId);
}

function renderColumn(columnId) {
  const column = boardState.columns.find(c => c.id === columnId);
  if (!column) return;

  const colEl = document.querySelector(`.column[data-column-id="${columnId}"]`);
  if (!colEl) return;

  const cardsContainer = colEl.querySelector('.cards');
  cardsContainer.innerHTML = '';

  column.cards.forEach(card => {
    const cardEl = createCardElement(card, columnId);
    cardsContainer.appendChild(cardEl);
  });

  // Update count
  colEl.querySelector('.card-count').textContent = column.cards.length;
}

function handleDragStart(e) {
  draggedCard = e.currentTarget;
  draggedCardOriginalParent = draggedCard.parentElement;
  draggedCardOriginalIndex = [...draggedCard.parentElement.children].indexOf(draggedCard);
  draggedCard.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function handleDragEnd(e) {
  if (draggedCard) {
    draggedCard.classList.remove('dragging');
  }
  draggedCard = null;
  // Clean up any placeholders if needed
  document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
}

function getDragAfterElementForReorder(container, y) {
  const draggableElements = [...container.querySelectorAll('.card:not(.dragging)')];
  return draggableElements.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      return { offset: offset, element: child };
    } else {
      return closest;
    }
  }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
}

function showAddCardInput(container, columnId) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'new-card-input';
  input.placeholder = 'Enter card text...';
  container.appendChild(input);
  input.focus();

  const submit = async () => {
    const text = input.value.trim();
    if (text) {
      try {
        await createCard(columnId, text);
      } catch (e) {
        console.error(e);
      }
    }
    input.remove();
  };

  input.addEventListener('blur', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      submit();
    } else if (e.key === 'Escape') {
      input.remove();
    }
  });
}

async function createCard(columnId, text) {
  const res = await fetch(`${API_BASE}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text })
  });
  if (!res.ok) throw new Error('Failed to create card');
  // SSE will handle the update
}

async function moveCard(cardId, columnId, beforeId, afterId) {
  const res = await fetch(`${API_BASE}/cards/${cardId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, beforeId, afterId })
  });
  if (!res.ok) throw new Error('Failed to move card');
  return res.json();
}

function connectSSE() {
  const statusEl = document.getElementById('connection-status');
  
  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.onopen = () => {
    statusEl.style.color = '#36b37e';
    statusEl.title = 'Connected';
  };

  eventSource.onerror = () => {
    statusEl.style.color = '#ff5630';
    statusEl.title = 'Disconnected - reconnecting...';
  };

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleServerUpdate(data);
    } catch (e) {
      console.error('SSE parse error', e);
    }
  };
}

function handleServerUpdate(data) {
  if (data.type === 'card-created' || data.type === 'card-moved') {
    const { card, columnId } = data;
    
    // Remove card from all columns (to prevent duplicates)
    boardState.columns.forEach(col => {
      col.cards = col.cards.filter(c => c.id !== card.id);
    });

    // Find target column and insert card
    const targetCol = boardState.columns.find(c => c.id === columnId);
    if (targetCol) {
      // Insert maintaining order - but since server gives canonical, we may need to re-sort or insert properly
      // For simplicity, append and rely on server order or re-fetch if needed
      // Better: insert at correct position if possible, but since we don't have full order, append for now
      // Actually, to be accurate, we should place it correctly but for convergence we can re-render after sort
      targetCol.cards.push({ ...card, column_id: columnId });
      
      // Sort by position to maintain order
      targetCol.cards.sort((a, b) => a.position - b.position);
    }

    // Re-render affected columns
    renderBoard(); // Simple full re-render for correctness
  } else if (data.type === 'board-renormalized') {
    // Handle renormalization
    fetchBoard();
  }
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

// Also setup drag over for columns themselves
function setupGlobalDragHandlers() {
  // Additional handlers if needed for cross column
}

async function init() {
  await fetchBoard();
  connectSSE();
  setupGlobalDragHandlers();
  
  // Make sure drop zones work even on empty columns
  // Already handled in createColumnElement
}

init().catch(console.error);