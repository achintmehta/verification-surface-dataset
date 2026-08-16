const API_BASE = '/api';
let boardState = { columns: [] };
let eventSource = null;
let optimisticCards = new Map(); // cardId -> {columnId, position}

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
      <span class="column-title">${column.title}</span>
      <span class="card-count">${column.cards.length}</span>
    </div>
    <div class="cards" data-column-id="${column.id}"></div>
    <div class="add-card" data-column-id="${column.id}">+ Add card</div>
  `;

  const cardsContainer = colEl.querySelector('.cards');
  column.cards.forEach(card => {
    const cardEl = createCardElement(card, column.id);
    cardsContainer.appendChild(cardEl);
  });

  // Add card handler
  colEl.querySelector('.add-card').addEventListener('click', () => {
    const text = prompt('Card text:');
    if (text) createCard(column.id, text);
  });

  // Drop zone handlers
  setupDropZone(cardsContainer, column.id);

  return colEl;
}

function createCardElement(card, columnId) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.draggable = true;
  cardEl.dataset.cardId = card.id;
  cardEl.dataset.columnId = columnId;
  cardEl.dataset.position = card.position;

  cardEl.innerHTML = `<p>${escapeHtml(card.text)}</p>`;

  // Drag events
  cardEl.addEventListener('dragstart', handleDragStart);
  cardEl.addEventListener('dragend', handleDragEnd);

  return cardEl;
}

function setupDropZone(container, columnId) {
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    container.parentElement.classList.add('drag-over');
  });

  container.addEventListener('dragleave', () => {
    container.parentElement.classList.remove('drag-over');
  });

  container.addEventListener('drop', (e) => {
    e.preventDefault();
    container.parentElement.classList.remove('drag-over');

    const cardId = e.dataTransfer.getData('text/plain');
    const sourceColumnId = parseInt(e.dataTransfer.getData('source-column'));

    // Find drop position
    const afterElement = getDragAfterElement(container, e.clientY);
    let beforeId = null;
    let afterId = null;

    if (afterElement) {
      beforeId = parseInt(afterElement.dataset.cardId);
    }

    // Find the card before the afterElement
    const cards = Array.from(container.children);
    const afterIndex = afterElement ? cards.indexOf(afterElement) : cards.length;
    if (afterIndex > 0) {
      afterId = parseInt(cards[afterIndex - 1].dataset.cardId);
    }

    // Optimistic update
    optimisticMove(cardId, columnId, beforeId, afterId);

    // Send to server
    moveCard(cardId, columnId, beforeId, afterId);
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
  e.target.classList.add('dragging');
  e.dataTransfer.setData('text/plain', e.target.dataset.cardId);
  e.dataTransfer.setData('source-column', e.target.dataset.columnId);
}

function handleDragEnd(e) {
  e.target.classList.remove('dragging');
  // Clean up any drag-over states
  document.querySelectorAll('.column').forEach(col => col.classList.remove('drag-over'));
}

function optimisticMove(cardId, newColumnId, beforeId, afterId) {
  // Remove from current position
  boardState.columns.forEach(col => {
    col.cards = col.cards.filter(c => c.id != cardId);
  });

  // Find target column
  const targetCol = boardState.columns.find(c => c.id == newColumnId);
  if (!targetCol) return;

  // Insert at approximate position for optimistic
  let newPos = Date.now() / 1000000; // rough fractional
  if (afterId && beforeId) {
    const afterCard = targetCol.cards.find(c => c.id == afterId);
    const beforeCard = targetCol.cards.find(c => c.id == beforeId);
    if (afterCard && beforeCard) {
      newPos = (afterCard.position + beforeCard.position) / 2;
    }
  } else if (afterId) {
    const afterCard = targetCol.cards.find(c => c.id == afterId);
    if (afterCard) newPos = afterCard.position + 1;
  } else if (beforeId) {
    const beforeCard = targetCol.cards.find(c => c.id == beforeId);
    if (beforeCard) newPos = beforeCard.position - 1;
  }

  const newCard = { id: parseInt(cardId), text: '', column_id: newColumnId, position: newPos };
  // Find original text
  // For simplicity, we'll let SSE fix the text
  targetCol.cards.push(newCard);
  // Sort by position optimistically
  targetCol.cards.sort((a, b) => a.position - b.position);

  optimisticCards.set(parseInt(cardId), { columnId: newColumnId, position: newPos });

  renderBoard();
}

async function createCard(columnId, text) {
  await fetch(`${API_BASE}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text })
  });
  // SSE will update
}

async function moveCard(cardId, columnId, beforeId, afterId) {
  try {
    const res = await fetch(`${API_BASE}/cards/${cardId}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId })
    });
    if (!res.ok) {
      // Revert optimistic on failure
      await fetchBoard();
    }
  } catch (err) {
    await fetchBoard();
  }
}

function connectSSE() {
  const statusEl = document.getElementById('connection-status');
  
  eventSource = new EventSource(`${API_BASE}/stream`);
  
  eventSource.onopen = () => {
    statusEl.textContent = 'Connected';
    statusEl.classList.add('connected');
  };

  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleServerUpdate(data);
  };

  eventSource.onerror = () => {
    statusEl.textContent = 'Disconnected';
    statusEl.classList.remove('connected');
    // Attempt reconnect
    setTimeout(() => {
      if (eventSource) eventSource.close();
      connectSSE();
    }, 3000);
  };
}

function handleServerUpdate(data) {
  if (data.type === 'card-created' || data.type === 'card-moved') {
    const card = data.card;
    const columnId = data.columnId || card.column_id;

    // Remove card from all columns to prevent duplicates
    boardState.columns.forEach(col => {
      col.cards = col.cards.filter(c => c.id !== card.id);
    });

    // Find target column and insert card
    const targetCol = boardState.columns.find(c => c.id == columnId);
    if (targetCol) {
      // Remove optimistic guess
      optimisticCards.delete(card.id);

      targetCol.cards.push(card);
      targetCol.cards.sort((a, b) => a.position - b.position);
    }

    renderBoard();
  } else if (data.type === 'column-renormalized') {
    // Handle renormalization broadcast
    const { columnId, cards } = data;
    const col = boardState.columns.find(c => c.id == columnId);
    if (col) {
      col.cards = cards;
      renderBoard();
    }
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function init() {
  await fetchBoard();
  connectSSE();
}

init();