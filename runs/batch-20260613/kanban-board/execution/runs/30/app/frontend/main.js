const API_BASE = '/api';
const boardEl = document.getElementById('board');
let columns = [];
let eventSource = null;

async function fetchBoard() {
  const res = await fetch(`${API_BASE}/board`);
  const data = await res.json();
  columns = data.columns;
  renderBoard();
}

function renderBoard() {
  boardEl.innerHTML = '';
  columns.forEach(column => {
    const colEl = createColumnElement(column);
    boardEl.appendChild(colEl);
  });
}

function createColumnElement(column) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = column.id;

  colEl.innerHTML = `
    <div class="column-header">${column.title}</div>
    <div class="cards" data-column-id="${column.id}"></div>
    <button class="add-card">+ Add Card</button>
  `;

  const cardsContainer = colEl.querySelector('.cards');
  const addBtn = colEl.querySelector('.add-card');

  // Render cards
  column.cards.forEach(card => {
    const cardEl = createCardElement(card, column.id);
    cardsContainer.appendChild(cardEl);
  });

  // Add card handler
  addBtn.addEventListener('click', async () => {
    const text = prompt('Card text:');
    if (!text) return;
    await createCard(column.id, text);
  });

  // Setup drag and drop for the column
  setupDragAndDrop(cardsContainer, column.id);

  return colEl;
}

function createCardElement(card, columnId) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.dataset.cardId = card.id;
  cardEl.draggable = true;
  cardEl.textContent = card.text;

  cardEl.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', card.id);
    cardEl.classList.add('dragging');
  });

  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('dragging');
  });

  return cardEl;
}

function setupDragAndDrop(container, columnId) {
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
    const cards = Array.from(container.children);
    const dropY = e.clientY;

    // Find position to insert
    let beforeId = null;
    let afterId = null;

    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      if (dropY < rect.top + rect.height / 2) {
        beforeId = cards[i].dataset.cardId;
        afterId = i > 0 ? cards[i - 1].dataset.cardId : null;
        break;
      }
      afterId = cards[i].dataset.cardId;
    }

    // Optimistic update
    const cardEl = document.querySelector(`[data-card-id="${cardId}"]`);
    if (cardEl) {
      const oldContainer = cardEl.parentElement;
      if (oldContainer !== container) {
        container.appendChild(cardEl); // simplistic optimistic
      }
    }

    // Send move request
    try {
      await moveCard(cardId, columnId, beforeId, afterId);
    } catch (err) {
      console.error('Move failed, will reconcile on next update', err);
      // Re-fetch to reconcile
      await fetchBoard();
    }
  });
}

async function createCard(columnId, text) {
  const res = await fetch(`${API_BASE}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text })
  });
  if (!res.ok) {
    alert('Failed to create card');
  }
}

async function moveCard(cardId, columnId, beforeId, afterId) {
  const res = await fetch(`${API_BASE}/cards/${cardId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, beforeId, afterId })
  });
  if (!res.ok) {
    throw new Error('Move failed');
  }
  return res.json();
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
    // Reconnect logic could be added
  };
}

function handleServerUpdate(data) {
  if (data.type === 'card-created' || data.type === 'card-moved') {
    // Re-fetch board for simplicity and correctness
    fetchBoard();
  } else if (data.type === 'column-renormalized') {
    fetchBoard();
  }
}

async function init() {
  await fetchBoard();
  connectSSE();
}

init();