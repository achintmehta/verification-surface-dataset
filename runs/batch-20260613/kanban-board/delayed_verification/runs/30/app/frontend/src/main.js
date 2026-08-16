const API_BASE = '/api';
let boardState = [];
let eventSource = null;

async function fetchBoard() {
  const res = await fetch(`${API_BASE}/board`);
  boardState = await res.json();
  renderBoard();
}

function renderBoard() {
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';

  boardState.forEach(column => {
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
    <div class="add-card">+ Add card</div>
  `;

  const cardsContainer = colEl.querySelector('.cards');
  column.cards.forEach(card => {
    const cardEl = createCardElement(card);
    cardsContainer.appendChild(cardEl);
  });

  // Setup drop zone
  setupDropZone(cardsContainer, column.id);

  // Add card handler
  const addBtn = colEl.querySelector('.add-card');
  addBtn.addEventListener('click', () => {
    showAddCardInput(cardsContainer, column.id);
  });

  return colEl;
}

function createCardElement(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.draggable = true;
  cardEl.dataset.cardId = card.id;
  cardEl.dataset.columnId = card.column_id;
  cardEl.textContent = card.text;

  cardEl.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', card.id);
    cardEl.classList.add('dragging');
    // Store source column for cross column
    e.dataTransfer.setData('source-column', card.column_id);
  });

  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('dragging');
  });

  return cardEl;
}

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
    const sourceColumn = e.dataTransfer.getData('source-column');

    // Find drop position
    const { beforeId, afterId } = getDropPosition(container, e.clientY, cardId);

    // Optimistic update
    applyOptimisticMove(cardId, columnId, beforeId, afterId);

    // Send to server
    try {
      await fetch(`${API_BASE}/cards/${cardId}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId, beforeId, afterId })
      });
    } catch (err) {
      console.error('Move failed, will reconcile on SSE or reload', err);
      // Re-fetch to reconcile
      await fetchBoard();
    }
  });
}

function getDropPosition(container, clientY, draggingCardId) {
  const cards = Array.from(container.querySelectorAll('.card:not(.dragging)'));
  let beforeId = null;
  let afterId = null;

  for (let i = 0; i < cards.length; i++) {
    const rect = cards[i].getBoundingClientRect();
    const midY = rect.top + rect.height / 2;

    if (clientY < midY) {
      // Drop before this card
      beforeId = cards[i].dataset.cardId;
      afterId = i > 0 ? cards[i - 1].dataset.cardId : null;
      return { beforeId, afterId };
    }
  }

  // Drop at end
  if (cards.length > 0) {
    afterId = cards[cards.length - 1].dataset.cardId;
  }
  return { beforeId, afterId };
}

function applyOptimisticMove(cardId, newColumnId, beforeId, afterId) {
  // Find card in current state
  let foundCard = null;
  let oldColumnIdx = -1;
  let oldCardIdx = -1;

  for (let cIdx = 0; cIdx < boardState.length; cIdx++) {
    const col = boardState[cIdx];
    const idx = col.cards.findIndex(c => c.id === cardId);
    if (idx !== -1) {
      foundCard = col.cards[idx];
      oldColumnIdx = cIdx;
      oldCardIdx = idx;
      break;
    }
  }

  if (!foundCard) return;

  // Remove from old
  boardState[oldColumnIdx].cards.splice(oldCardIdx, 1);

  // Find target column
  const targetColIdx = boardState.findIndex(c => c.id === newColumnId);
  if (targetColIdx === -1) return;

  // Insert at correct position
  let insertIdx = boardState[targetColIdx].cards.length; // default end

  if (beforeId) {
    const beforeIdx = boardState[targetColIdx].cards.findIndex(c => c.id === beforeId);
    if (beforeIdx !== -1) insertIdx = beforeIdx;
  } else if (afterId) {
    const afterIdx = boardState[targetColIdx].cards.findIndex(c => c.id === afterId);
    if (afterIdx !== -1) insertIdx = afterIdx + 1;
  }

  // Update card's column
  foundCard.column_id = newColumnId;
  boardState[targetColIdx].cards.splice(insertIdx, 0, foundCard);

  // Re-render
  renderBoard();
}

function showAddCardInput(container, columnId) {
  // Remove existing input if any
  const existing = container.parentElement.querySelector('.new-card-input');
  if (existing) existing.remove();

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'new-card-input';
  input.placeholder = 'Card text...';
  input.style.margin = '8px 0';

  const submit = async () => {
    const text = input.value.trim();
    if (text) {
      try {
        await fetch(`${API_BASE}/cards`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId, text })
        });
        // Will be added via SSE or re-fetch
      } catch (e) {
        console.error(e);
      }
    }
    input.remove();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
    if (e.key === 'Escape') input.remove();
  });

  input.addEventListener('blur', () => {
    setTimeout(() => input.remove(), 100);
  });

  container.parentElement.insertBefore(input, container.nextSibling);
  input.focus();
}

function connectSSE() {
  if (eventSource) eventSource.close();

  eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.addEventListener('connected', () => {
    console.log('SSE connected');
  });

  eventSource.addEventListener('card-created', (e) => {
    const { card } = JSON.parse(e.data);
    addCardToState(card);
    renderBoard();
  });

  eventSource.addEventListener('card-moved', (e) => {
    const { card } = JSON.parse(e.data);
    reconcileCardMove(card);
    renderBoard();
  });

  eventSource.addEventListener('board-update', (e) => {
    const { columns } = JSON.parse(e.data);
    boardState = columns;
    renderBoard();
  });

  eventSource.onerror = (err) => {
    console.error('SSE error', err);
    // Attempt reconnect after delay
    setTimeout(() => {
      if (eventSource) connectSSE();
    }, 3000);
  };
}

function addCardToState(card) {
  const col = boardState.find(c => c.id === card.column_id);
  if (col) {
    // Avoid duplicates
    if (!col.cards.find(c => c.id === card.id)) {
      col.cards.push(card);
      // Keep sorted? but since new at end, ok
      col.cards.sort((a,b) => a.position - b.position);
    }
  }
}

function reconcileCardMove(serverCard) {
  // Remove card from all columns first (to handle cross column and prevent dup)
  boardState.forEach(col => {
    col.cards = col.cards.filter(c => c.id !== serverCard.id);
  });

  // Add to correct column
  const targetCol = boardState.find(c => c.id === serverCard.column_id);
  if (targetCol) {
    targetCol.cards.push(serverCard);
    targetCol.cards.sort((a, b) => a.position - b.position);
  }
}

function init() {
  fetchBoard().then(() => {
    connectSSE();
  });

  // Optional: refresh on focus to reconcile
  window.addEventListener('focus', () => {
    fetchBoard();
  });
}

init();