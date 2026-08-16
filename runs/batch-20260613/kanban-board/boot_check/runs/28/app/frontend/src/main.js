const API_BASE = 'http://localhost:3001/api';
let boardState = { columns: [] };
let eventSource = null;

async function fetchBoard() {
  const res = await fetch(`${API_BASE}/board`);
  boardState = await res.json();
  renderBoard();
}

function renderBoard() {
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';
  const columnSelect = document.getElementById('new-card-column');
  columnSelect.innerHTML = '';

  boardState.columns.forEach(col => {
    const colEl = document.createElement('div');
    colEl.className = 'column';
    colEl.dataset.columnId = col.id;

    colEl.innerHTML = `
      <h2>${col.title}</h2>
      <div class="cards" data-column-id="${col.id}"></div>
    `;

    const cardsContainer = colEl.querySelector('.cards');
    col.cards.forEach(card => {
      const cardEl = createCardElement(card, col.id);
      cardsContainer.appendChild(cardEl);
    });

    setupDropZone(cardsContainer, col.id);

    boardEl.appendChild(colEl);

    // For create select
    const opt = document.createElement('option');
    opt.value = col.id;
    opt.textContent = col.title;
    columnSelect.appendChild(opt);
  });
}

function createCardElement(card, columnId) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.dataset.cardId = card.id;
  cardEl.draggable = true;
  cardEl.innerHTML = `<div>${card.text}</div>`;

  cardEl.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ cardId: card.id, fromColumn: columnId }));
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
    const data = JSON.parse(e.dataTransfer.getData('text/plain'));
    const { cardId, fromColumn } = data;

    // Optimistic update: move in DOM
    const cardEl = document.querySelector(`[data-card-id="${cardId}"]`);
    if (cardEl) {
      // Find drop position
      const afterEl = getDropAfterElement(container, e.clientY);
      if (afterEl) {
        container.insertBefore(cardEl, afterEl);
      } else {
        container.appendChild(cardEl);
      }
    }

    // Determine beforeId and afterId from current DOM order
    const { beforeId, afterId } = getSiblingIds(container, cardId);

    // Send to server
    try {
      await fetch(`${API_BASE}/cards/${cardId}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId, beforeId, afterId })
      });
    } catch (err) {
      console.error('Move failed, will reconcile on SSE', err);
    }
  });
}

function getDropAfterElement(container, y) {
  const cards = [...container.querySelectorAll('.card:not(.dragging)')];
  return cards.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      return { offset, element: child };
    } else {
      return closest;
    }
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

function getSiblingIds(container, cardId) {
  const cards = [...container.querySelectorAll('.card')];
  const idx = cards.findIndex(c => c.dataset.cardId === cardId);
  const beforeId = idx > 0 ? cards[idx - 1].dataset.cardId : null;
  const afterId = idx < cards.length - 1 ? cards[idx + 1].dataset.cardId : null;
  return { beforeId, afterId };
}

function setupCreateCard() {
  const btn = document.getElementById('create-btn');
  const input = document.getElementById('new-card-text');
  const select = document.getElementById('new-card-column');

  btn.addEventListener('click', async () => {
    const text = input.value.trim();
    const columnId = select.value;
    if (!text || !columnId) return;

    const res = await fetch(`${API_BASE}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text })
    });
    if (res.ok) {
      input.value = '';
      // Will be added via SSE or we can refetch, but SSE handles
    }
  });
}

function connectSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.addEventListener('card-created', (e) => {
    const { card, columnId } = JSON.parse(e.data);
    addCardToDOM(card, columnId);
  });

  eventSource.addEventListener('card-moved', (e) => {
    const { card, columnId, oldColumnId } = JSON.parse(e.data);
    moveCardInDOM(card, columnId, oldColumnId);
  });

  eventSource.onerror = () => {
    console.log('SSE error, reconnecting...');
    setTimeout(connectSSE, 3000);
  };
}

function addCardToDOM(card, columnId) {
  // Avoid duplicates
  if (document.querySelector(`[data-card-id="${card.id}"]`)) return;

  const container = document.querySelector(`.cards[data-column-id="${columnId}"]`);
  if (!container) return;

  const cardEl = createCardElement(card, columnId);
  container.appendChild(cardEl);
  setupDropZone(container, columnId); // re-setup? but ok
}

function moveCardInDOM(card, newColumnId, oldColumnId) {
  let cardEl = document.querySelector(`[data-card-id="${card.id}"]`);
  if (!cardEl) {
    // create if not exists
    cardEl = createCardElement(card, newColumnId);
  }

  // Remove from old place if present
  const currentParent = cardEl.parentElement;
  if (currentParent) currentParent.removeChild(cardEl);

  const newContainer = document.querySelector(`.cards[data-column-id="${newColumnId}"]`);
  if (newContainer) {
    // Insert at correct position? For simplicity append, or better find position but since we have positions, but DOM order from server not specified.
    // To make accurate, we should re-render or insert based on position, but for now append and rely on reconciliation
    newContainer.appendChild(cardEl);
  }
}

async function init() {
  await fetchBoard();
  setupCreateCard();
  connectSSE();
}

init();
