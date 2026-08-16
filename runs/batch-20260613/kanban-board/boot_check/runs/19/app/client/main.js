const API_URL = '/api';

let boardData = [];

async function fetchBoard() {
  const res = await fetch(`${API_URL}/board`);
  boardData = await res.json();
  renderBoard();
}

function renderBoard() {
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';

  boardData.forEach(column => {
    const colEl = document.createElement('div');
    colEl.className = 'column';
    colEl.dataset.id = column.id;

    const headerEl = document.createElement('div');
    headerEl.className = 'column-header';
    headerEl.textContent = column.title;
    colEl.appendChild(headerEl);

    const listEl = document.createElement('div');
    listEl.className = 'card-list';
    listEl.dataset.id = column.id;
    
    // Sort cards by position
    column.cards.sort((a, b) => a.position - b.position);
    
    column.cards.forEach(card => {
      const cardEl = createCardElement(card);
      listEl.appendChild(cardEl);
    });

    colEl.appendChild(listEl);

    const formEl = document.createElement('form');
    formEl.className = 'add-card-form';
    formEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = formEl.querySelector('input');
      const text = input.value.trim();
      if (!text) return;
      
      input.value = '';
      await fetch(`${API_URL}/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId: column.id, text })
      });
    });

    const inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.placeholder = 'Add a card...';
    formEl.appendChild(inputEl);

    const btnEl = document.createElement('button');
    btnEl.type = 'submit';
    btnEl.textContent = 'Add';
    formEl.appendChild(btnEl);

    colEl.appendChild(formEl);
    boardEl.appendChild(colEl);
  });

  setupDragAndDrop();
}

function createCardElement(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.draggable = true;
  cardEl.dataset.id = card.id;
  cardEl.textContent = card.text;
  return cardEl;
}

let draggedCard = null;

function setupDragAndDrop() {
  const boardEl = document.getElementById('board');

  boardEl.addEventListener('dragstart', e => {
    if (e.target.classList.contains('card')) {
      draggedCard = e.target;
      e.target.classList.add('dragging');
    }
  });

  boardEl.addEventListener('dragend', e => {
    if (e.target.classList.contains('card')) {
      e.target.classList.remove('dragging');
      draggedCard = null;
    }
  });

  const lists = document.querySelectorAll('.card-list');
  lists.forEach(list => {
    list.addEventListener('dragover', e => {
      e.preventDefault();
      const afterElement = getDragAfterElement(list, e.clientY);
      if (afterElement == null) {
        list.appendChild(draggedCard);
      } else {
        list.insertBefore(draggedCard, afterElement);
      }
    });

    list.addEventListener('drop', async e => {
      e.preventDefault();
      if (!draggedCard) return;

      const cardId = draggedCard.dataset.id;
      const columnId = list.dataset.id;
      
      const afterElement = draggedCard.nextElementSibling;
      const beforeElement = draggedCard.previousElementSibling;
      
      const afterId = afterElement ? afterElement.dataset.id : null;
      const beforeId = beforeElement ? beforeElement.dataset.id : null;

      // Optimistic update
      // We don't need to update boardData immediately because SSE will push the update
      // But we can leave it in the DOM where it was dropped.

      await fetch(`${API_URL}/cards/${cardId}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId, beforeId, afterId })
      });
    });
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

function setupSSE() {
  const eventSource = new EventSource(`${API_URL}/stream`);
  
  eventSource.onmessage = (e) => {
    const data = JSON.parse(e.data);
    
    if (data.type === 'CARD_CREATED') {
      const col = boardData.find(c => c.id == data.card.column_id);
      if (col) {
        col.cards.push(data.card);
        col.cards.sort((a, b) => a.position - b.position);
        syncColumnDOM(col);
      }
    } else if (data.type === 'CARD_MOVED') {
      // Remove card from old column
      boardData.forEach(col => {
        col.cards = col.cards.filter(c => c.id != data.card.id);
      });
      // Add to new column
      const col = boardData.find(c => c.id == data.card.column_id);
      if (col) {
        col.cards.push(data.card);
        col.cards.sort((a, b) => a.position - b.position);
      }
      // Sync all columns just in case
      boardData.forEach(c => syncColumnDOM(c));
    } else if (data.type === 'COLUMN_RENORMALIZED') {
      const col = boardData.find(c => c.id == data.columnId);
      if (col) {
        col.cards = data.cards;
        col.cards.sort((a, b) => a.position - b.position);
        syncColumnDOM(col);
      }
    }
  };
}

function syncColumnDOM(column) {
  const listEl = document.querySelector(`.card-list[data-id="${column.id}"]`);
  if (!listEl) return;
  
  let domIndex = 0;
  column.cards.forEach((card) => {
    let cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
    if (!cardEl) {
      cardEl = createCardElement(card);
    } else {
      cardEl.textContent = card.text;
    }
    
    if (cardEl.classList.contains('dragging')) {
      return;
    }
    
    while (listEl.children[domIndex] && listEl.children[domIndex].classList.contains('dragging')) {
      domIndex++;
    }
    
    const currentChild = listEl.children[domIndex];
    if (currentChild !== cardEl) {
      listEl.insertBefore(cardEl, currentChild);
    }
    domIndex++;
  });

  const existingCards = Array.from(listEl.querySelectorAll('.card'));
  const newCardIds = new Set(column.cards.map(c => c.id));
  existingCards.forEach(cardEl => {
    if (!newCardIds.has(parseInt(cardEl.dataset.id))) {
      if (!cardEl.classList.contains('dragging')) {
        cardEl.remove();
      }
    }
  });
}

fetchBoard().then(setupSSE);
