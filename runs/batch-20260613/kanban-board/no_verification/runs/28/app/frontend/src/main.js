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
    const targetColumn = document.querySelector(`.column[data-column-id="${columnId}"] .cards`);
    if (targetColumn && draggedCard.parentNode !== targetColumn) {
      targetColumn.appendChild(draggedCard);
    }

    // Determine before/after based on drop position
    const afterElements = Array.from(targetColumn.children);
    let beforeId = null;
    let afterId = null;

    // Simple: append to end for now, but better logic
    const rect = targetColumn.getBoundingClientRect();
    const dropY = e.clientY;

    let inserted = false;
    for (let i = 0; i < afterElements.length; i++) {
      const elRect = afterElements[i].getBoundingClientRect();
      if (dropY < elRect.top + elRect.height / 2) {
        if (afterElements[i].dataset.cardId !== cardId) {
          beforeId = afterElements[i].dataset.cardId;
          if (i > 0) afterId = afterElements[i-1].dataset.cardId;
        }
        targetColumn.insertBefore(draggedCard, afterElements[i]);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      afterId = afterElements.length > 0 ? afterElements[afterElements.length-1].dataset.cardId : null;
      targetColumn.appendChild(draggedCard);
    }

    // Send to server
    try {
      await fetch(`${API_BASE}/cards/${cardId}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId, beforeId, afterId })
      });
    } catch (err) {
      console.error('Move failed, will reconcile on SSE or reload');
    }
  });
}

function setupCreateCard() {
  const btn = document.getElementById('create-btn');
  const input = document.getElementById('new-card-text');
  const select = document.getElementById('new-card-column');

  btn.addEventListener('click', async () => {
    const text = input.value.trim();
    const columnId = select.value;
    if (!text) return;

    try {
      const res = await fetch(`${API_BASE}/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId, text })
      });
      if (res.ok) {
        input.value = '';
        // Optimistic? But SSE will handle, or fetch again
      }
    } catch (err) {
      console.error(err);
    }
  });
}

function connectSSE() {
  if (eventSource) eventSource.close();

  eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.addEventListener('card-created', (e) => {
    const { card, columnId } = JSON.parse(e.data);
    updateCardFromServer(card, columnId);
  });

  eventSource.addEventListener('card-moved', (e) => {
    const { card, columnId } = JSON.parse(e.data);
    updateCardFromServer(card, columnId);
  });

  eventSource.onerror = () => {
    console.log('SSE error, reconnecting...');
    setTimeout(connectSSE, 3000);
  };
}

function updateCardFromServer(card, targetColumnId) {
  // Remove card from anywhere it might be
  const existing = document.querySelector(`[data-card-id="${card.id}"]`);
  if (existing) existing.remove();

  // Find target column container
  const targetContainer = document.querySelector(
    `.column[data-column-id="${targetColumnId}"] .cards`
  );
  if (!targetContainer) {
    // Refresh full board if column not found
    fetchBoard();
    return;
  }

  // Insert at correct position based on server position
  const cardEl = createCardElement(card);
  const siblings = Array.from(targetContainer.children);

  let inserted = false;
  for (let i = 0; i < siblings.length; i++) {
    // We don't have positions in DOM, so append or use server state
    // For simplicity, since we have full state? Better to re-render affected column
  }

  // To make accurate, let's update local state and re-render column
  // But for efficiency, since small, re-fetch or update state
  // Simplest reliable: update boardState and re-render
  updateLocalStateAndRender(card, targetColumnId);
}

function updateLocalStateAndRender(card, targetColumnId) {
  // Update boardState
  boardState.forEach(col => {
    col.cards = col.cards.filter(c => c.id !== card.id);
  });

  const targetCol = boardState.find(c => c.id === targetColumnId);
  if (targetCol) {
    targetCol.cards.push(card);
    // Sort by position
    targetCol.cards.sort((a, b) => a.position - b.position);
  }

  // Re-render only the affected columns? For simplicity re-render all
  renderBoard();
}

function init() {
  fetchBoard();
  setupCreateCard();
  connectSSE();
}

init();