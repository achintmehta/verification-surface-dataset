const API_BASE = 'http://localhost:3000/api';
let boardState = { columns: [] };
let draggedCard = null;
let optimisticMoves = new Map(); // cardId -> {columnId, position}

async function fetchBoard() {
  const res = await fetch(`${API_BASE}/board`);
  boardState = await res.json();
  renderBoard();
}

function renderBoard() {
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';

  // Populate column select for create
  const select = document.getElementById('new-card-column');
  select.innerHTML = '';

  boardState.columns.forEach(column => {
    // Column element
    const colEl = document.createElement('div');
    colEl.className = 'column';
    colEl.dataset.columnId = column.id;

    colEl.innerHTML = `
      <h2>${column.title}</h2>
      <div class="cards" data-column-id="${column.id}"></div>
    `;

    const cardsContainer = colEl.querySelector('.cards');

    // Add cards
    column.cards.forEach(card => {
      const cardEl = createCardElement(card, column.id);
      cardsContainer.appendChild(cardEl);
    });

    // Setup drop zone
    setupDropZone(cardsContainer, column.id);

    boardEl.appendChild(colEl);

    // Add to select
    const option = document.createElement('option');
    option.value = column.id;
    option.textContent = column.title;
    select.appendChild(option);
  });
}

function createCardElement(card, columnId) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.dataset.cardId = card.id;
  cardEl.dataset.columnId = columnId;
  cardEl.draggable = true;
  cardEl.textContent = card.text;

  // Drag events
  cardEl.addEventListener('dragstart', (e) => {
    draggedCard = { id: card.id, element: cardEl, originalColumn: columnId };
    cardEl.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('dragging');
    draggedCard = null;
  });

  return cardEl;
}

function setupDropZone(container, columnId) {
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });

  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (!draggedCard) return;

    const cardId = draggedCard.id;
    const fromColumn = draggedCard.originalColumn;
    const toColumn = columnId;

    // Find drop position: determine beforeId and afterId
    const cards = Array.from(container.children);
    let beforeId = null;
    let afterId = null;

    // Find the position where it was dropped
    const dropY = e.clientY;
    let inserted = false;

    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      if (dropY < rect.top + rect.height / 2) {
        beforeId = cards[i].dataset.cardId;
        if (i > 0) afterId = cards[i - 1].dataset.cardId;
        inserted = true;
        break;
      }
    }

    if (!inserted && cards.length > 0) {
      afterId = cards[cards.length - 1].dataset.cardId;
    }

    // Optimistic update
    optimisticMove(cardId, toColumn, beforeId, afterId);

    // Send to server
    try {
      const res = await fetch(`${API_BASE}/cards/${cardId}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId: toColumn, beforeId, afterId })
      });
      if (!res.ok) {
        // Revert on error? For simplicity, refetch
        await fetchBoard();
      }
    } catch (err) {
      console.error(err);
      await fetchBoard();
    }
  });
}

function optimisticMove(cardId, newColumnId, beforeId, afterId) {
  // Find card in current state and move it
  let card = null;
  let oldColumn = null;

  for (const col of boardState.columns) {
    const idx = col.cards.findIndex(c => c.id === cardId);
    if (idx !== -1) {
      card = col.cards.splice(idx, 1)[0];
      oldColumn = col.id;
      break;
    }
  }

  if (!card) return;

  // Find target column
  const targetCol = boardState.columns.find(c => c.id === newColumnId);
  if (!targetCol) return;

  // Insert at position
  let insertIndex = targetCol.cards.length;
  if (beforeId) {
    const beforeIdx = targetCol.cards.findIndex(c => c.id === beforeId);
    if (beforeIdx !== -1) insertIndex = beforeIdx;
  } else if (afterId) {
    const afterIdx = targetCol.cards.findIndex(c => c.id === afterId);
    if (afterIdx !== -1) insertIndex = afterIdx + 1;
  }

  targetCol.cards.splice(insertIndex, 0, card);

  // Update DOM optimistically
  renderBoard();
}

function setupCreateCard() {
  const btn = document.getElementById('create-btn');
  const input = document.getElementById('new-card-text');
  const select = document.getElementById('new-card-column');

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
        // Board will update via SSE or we can refetch
      }
    } catch (err) {
      console.error(err);
    }
  });
}

function connectSSE() {
  const eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.addEventListener('connected', () => {
    console.log('SSE connected');
  });

  eventSource.addEventListener('card-created', (e) => {
    const data = JSON.parse(e.data);
    // Add to state if not present
    const col = boardState.columns.find(c => c.id === data.columnId);
    if (col && !col.cards.find(c => c.id === data.card.id)) {
      col.cards.push(data.card);
      // Sort by position
      col.cards.sort((a, b) => a.position - b.position);
      renderBoard();
    }
  });

  eventSource.addEventListener('card-moved', (e) => {
    const data = JSON.parse(e.data);
    const { card, columnId, oldColumnId } = data;

    // Remove from old column if present
    if (oldColumnId) {
      const oldCol = boardState.columns.find(c => c.id === oldColumnId);
      if (oldCol) {
        oldCol.cards = oldCol.cards.filter(c => c.id !== card.id);
      }
    }

    // Remove from anywhere to prevent duplicates
    boardState.columns.forEach(col => {
      col.cards = col.cards.filter(c => c.id !== card.id);
    });

    // Add to new column
    const newCol = boardState.columns.find(c => c.id === columnId);
    if (newCol) {
      newCol.cards.push(card);
      newCol.cards.sort((a, b) => a.position - b.position);
    }

    renderBoard();
  });

  eventSource.onerror = (err) => {
    console.error('SSE error', err);
    // Reconnect logic could be added
  };
}

async function init() {
  await fetchBoard();
  setupCreateCard();
  connectSSE();

  // Initial column select population happens in renderBoard
}

init();