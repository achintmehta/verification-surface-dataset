const API_URL = 'http://localhost:3000/api';

let boardState = [];

async function fetchBoard() {
  const res = await fetch(`${API_URL}/board`);
  boardState = await res.json();
  renderBoard();
}

let draggedCard = null;

function renderBoard() {
  if (draggedCard) {
    return;
  }
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
    colEl.appendChild(formEl);

    boardEl.appendChild(colEl);
  });
}

function createCardElement(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.draggable = true;
  cardEl.dataset.id = card.id;
  cardEl.textContent = card.text;
  return cardEl;
}

function setupDragAndDrop() {
  const boardEl = document.getElementById('board');

  boardEl.addEventListener('dragstart', e => {
    if (e.target.classList.contains('card')) {
      draggedCard = e.target;
      e.target.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', e.target.dataset.id);
    }
  });

  boardEl.addEventListener('dragend', e => {
    if (e.target.classList.contains('card')) {
      e.target.classList.remove('dragging');
      draggedCard = null;
      renderBoard();
    }
  });

  boardEl.addEventListener('dragover', e => {
    e.preventDefault();
    const colEl = e.target.closest('.column');
    if (!colEl) return;
    const listEl = colEl.querySelector('.card-list');
    if (!listEl) return;

    const afterElement = getDragAfterElement(listEl, e.clientY);
    if (afterElement == null) {
      listEl.appendChild(draggedCard);
    } else {
      listEl.insertBefore(draggedCard, afterElement);
    }
  });

  boardEl.addEventListener('drop', async e => {
    e.preventDefault();
    if (!draggedCard) return;

    const colEl = e.target.closest('.column');
    if (!colEl) return;
    const listEl = colEl.querySelector('.card-list');
    if (!listEl) return;

    const columnId = listEl.dataset.id;
    const cardId = draggedCard.dataset.id;

    const prevCard = draggedCard.previousElementSibling;
    const nextCard = draggedCard.nextElementSibling;

    const afterId = prevCard ? prevCard.dataset.id : null;
    const beforeId = nextCard ? nextCard.dataset.id : null;

    // Optimistic update in local state
    let sourceCol = boardState.find(c => c.cards.some(card => card.id === cardId));
    let targetCol = boardState.find(c => c.id === columnId);
    
    if (sourceCol && targetCol) {
      const cardIndex = sourceCol.cards.findIndex(c => c.id === cardId);
      const [card] = sourceCol.cards.splice(cardIndex, 1);
      card.column_id = columnId;
      
      let newPosition;
      if (!beforeId && !afterId) {
        newPosition = 1000;
      } else if (!beforeId) {
        const afterCard = targetCol.cards.find(c => c.id === afterId);
        newPosition = afterCard ? afterCard.position + 1000 : 1000;
      } else if (!afterId) {
        const beforeCard = targetCol.cards.find(c => c.id === beforeId);
        newPosition = beforeCard ? beforeCard.position / 2 : 1000;
      } else {
        const beforeCard = targetCol.cards.find(c => c.id === beforeId);
        const afterCard = targetCol.cards.find(c => c.id === afterId);
        if (beforeCard && afterCard) {
          newPosition = (beforeCard.position + afterCard.position) / 2;
        } else {
          newPosition = 1000;
        }
      }
      card.position = newPosition;
      
      targetCol.cards.push(card);
      renderBoard();
    }

    const res = await fetch(`${API_URL}/cards/${cardId}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId })
    });

    if (!res.ok) {
      // Revert optimistic update by fetching the authoritative state
      fetchBoard();
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

function setupSSE() {
  const eventSource = new EventSource(`${API_URL}/stream`);

  eventSource.addEventListener('card_created', e => {
    const newCard = JSON.parse(e.data);
    const col = boardState.find(c => c.id === newCard.column_id);
    if (col) {
      col.cards.push(newCard);
      renderBoard();
    }
  });

  eventSource.addEventListener('card_moved', e => {
    const updatedCard = JSON.parse(e.data);
    
    // Remove from old column
    boardState.forEach(col => {
      col.cards = col.cards.filter(c => c.id !== updatedCard.id);
    });

    // Add to new column
    const col = boardState.find(c => c.id === updatedCard.column_id);
    if (col) {
      col.cards.push(updatedCard);
      renderBoard();
    }
  });

  eventSource.addEventListener('column_renormalized', e => {
    const { columnId, cards } = JSON.parse(e.data);
    const col = boardState.find(c => c.id === columnId);
    if (col) {
      col.cards = cards;
      renderBoard();
    }
  });
}

fetchBoard().then(() => {
  setupDragAndDrop();
  setupSSE();
});
