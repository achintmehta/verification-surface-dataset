const boardEl = document.getElementById('board');
let boardState = [];

async function fetchBoard() {
  const res = await fetch('/api/board');
  boardState = await res.json();
  renderBoard();
}

function renderBoard() {
  boardEl.innerHTML = '';
  boardState.forEach(column => {
    const colEl = document.createElement('div');
    colEl.className = 'column';
    colEl.dataset.columnId = column.id;

    colEl.innerHTML = `
      <h2>${column.title}</h2>
      <div class="cards"></div>
      <button class="add-card">+ Add Card</button>
    `;

    const cardsEl = colEl.querySelector('.cards');
    column.cards.forEach(card => {
      const cardEl = createCardElement(card, column.id);
      cardsEl.appendChild(cardEl);
    });

    // Add card handler
    colEl.querySelector('.add-card').addEventListener('click', async () => {
      const text = prompt('Card text:');
      if (text) {
        await fetch('/api/cards', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId: column.id, text })
        });
        // Will be added via SSE or refetch, but for now refetch
        await fetchBoard();
      }
    });

    setupDropZone(cardsEl, column.id);
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
    e.dataTransfer.setData('text/plain', card.id);
    cardEl.classList.add('dragging');
  });

  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('dragging');
  });

  return cardEl;
}

function setupDropZone(cardsEl, columnId) {
  cardsEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    cardsEl.style.background = '#f9f9f9';
  });

  cardsEl.addEventListener('dragleave', () => {
    cardsEl.style.background = '';
  });

  cardsEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    cardsEl.style.background = '';
    const cardId = e.dataTransfer.getData('text/plain');

    // Determine beforeId and afterId for server
    let beforeId = null, afterId = null;
    const dropY = e.clientY;
    let inserted = false;
    const children = Array.from(cardsEl.children);
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const childRect = child.getBoundingClientRect();
      if (dropY < childRect.top + childRect.height / 2) {
        beforeId = child.dataset.cardId;
        afterId = i > 0 ? children[i-1].dataset.cardId : null;
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      afterId = children.length > 0 ? children[children.length-1].dataset.cardId : null;
    }

    // Optimistic update
    optimisticMove(cardId, columnId, beforeId, afterId);

    // Send to server
    try {
      await fetch(`/api/cards/${cardId}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId, beforeId, afterId })
      });
    } catch (err) {
      console.error(err);
      // On error, refetch
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

function optimisticMove(cardId, newColumnId, beforeId, afterId) {
  // Find card in current state
  let foundCard = null;
  let oldColIdx = -1, cardIdx = -1;
  for (let c = 0; c < boardState.length; c++) {
    const idx = boardState[c].cards.findIndex(card => card.id === cardId);
    if (idx !== -1) {
      foundCard = boardState[c].cards[idx];
      oldColIdx = c;
      cardIdx = idx;
      break;
    }
  }
  if (!foundCard) return;

  // Remove from old
  boardState[oldColIdx].cards.splice(cardIdx, 1);

  // Find new column
  const newColIdx = boardState.findIndex(col => col.id === newColumnId);
  if (newColIdx === -1) return;

  // Insert at position
  let insertIdx = boardState[newColIdx].cards.length;
  if (beforeId) {
    const bIdx = boardState[newColIdx].cards.findIndex(c => c.id === beforeId);
    if (bIdx !== -1) insertIdx = bIdx;
  } else if (afterId) {
    const aIdx = boardState[newColIdx].cards.findIndex(c => c.id === afterId);
    if (aIdx !== -1) insertIdx = aIdx + 1;
  }
  boardState[newColIdx].cards.splice(insertIdx, 0, { ...foundCard, column_id: newColumnId });

  renderBoard();
}

function setupSSE() {
  const eventSource = new EventSource('/api/stream');

  eventSource.addEventListener('card-created', (e) => {
    fetchBoard();
  });

  eventSource.addEventListener('card-moved', (e) => {
    fetchBoard();
  });

  // On error or to ensure sync, perhaps periodic refetch, but for demo ok.
  eventSource.onerror = () => {
    console.log('SSE error, will reconnect?');
  };
}

function init() {
  fetchBoard().then(() => {
    setupSSE();
  });
}

init();