const API_BASE = '/api';
let boardState = { columns: [] };
let eventSource = null;
let draggedCard = null;
let draggedCardOriginalParent = null;
let draggedCardOriginalNextSibling = null;

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
      <span class="title">${escapeHtml(column.title)}</span>
    </div>
    <div class="cards" data-column-id="${column.id}"></div>
    <button class="add-card">+ Add card</button>
  `;

  const cardsContainer = colEl.querySelector('.cards');
  const addBtn = colEl.querySelector('.add-card');

  // Render cards
  column.cards.forEach(card => {
    const cardEl = createCardElement(card);
    cardsContainer.appendChild(cardEl);
  });

  // Add card handler
  addBtn.addEventListener('click', () => createCard(column.id));

  // Drag and drop handlers for column
  setupColumnDragDrop(colEl, cardsContainer);

  return colEl;
}

function createCardElement(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.dataset.cardId = card.id;
  cardEl.draggable = true;
  cardEl.innerHTML = `<div>${escapeHtml(card.text)}</div>`;

  // Drag events
  cardEl.addEventListener('dragstart', (e) => {
    draggedCard = cardEl;
    draggedCardOriginalParent = cardEl.parentNode;
    draggedCardOriginalNextSibling = cardEl.nextSibling;
    cardEl.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.id);
  });

  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('dragging');
    draggedCard = null;
    // Clean up any placeholders
    document.querySelectorAll('.card-placeholder').forEach(p => p.remove());
  });

  return cardEl;
}

function setupColumnDragDrop(colEl, cardsContainer) {
  cardsContainer.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    if (!draggedCard) return;

    const afterElement = getDragAfterElement(cardsContainer, e.clientY);
    const placeholder = getOrCreatePlaceholder();

    if (afterElement == null) {
      cardsContainer.appendChild(placeholder);
    } else {
      cardsContainer.insertBefore(placeholder, afterElement);
    }
  });

  cardsContainer.addEventListener('dragleave', (e) => {
    // Only remove if leaving the container
    if (!cardsContainer.contains(e.relatedTarget)) {
      const placeholder = cardsContainer.querySelector('.card-placeholder');
      if (placeholder) placeholder.remove();
    }
  });

  cardsContainer.addEventListener('drop', async (e) => {
    e.preventDefault();
    const placeholder = cardsContainer.querySelector('.card-placeholder');
    if (placeholder) placeholder.remove();

    if (!draggedCard) return;

    const cardId = draggedCard.dataset.cardId;
    const newColumnId = cardsContainer.dataset.columnId;

    // Find before and after cards for position calculation
    const afterElement = getDragAfterElement(cardsContainer, e.clientY, true); // exclude placeholder
    const beforeId = afterElement ? afterElement.dataset.cardId : null;

    // Get the previous sibling of afterElement or last if none
    let afterId = null;
    if (afterElement) {
      const prev = afterElement.previousSibling;
      afterId = prev && prev.dataset ? prev.dataset.cardId : null;
    } else {
      // dropped at end, so afterId is the last card
      const children = Array.from(cardsContainer.children).filter(c => c.classList.contains('card'));
      if (children.length > 0) {
        afterId = children[children.length - 1].dataset.cardId;
      }
    }

    // Optimistic update
    performOptimisticMove(cardId, newColumnId, beforeId, afterId);

    // Send to server
    try {
      await fetch(`${API_BASE}/cards/${cardId}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId: newColumnId, beforeId, afterId })
      });
    } catch (err) {
      console.error('Move failed, will reconcile on next SSE', err);
    }
  });

  // Also allow drop on column itself
  colEl.addEventListener('dragover', (e) => {
    if (e.target === colEl || e.target.classList.contains('column-header')) {
      e.preventDefault();
    }
  });
}

function getDragAfterElement(container, y, excludePlaceholder = false) {
  const cards = [...container.querySelectorAll('.card' + (excludePlaceholder ? '' : ', .card-placeholder'))]
    .filter(el => el !== draggedCard);

  return cards.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      return { offset: offset, element: child };
    } else {
      return closest;
    }
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

function getOrCreatePlaceholder() {
  let placeholder = document.querySelector('.card-placeholder');
  if (!placeholder) {
    placeholder = document.createElement('div');
    placeholder.className = 'card-placeholder';
  }
  return placeholder;
}

function performOptimisticMove(cardId, newColumnId, beforeId, afterId) {
  // Find current card in state
  let card = null;
  let oldColumn = null;
  for (const col of boardState.columns) {
    const idx = col.cards.findIndex(c => c.id === cardId);
    if (idx !== -1) {
      card = col.cards.splice(idx, 1)[0];
      oldColumn = col;
      break;
    }
  }
  if (!card) return;

  // Update column
  card.column_id = newColumnId;

  // Find target column
  const targetCol = boardState.columns.find(c => c.id === newColumnId);
  if (!targetCol) return;

  // Insert based on before/after
  let insertIndex = targetCol.cards.length;
  if (beforeId) {
    const beforeIdx = targetCol.cards.findIndex(c => c.id === beforeId);
    if (beforeIdx !== -1) insertIndex = beforeIdx;
  } else if (afterId) {
    const afterIdx = targetCol.cards.findIndex(c => c.id === afterId);
    if (afterIdx !== -1) insertIndex = afterIdx + 1;
  }

  targetCol.cards.splice(insertIndex, 0, card);

  // Re-render just this column or full board
  renderBoard();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function createCard(columnId) {
  const text = prompt('Card text:');
  if (!text || !text.trim()) return;

  try {
    const res = await fetch(`${API_BASE}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text: text.trim() })
    });
    const card = await res.json();
    // Optimistic? But since SSE will handle, or we can add locally
    // For simplicity, rely on SSE, but to make responsive, add optimistically
    addCardOptimistically(columnId, card);
  } catch (err) {
    console.error('Create failed', err);
  }
}

function addCardOptimistically(columnId, card) {
  const targetCol = boardState.columns.find(c => c.id === columnId);
  if (targetCol) {
    targetCol.cards.push(card);
    renderBoard();
  }
}

function connectSSE() {
  if (eventSource) eventSource.close();

  eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleServerUpdate(data);
  };

  eventSource.onerror = (err) => {
    console.error('SSE error', err);
    // Reconnect after delay
    setTimeout(connectSSE, 3000);
  };
}

function handleServerUpdate(data) {
  if (data.type === 'card-created' || data.type === 'card-moved') {
    const { card, columnId } = data;

    // Remove card from anywhere it might be (to prevent duplicates)
    for (const col of boardState.columns) {
      col.cards = col.cards.filter(c => c.id !== card.id);
    }

    // Find target column and insert at correct position or append
    const targetCol = boardState.columns.find(c => c.id === columnId || c.id === card.column_id);
    if (targetCol) {
      // If server provides position, we should sort later, but for now insert logically
      // Better: always re-sort by position after update
      targetCol.cards.push({ ...card, position: card.position || 0 });
    }

    // Re-sort all columns by position
    boardState.columns.forEach(col => {
      col.cards.sort((a, b) => (a.position || 0) - (b.position || 0));
    });

    renderBoard();
  } else if (data.type === 'board-renormalized') {
    // Full board update
    if (data.board) {
      boardState = data.board;
      renderBoard();
    }
  }
}

function initialize() {
  fetchBoard().then(() => {
    connectSSE();
  });

  // Make sure board is always up to date on focus etc, but SSE should suffice
}

initialize();