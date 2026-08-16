const API_BASE = 'http://localhost:3000/api';
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

  const columnSelect = document.getElementById('column-select');
  columnSelect.innerHTML = '';

  boardState.forEach(column => {
    // Column element
    const colEl = document.createElement('div');
    colEl.className = 'column';
    colEl.dataset.columnId = column.id;

    colEl.innerHTML = `
      <div class="column-header">${column.title}</div>
      <div class="cards" data-column-id="${column.id}"></div>
    `;

    const cardsContainer = colEl.querySelector('.cards');
    setupDropZone(cardsContainer, column.id);

    column.cards.forEach(card => {
      const cardEl = createCardElement(card, column.id);
      cardsContainer.appendChild(cardEl);
    });

    boardEl.appendChild(colEl);

    // For select
    const option = document.createElement('option');
    option.value = column.id;
    option.textContent = column.title;
    columnSelect.appendChild(option);
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
    const draggedCard = document.querySelector(`[data-card-id="${cardId}"]`);
    if (!draggedCard) return;

    // Optimistic update: move in DOM
    const originalColumn = draggedCard.parentElement;
    const originalColumnId = draggedCard.dataset.columnId;

    // Find position: insert before/after based on mouse
    const afterElement = getDragAfterElement(container, e.clientY);
    let beforeId = null;
    let afterId = null;

    if (afterElement) {
      beforeId = afterElement.dataset.cardId;
    } else {
      // append at end, afterId would be last if any
      const children = Array.from(container.children);
      if (children.length > 0) {
        afterId = children[children.length - 1].dataset.cardId;
      }
    }

    // Optimistic DOM move
    if (afterElement) {
      container.insertBefore(draggedCard, afterElement);
    } else {
      container.appendChild(draggedCard);
    }
    draggedCard.dataset.columnId = columnId;

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

function setupAddCard() {
  const btn = document.getElementById('add-card-btn');
  const input = document.getElementById('new-card-text');
  const select = document.getElementById('column-select');

  btn.addEventListener('click', async () => {
    const text = input.value.trim();
    const columnId = select.value;
    if (!text || !columnId) return;

    try {
      const res = await fetch(`${API_BASE}/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId, text })
      });
      if (res.ok) {
        input.value = '';
        // Will be added via SSE or refetch
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
    const { card } = JSON.parse(e.data);
    // Find column and add card if not present
    updateCardInDOM(card, card.column_id);
  });

  eventSource.addEventListener('card-moved', (e) => {
    const { card, columnId } = JSON.parse(e.data);
    updateCardInDOM(card, columnId);
  });

  eventSource.onerror = () => {
    console.log('SSE error, reconnecting...');
    setTimeout(connectSSE, 3000);
  };
}

function updateCardInDOM(card, targetColumnId) {
  // Remove card from anywhere it exists
  const existing = document.querySelector(`[data-card-id="${card.id}"]`);
  if (existing) existing.remove();

  // Find target column container
  const targetContainer = document.querySelector(`.cards[data-column-id="${targetColumnId}"]`);
  if (!targetContainer) {
    // Refetch if column not found (e.g. state change)
    fetchBoard();
    return;
  }

  // Insert at correct position based on card.position
  const cardEl = createCardElement(card, targetColumnId);
  const siblings = Array.from(targetContainer.children);
  let inserted = false;

  for (let sibling of siblings) {
    // We need positions, but since DOM may not have, better to re-render or use data
    // For simplicity, append and rely on server order, or sort later
  }

  // Simple append for now, or better: re-render whole board on updates for correctness
  // To satisfy acceptance, let's refetch and render on updates for canonical state
  fetchBoard();
}

function init() {
  fetchBoard();
  setupAddCard();
  connectSSE();
}

init();