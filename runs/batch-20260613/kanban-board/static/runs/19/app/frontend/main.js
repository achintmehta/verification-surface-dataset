const API_URL = 'http://localhost:3000/api';

let boardState = [];

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
  cardEl.dataset.position = card.position;
  cardEl.textContent = card.text;
  setupDragForCard(cardEl);
  return cardEl;
}

let draggedCard = null;

function setupDragForCard(card) {
  card.addEventListener('dragstart', () => {
    draggedCard = card;
    setTimeout(() => card.classList.add('dragging'), 0);
  });

  card.addEventListener('dragend', () => {
    if (draggedCard) {
      draggedCard.classList.remove('dragging');
      draggedCard = null;
    }
  });
}

function setupDragAndDrop() {
  const lists = document.querySelectorAll('.card-list');

  lists.forEach(list => {
    list.addEventListener('dragover', e => {
      e.preventDefault();
      if (!draggedCard) return;
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

      const cardId = parseInt(draggedCard.dataset.id);
      const columnId = parseInt(list.dataset.columnId);
      
      const prevSibling = draggedCard.previousElementSibling;
      const nextSibling = draggedCard.nextElementSibling;
      
      const afterId = prevSibling ? parseInt(prevSibling.dataset.id) : null;
      const beforeId = nextSibling ? parseInt(nextSibling.dataset.id) : null;

      draggedCard.classList.remove('dragging');
      draggedCard = null;

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

function placeCardInDOM(cardEl, cardData) {
  const listEl = document.querySelector(`.card-list[data-column-id="${cardData.column_id}"]`);
  if (!listEl) return;
  
  const siblings = [...listEl.querySelectorAll('.card:not(.dragging)')];
  const nextSibling = siblings.find(sibling => parseFloat(sibling.dataset.position) > cardData.position);
  
  if (nextSibling) {
    listEl.insertBefore(cardEl, nextSibling);
  } else {
    listEl.appendChild(cardEl);
  }
}

function setupSSE() {
  const eventSource = new EventSource(`${API_URL}/stream`);

  eventSource.addEventListener('card_created', (e) => {
    const newCard = JSON.parse(e.data);
    const column = boardState.find(c => c.id === newCard.column_id);
    if (column) {
      column.cards.push(newCard);
      const listEl = document.querySelector(`.card-list[data-column-id="${newCard.column_id}"]`);
      if (listEl && !document.querySelector(`.card[data-id="${newCard.id}"]`)) {
        const cardEl = createCardElement(newCard);
        listEl.appendChild(cardEl);
      }
    }
  });

  eventSource.addEventListener('card_moved', (e) => {
    const movedCard = JSON.parse(e.data);
    
    boardState.forEach(col => {
      col.cards = col.cards.filter(c => c.id !== movedCard.id);
    });

    const column = boardState.find(c => c.id === movedCard.column_id);
    if (column) {
      column.cards.push(movedCard);
      column.cards.sort((a, b) => a.position - b.position);
    }

    const existingCardEl = document.querySelector(`.card[data-id="${movedCard.id}"]`);
    if (existingCardEl) {
      existingCardEl.dataset.position = movedCard.position;
      if (!existingCardEl.classList.contains('dragging')) {
        placeCardInDOM(existingCardEl, movedCard);
      }
    } else {
      const newCardEl = createCardElement(movedCard);
      placeCardInDOM(newCardEl, movedCard);
    }
  });

  eventSource.addEventListener('column_renormalized', (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    const column = boardState.find(c => c.id === columnId);
    if (column) {
      column.cards = cards;
      cards.forEach(card => {
        const cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
        if (cardEl) {
          cardEl.dataset.position = card.position;
          if (!cardEl.classList.contains('dragging')) {
            placeCardInDOM(cardEl, card);
          }
        }
      });
    }
  });
}

fetchBoard().then(setupSSE);