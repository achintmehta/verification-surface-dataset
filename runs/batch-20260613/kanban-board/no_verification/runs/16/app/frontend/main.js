const API_URL = 'http://localhost:3001/api';

let boardState = [];
let isDragging = false;

async function fetchBoard() {
  const res = await fetch(`${API_URL}/board`);
  boardState = await res.json();
  renderBoard();
}

function renderBoard() {
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';

  boardState.forEach(column => {
    const colEl = document.createElement('div');
    colEl.className = 'column';
    colEl.dataset.id = column.id;

    const headerEl = document.createElement('div');
    headerEl.className = 'column-header';
    headerEl.textContent = column.title;
    colEl.appendChild(headerEl);

    const listEl = document.createElement('div');
    listEl.className = 'card-list';
    listEl.dataset.columnId = column.id;
    
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
    colEl.appendChild(formEl);

    boardEl.appendChild(colEl);
  });

  setupDragAndDrop();
}

function createCardElement(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.dataset.id = card.id;
  cardEl.dataset.position = card.position;
  cardEl.textContent = card.text;
  cardEl.draggable = true;
  return cardEl;
}

let draggedCard = null;

function setupDragAndDrop() {
  const boardEl = document.getElementById('board');

  boardEl.addEventListener('dragstart', e => {
    if (e.target.classList.contains('card')) {
      isDragging = true;
      draggedCard = e.target;
      e.target.classList.add('dragging');
    }
  });

  boardEl.addEventListener('dragend', e => {
    if (e.target.classList.contains('card')) {
      e.target.classList.remove('dragging');
      draggedCard = null;
      isDragging = false;
      // Re-render to snap to canonical state if it was updated during drag
      renderBoard();
    }
  });

  boardEl.addEventListener('dragover', e => {
    const list = e.target.closest('.card-list');
    if (!list || !draggedCard) return;
    e.preventDefault();
    const afterElement = getDragAfterElement(list, e.clientY);
    if (afterElement == null) {
      list.appendChild(draggedCard);
    } else {
      list.insertBefore(draggedCard, afterElement);
    }
  });

  boardEl.addEventListener('drop', async e => {
    const list = e.target.closest('.card-list');
    if (!list || !draggedCard) return;
    e.preventDefault();

    const columnId = parseInt(list.dataset.columnId);
    const cardId = parseInt(draggedCard.dataset.id);
    
    const prevCard = draggedCard.previousElementSibling;
    const nextCard = draggedCard.nextElementSibling;

    const beforeId = prevCard ? parseInt(prevCard.dataset.id) : null;
    const afterId = nextCard ? parseInt(nextCard.dataset.id) : null;

    // Optimistically update boardState to prevent flicker
    boardState.forEach(col => {
      col.cards = col.cards.filter(c => c.id !== cardId);
    });
    const col = boardState.find(c => c.id === columnId);
    if (col) {
      // We don't know the exact new position, but we can guess it for sorting
      let newPos = 0;
      const beforeCard = col.cards.find(c => c.id === beforeId);
      const afterCard = col.cards.find(c => c.id === afterId);
      if (beforeCard && afterCard) newPos = (beforeCard.position + afterCard.position) / 2;
      else if (beforeCard) newPos = beforeCard.position + 1000;
      else if (afterCard) newPos = afterCard.position / 2;
      else newPos = 1000;
      
      col.cards.push({
        id: cardId,
        column_id: columnId,
        text: draggedCard.textContent,
        position: newPos
      });
      col.cards.sort((a, b) => a.position - b.position);
    }

    await fetch(`${API_URL}/cards/${cardId}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId })
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
  const evtSource = new EventSource(`${API_URL}/stream`);
  
  evtSource.addEventListener('card_created', e => {
    const card = JSON.parse(e.data);
    const col = boardState.find(c => c.id === card.column_id);
    if (col) {
      col.cards.push(card);
      col.cards.sort((a, b) => a.position - b.position);
      if (!isDragging) renderBoard();
    }
  });

  evtSource.addEventListener('card_moved', e => {
    const updatedCard = JSON.parse(e.data);
    
    boardState.forEach(col => {
      col.cards = col.cards.filter(c => c.id !== updatedCard.id);
    });

    const col = boardState.find(c => c.id === updatedCard.column_id);
    if (col) {
      col.cards.push(updatedCard);
      col.cards.sort((a, b) => a.position - b.position);
    }
    
    if (!isDragging) renderBoard();
  });

  evtSource.addEventListener('column_renormalized', e => {
    const { columnId, cards } = JSON.parse(e.data);
    const col = boardState.find(c => c.id === columnId);
    if (col) {
      col.cards = cards;
      if (!isDragging) renderBoard();
    }
  });
}

fetchBoard().then(setupSSE);
