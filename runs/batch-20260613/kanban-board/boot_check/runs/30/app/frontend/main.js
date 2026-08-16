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
    <button class="add-card">+ Add card</button>
  `;

  const cardsContainer = colEl.querySelector('.cards');
  column.cards.forEach(card => {
    const cardEl = createCardElement(card);
    cardsContainer.appendChild(cardEl);
  });

  // Add card handler
  const addBtn = colEl.querySelector('.add-card');
  addBtn.addEventListener('click', () => {
    const input = document.createElement('input');
    input.className = 'new-card';
    input.placeholder = 'Card text...';
    addBtn.replaceWith(input);
    input.focus();

    const submit = async () => {
      const text = input.value.trim();
      if (text) {
        await createCard(column.id, text);
      }
      input.replaceWith(addBtn);
    };

    input.addEventListener('blur', submit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') input.replaceWith(addBtn);
    });
  });

  // Drag and drop setup
  setupDragAndDrop(cardsContainer, column.id);

  return colEl;
}

function createCardElement(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.draggable = true;
  cardEl.dataset.cardId = card.id;
  cardEl.textContent = card.text;

  cardEl.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/plain', card.id);
    cardEl.classList.add('dragging');
  });

  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('dragging');
  });

  return cardEl;
}

function setupDragAndDrop(container, columnId) {
  container.addEventListener('dragover', e => {
    e.preventDefault();
    const dragging = document.querySelector('.dragging');
    if (!dragging) return;

    const afterElement = getDragAfterElement(container, e.clientY);
    if (afterElement) {
      container.insertBefore(dragging, afterElement);
    } else {
      container.appendChild(dragging);
    }
  });

  container.addEventListener('drop', async e => {
    e.preventDefault();
    const cardId = e.dataTransfer.getData('text/plain');
    const cards = Array.from(container.children);
    const cardIndex = cards.findIndex(c => c.dataset.cardId === cardId);

    let beforeId = null;
    let afterId = null;

    if (cardIndex > 0) {
      afterId = cards[cardIndex - 1].dataset.cardId;
    }
    if (cardIndex < cards.length - 1) {
      beforeId = cards[cardIndex + 1].dataset.cardId;
    }

    // Optimistic update already done via dragover
    // Send to server
    try {
      await fetch(`${API_BASE}/cards/${cardId}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId, beforeId, afterId })
      });
    } catch (err) {
      console.error('Move failed, will reconcile on SSE', err);
      // Re-fetch to reconcile
      await fetchBoard();
    }
  });

  // Also allow dropping on column background
  const column = container.parentElement;
  column.addEventListener('dragover', e => {
    e.preventDefault();
  });

  column.addEventListener('drop', async e => {
    if (e.target === container) return; // handled by container
    e.preventDefault();
    const cardId = e.dataTransfer.getData('text/plain');
    // Move to end of column
    try {
      await fetch(`${API_BASE}/cards/${cardId}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId, beforeId: null, afterId: null })
      });
    } catch (err) {
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

async function createCard(columnId, text) {
  const res = await fetch(`${API_BASE}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text })
  });
  if (!res.ok) {
    console.error('Create failed');
  }
}

function connectSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleServerUpdate(data);
  };

  eventSource.onerror = () => {
    console.log('SSE error, reconnecting...');
    setTimeout(connectSSE, 1000);
  };
}

function handleServerUpdate(data) {
  if (data.type === 'card-created' || data.type === 'card-moved') {
    // Re-fetch board for simplicity and correctness
    fetchBoard();
  } else if (data.type === 'board-renormalized') {
    fetchBoard();
  }
}

async function init() {
  await fetchBoard();
  connectSSE();
}

init();