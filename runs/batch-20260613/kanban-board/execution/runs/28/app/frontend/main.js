const API_BASE = 'http://localhost:3000/api';
const boardEl = document.getElementById('board');
const addBtn = document.getElementById('add-card-btn');
const newCardText = document.getElementById('new-card-text');
const newCardColumn = document.getElementById('new-card-column');

let boardState = { columns: [] };
let eventSource = null;

async function fetchBoard() {
  const res = await fetch(`${API_BASE}/board`);
  boardState = await res.json();
  renderBoard();
}

function renderBoard() {
  boardEl.innerHTML = '';
  boardState.columns.forEach(column => {
    const colEl = document.createElement('div');
    colEl.className = 'column';
    colEl.dataset.columnId = column.id;

    colEl.innerHTML = `
      <h2>${column.title}</h2>
      <div class="cards" data-column-id="${column.id}"></div>
    `;

    const cardsContainer = colEl.querySelector('.cards');
    column.cards.forEach(card => {
      const cardEl = createCardElement(card);
      cardsContainer.appendChild(cardEl);
    });

    setupDropZone(cardsContainer, column.id);
    boardEl.appendChild(colEl);
  });
}

function createCardElement(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.draggable = true;
  cardEl.dataset.cardId = card.id;
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
    const draggedCard = document.querySelector(`[data-card-id="${cardId}"]`);
    if (!draggedCard) return;

    // Optimistic update: move in DOM
    const targetCards = Array.from(container.children);
    let beforeId = null;
    let afterId = null;

    // Find insertion point based on mouse position
    const dropY = e.clientY;
    let inserted = false;

    for (let i = 0; i < targetCards.length; i++) {
      const rect = targetCards[i].getBoundingClientRect();
      if (dropY < rect.top + rect.height / 2) {
        beforeId = targetCards[i].dataset.cardId;
        afterId = i > 0 ? targetCards[i-1].dataset.cardId : null;
        container.insertBefore(draggedCard, targetCards[i]);
        inserted = true;
        break;
      }
    }

    if (!inserted) {
      // append to end
      container.appendChild(draggedCard);
      afterId = targetCards.length > 0 ? targetCards[targetCards.length-1].dataset.cardId : null;
      beforeId = null;
    }

    // Send to server
    try {
      const res = await fetch(`${API_BASE}/cards/${cardId}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId, beforeId, afterId })
      });
      if (!res.ok) {
        // Revert on failure? For simplicity, refetch
        await fetchBoard();
      }
    } catch (err) {
      console.error(err);
      await fetchBoard();
    }
  });
}

async function addCard() {
  const text = newCardText.value.trim();
  const columnId = newCardColumn.value;
  if (!text) return;

  try {
    const res = await fetch(`${API_BASE}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text })
    });
    if (res.ok) {
      newCardText.value = '';
      // Optimistic? But SSE will handle, or fetch
      // For now, rely on SSE or refetch
    }
  } catch (err) {
    console.error(err);
  }
}

function connectSSE() {
  if (eventSource) eventSource.close();

  eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.addEventListener('connected', () => {
    console.log('SSE connected');
  });

  eventSource.addEventListener('card-created', (e) => {
    const data = JSON.parse(e.data);
    handleCardCreated(data);
  });

  eventSource.addEventListener('card-moved', (e) => {
    const data = JSON.parse(e.data);
    handleCardMoved(data);
  });

  eventSource.onerror = () => {
    console.log('SSE error, reconnecting...');
    setTimeout(connectSSE, 3000);
  };
}

function handleCardCreated(data) {
  const { card, columnId } = data;
  // Find column and add card if not present
  const colContainer = document.querySelector(`.cards[data-column-id="${columnId}"]`);
  if (colContainer && !document.querySelector(`[data-card-id="${card.id}"]`)) {
    const cardEl = createCardElement(card);
    colContainer.appendChild(cardEl);
    setupDropZoneForCard(cardEl); // if needed
  }
  // Update state
  const col = boardState.columns.find(c => c.id === columnId);
  if (col && !col.cards.find(c => c.id === card.id)) {
    col.cards.push(card);
  }
}

function handleCardMoved(data) {
  const { card, columnId } = data;
  // Remove card from all places
  document.querySelectorAll(`[data-card-id="${card.id}"]`).forEach(el => el.remove());

  // Add to correct column at correct position? For simplicity, append and rely on re-render for order
  // Better: refetch for canonical, but to keep optimistic, insert properly
  const colContainer = document.querySelector(`.cards[data-column-id="${columnId}"]`);
  if (colContainer) {
    const cardEl = createCardElement(card);
    // For now, append; full order reconciliation on reload or better impl
    colContainer.appendChild(cardEl);
  }

  // Update internal state by refetching to ensure order
  fetchBoard();
}

function setupDropZoneForCard(cardEl) {
  // Cards themselves can be drop targets for reordering, but container handles it
}

addBtn.addEventListener('click', addCard);
newCardText.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') addCard();
});

// Initial load
fetchBoard().then(() => {
  connectSSE();
});