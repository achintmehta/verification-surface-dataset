const API_BASE = '/api';
let boardState = { columns: [] };
let eventSource = null;

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
    const colEl = document.createElement('div');
    colEl.className = 'column';
    colEl.dataset.columnId = column.id;

    colEl.innerHTML = `
      <h2>${column.title}</h2>
      <div class="cards" data-column-id="${column.id}"></div>
    `;

    const cardsContainer = colEl.querySelector('.cards');
    setupDropZone(cardsContainer);

    column.cards.forEach(card => {
      const cardEl = createCardElement(card, column.id);
      cardsContainer.appendChild(cardEl);
    });

    boardEl.appendChild(colEl);
  });
}

function createCardElement(card, columnId) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.dataset.cardId = card.id;
  cardEl.dataset.columnId = columnId;
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

function setupDropZone(container) {
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    container.style.background = '#f0f0f0';
  });

  container.addEventListener('dragleave', () => {
    container.style.background = '';
  });

  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    container.style.background = '';

    const cardId = e.dataTransfer.getData('text/plain');
    const targetColumnId = container.dataset.columnId;

    // Optimistic update
    moveCardOptimistic(cardId, targetColumnId, null, null);

    // Determine before/after based on drop position
    const rect = container.getBoundingClientRect();
    const mouseY = e.clientY;
    let beforeId = null;
    let afterId = null;

    const cards = Array.from(container.children);
    let inserted = false;

    for (let i = 0; i < cards.length; i++) {
      const cardRect = cards[i].getBoundingClientRect();
      if (mouseY < cardRect.top + cardRect.height / 2) {
        beforeId = cards[i].dataset.cardId;
        if (i > 0) afterId = cards[i - 1].dataset.cardId;
        inserted = true;
        break;
      }
    }

    if (!inserted && cards.length > 0) {
      afterId = cards[cards.length - 1].dataset.cardId;
    }

    // Send to server
    try {
      await fetch(`${API_BASE}/cards/${cardId}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId: targetColumnId, beforeId, afterId })
      });
    } catch (err) {
      console.error('Move failed, will reconcile on SSE or reload');
    }
  });
}

function moveCardOptimistic(cardId, newColumnId, beforeId, afterId) {
  // Find current location
  let sourceCol, sourceIdx, cardData;
  for (const col of boardState.columns) {
    const idx = col.cards.findIndex(c => c.id === cardId);
    if (idx !== -1) {
      sourceCol = col;
      sourceIdx = idx;
      cardData = col.cards[idx];
      break;
    }
  }

  if (!cardData) return;

  // Remove from source
  sourceCol.cards.splice(sourceIdx, 1);

  // Find target column
  const targetCol = boardState.columns.find(c => c.id === newColumnId);
  if (!targetCol) return;

  // Insert optimistically (simple append for now, or try to find positions)
  let insertIdx = targetCol.cards.length;
  if (beforeId) {
    const bIdx = targetCol.cards.findIndex(c => c.id === beforeId);
    if (bIdx !== -1) insertIdx = bIdx;
  } else if (afterId) {
    const aIdx = targetCol.cards.findIndex(c => c.id === afterId);
    if (aIdx !== -1) insertIdx = aIdx + 1;
  }

  targetCol.cards.splice(insertIdx, 0, { ...cardData, column_id: newColumnId });

  renderBoard();
}

function setupCreateCard() {
  const btn = document.getElementById('create-btn');
  const textInput = document.getElementById('new-card-text');
  const colSelect = document.getElementById('new-card-column');

  btn.addEventListener('click', async () => {
    const text = textInput.value.trim();
    const columnId = colSelect.value;
    if (!text) return;

    try {
      const res = await fetch(`${API_BASE}/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId, text })
      });
      const card = await res.json();
      // Optimistic already handled by SSE, but we can add if needed
      textInput.value = '';
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
    // Find column and add if not present
    const col = boardState.columns.find(c => c.id === columnId);
    if (col && !col.cards.find(c => c.id === card.id)) {
      col.cards.push(card);
      renderBoard();
    }
  });

  eventSource.addEventListener('card-moved', (e) => {
    const { card, columnId } = JSON.parse(e.data);
    // Remove card from all columns
    boardState.columns.forEach(col => {
      col.cards = col.cards.filter(c => c.id !== card.id);
    });

    // Add to correct column
    const targetCol = boardState.columns.find(c => c.id === columnId || c.id === card.column_id);
    if (targetCol) {
      // Insert at correct position? For simplicity, append and re-render; server order is in fetch but here we maintain
      targetCol.cards.push(card);
      // To keep order, better to re-sort but since positions, we can leave or sort by pos
      targetCol.cards.sort((a, b) => a.position - b.position);
    }
    renderBoard();
  });

  eventSource.onerror = () => {
    console.log('SSE error, reconnecting...');
    setTimeout(connectSSE, 3000);
  };
}

async function init() {
  await fetchBoard();
  setupCreateCard();
  connectSSE();
}

init();