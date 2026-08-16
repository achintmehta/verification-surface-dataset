const API_BASE = '';

let boardState = { columns: [] };
let draggedCard = null;
let draggedFromColumn = null;

async function fetchBoard() {
  const res = await fetch(`${API_BASE}/api/board`);
  boardState = await res.json();
  renderBoard();
}

function renderBoard() {
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';

  boardState.columns.forEach(column => {
    const colEl = document.createElement('div');
    colEl.className = 'column';
    colEl.dataset.columnId = column.id;

    colEl.innerHTML = `
      <h2>${column.title}</h2>
      <div class="cards" data-column-id="${column.id}"></div>
      <div class="add-card">
        <input type="text" placeholder="New card text" data-input="${column.id}">
        <button data-add="${column.id}">Add Card</button>
      </div>
    `;

    const cardsContainer = colEl.querySelector('.cards');
    column.cards.forEach(card => {
      const cardEl = createCardElement(card, column.id);
      cardsContainer.appendChild(cardEl);
    });

    // Add event listeners for drop
    cardsContainer.addEventListener('dragover', handleDragOver);
    cardsContainer.addEventListener('drop', handleDrop);
    cardsContainer.addEventListener('dragleave', handleDragLeave);

    // Add card button
    const addBtn = colEl.querySelector(`button[data-add="${column.id}"]`);
    const input = colEl.querySelector(`input[data-input="${column.id}"]`);
    addBtn.addEventListener('click', () => addCard(column.id, input));
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') addCard(column.id, input);
    });

    boardEl.appendChild(colEl);
  });
}

function createCardElement(card, columnId) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.draggable = true;
  cardEl.dataset.cardId = card.id;
  cardEl.dataset.columnId = columnId;
  cardEl.textContent = card.text;

  cardEl.addEventListener('dragstart', (e) => {
    draggedCard = card;
    draggedFromColumn = columnId;
    cardEl.classList.add('dragging');
    e.dataTransfer.setData('text/plain', card.id);
  });

  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('dragging');
    draggedCard = null;
    draggedFromColumn = null;
    // Clean up any drag-over styles
    document.querySelectorAll('.cards').forEach(c => c.classList.remove('drag-over'));
  });

  return cardEl;
}

function handleDragOver(e) {
  e.preventDefault();
  e.currentTarget.classList.add('drag-over');
}

function handleDragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
}

async function handleDrop(e) {
  e.preventDefault();
  const container = e.currentTarget;
  container.classList.remove('drag-over');

  const cardId = e.dataTransfer.getData('text/plain');
  const targetColumnId = container.dataset.columnId;

  if (!draggedCard || draggedCard.id !== cardId) return;

  // Optimistic update: move in DOM
  const cardEl = document.querySelector(`[data-card-id="${cardId}"]`);
  if (cardEl) {
    // Find position based on drop location
    const afterEl = getAfterElement(container, e.clientY);
    if (afterEl) {
      container.insertBefore(cardEl, afterEl);
    } else {
      container.appendChild(cardEl);
    }
    cardEl.dataset.columnId = targetColumnId;
  }

  // Determine beforeId and afterId from current DOM order
  const { beforeId, afterId } = getSiblingIds(container, cardId);

  // Send to server
  try {
    const res = await fetch(`${API_BASE}/api/cards/${cardId}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId: targetColumnId, beforeId, afterId })
    });
    if (!res.ok) {
      // Revert on failure? For simplicity, refetch
      await fetchBoard();
    }
  } catch (err) {
    console.error(err);
    await fetchBoard();
  }
}

function getAfterElement(container, y) {
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

function getSiblingIds(container, cardId) {
  const cards = [...container.querySelectorAll('.card')];
  const index = cards.findIndex(c => c.dataset.cardId === cardId);
  const beforeId = index < cards.length - 1 ? cards[index + 1].dataset.cardId : null;
  const afterId = index > 0 ? cards[index - 1].dataset.cardId : null;
  return { beforeId, afterId };
}

async function addCard(columnId, input) {
  const text = input.value.trim();
  if (!text) return;

  try {
    const res = await fetch(`${API_BASE}/api/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text })
    });
    if (res.ok) {
      input.value = '';
      // Optimistic? But since broadcast will handle, or refetch, but SSE will update
    }
  } catch (err) {
    console.error(err);
  }
}

function connectSSE() {
  const eventSource = new EventSource(`${API_BASE}/api/stream`);

  eventSource.addEventListener('card-created', (e) => {
    const { card, columnId } = JSON.parse(e.data);
    updateCardInState(card, columnId);
    renderBoard();
  });

  eventSource.addEventListener('card-moved', (e) => {
    const { card, columnId, oldColumnId } = JSON.parse(e.data);
    // Remove from old if present
    removeCardFromState(card.id, oldColumnId);
    updateCardInState(card, columnId);
    renderBoard();
  });

  eventSource.addEventListener('connected', () => {
    console.log('SSE connected');
  });

  eventSource.onerror = (err) => {
    console.error('SSE error', err);
  };
}

function updateCardInState(card, columnId) {
  let column = boardState.columns.find(c => c.id === columnId);
  if (!column) return;

  // Remove if exists elsewhere
  boardState.columns.forEach(col => {
    col.cards = col.cards.filter(c => c.id !== card.id);
  });

  // Add to correct position? For simplicity, append and rely on render? But better insert properly
  // Since server gives position, but to keep order, we should sort after
  column.cards.push(card);
  column.cards.sort((a, b) => a.position - b.position);
}

function removeCardFromState(cardId, columnId) {
  const column = boardState.columns.find(c => c.id === columnId);
  if (column) {
    column.cards = column.cards.filter(c => c.id !== cardId);
  }
}

async function init() {
  await fetchBoard();
  connectSSE();
}

init();