const boardEl = document.getElementById('board');
let boardState = []; // {id, title, position, cards: [...]}

async function loadBoard() {
  const res = await fetch('/api/board');
  boardState = await res.json();
  renderBoard();
}

function renderBoard() {
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
    <div class="column-header">
      <span>${column.title}</span>
      <span class="card-count">${column.cards.length}</span>
    </div>
    <div class="cards column-dropzone" data-column-id="${column.id}"></div>
    <button class="add-card">+ Add card</button>
  `;

  const cardsContainer = colEl.querySelector('.cards');
  column.cards.forEach(card => {
    const cardEl = createCardElement(card);
    cardsContainer.appendChild(cardEl);
  });

  // Add card handler
  colEl.querySelector('.add-card').addEventListener('click', async () => {
    const text = prompt('Card text:');
    if (!text) return;
    const res = await fetch('/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId: column.id, text })
    });
    if (res.ok) {
      // Will be added via SSE or reload
    }
  });

  setupDropzone(cardsContainer, column.id);
  return colEl;
}

function createCardElement(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.draggable = true;
  cardEl.dataset.cardId = card.id;
  cardEl.dataset.columnId = card.column_id;
  cardEl.innerHTML = `<div>${card.text}</div>`;

  cardEl.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', card.id);
    cardEl.classList.add('dragging');
    // Store source column for cross-column
    sessionStorage.setItem('dragSourceColumn', card.column_id);
  });

  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('dragging');
    document.querySelectorAll('.card').forEach(c => c.classList.remove('over'));
  });

  // For optimistic, but since drop handles
  return cardEl;
}

function setupDropzone(container, columnId) {
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
    const sourceColumn = sessionStorage.getItem('dragSourceColumn');

    // Find drop position: determine before/after based on mouse or siblings
    const afterEl = getAfterElement(container, e.clientY);
    const beforeId = afterEl ? afterEl.dataset.cardId : null;
    let afterId = null;

    if (afterEl) {
      // find previous sibling
      const prev = afterEl.previousElementSibling;
      afterId = prev ? prev.dataset.cardId : null;
    } else {
      // dropped at end, find last
      const last = container.lastElementChild;
      afterId = last ? last.dataset.cardId : null;
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
      console.error('Move failed, will reconcile via SSE');
    }
  });

  // Allow dropping on cards too? But for simplicity, dropzone handles, but to make better, add listeners to cards
  // For now, basic works if drop on container.
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
  }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
}

function optimisticMove(cardId, newColumnId, beforeId, afterId) {
  // Find card in state
  let foundCard = null;
  let oldCol = null;
  boardState.forEach(col => {
    const idx = col.cards.findIndex(c => c.id === cardId);
    if (idx !== -1) {
      foundCard = col.cards.splice(idx, 1)[0];
      oldCol = col;
    }
  });
  if (!foundCard) return;

  foundCard.column_id = newColumnId;

  // Insert into new column
  const newCol = boardState.find(c => c.id === newColumnId);
  if (!newCol) return;

  if (beforeId) {
    const beforeIdx = newCol.cards.findIndex(c => c.id === beforeId);
    if (beforeIdx !== -1) {
      newCol.cards.splice(beforeIdx, 0, foundCard);
    } else {
      newCol.cards.push(foundCard);
    }
  } else if (afterId) {
    const afterIdx = newCol.cards.findIndex(c => c.id === afterId);
    if (afterIdx !== -1) {
      newCol.cards.splice(afterIdx + 1, 0, foundCard);
    } else {
      newCol.cards.push(foundCard);
    }
  } else {
    newCol.cards.push(foundCard);
  }

  renderBoard();
}

function setupSSE() {
  const eventSource = new EventSource('/api/stream');

  eventSource.addEventListener('card-created', (e) => {
    const { card } = JSON.parse(e.data);
    // Add to state
    const col = boardState.find(c => c.id === card.column_id);
    if (col) {
      col.cards.push(card);
      // re-sort? assume at end
      col.cards.sort((a,b) => a.position - b.position);
      renderBoard();
    }
  });

  eventSource.addEventListener('card-moved', (e) => {
    const { card, oldColumnId } = JSON.parse(e.data);
    // Remove from old if present, add/update in new
    boardState.forEach(col => {
      col.cards = col.cards.filter(c => c.id !== card.id);
    });
    const newCol = boardState.find(c => c.id === card.column_id);
    if (newCol) {
      newCol.cards.push(card);
      newCol.cards.sort((a,b) => a.position - b.position);
    }
    renderBoard();
  });

  eventSource.onerror = () => {
    console.log('SSE error, reconnecting...');
  };
}

function setupGlobalDrag() {
  // Make sure cards can be dragged over other cards for better UX
  document.addEventListener('dragover', (e) => {
    if (e.target.classList.contains('card')) {
      e.preventDefault();
    }
  });

  document.addEventListener('drop', (e) => {
    if (e.target.classList.contains('card')) {
      // delegate to parent dropzone logic? For simplicity, user can drop near
      const container = e.target.parentElement;
      // trigger similar
    }
  });
}

async function init() {
  await loadBoard();
  setupSSE();
  setupGlobalDrag();
}

init();
