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
  
  cardEl.addEventListener('dragstart', () => {
    cardEl.classList.add('dragging');
  });

  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('dragging');
    const listEl = cardEl.closest('.card-list');
    if (listEl && cardEl.dataset.position) {
      insertCardInOrder(listEl, cardEl, parseFloat(cardEl.dataset.position));
    }
  });

  return cardEl;
}

function setupDragAndDrop() {
  const boardEl = document.getElementById('board');
  
  boardEl.addEventListener('dragover', e => {
    const list = e.target.closest('.card-list');
    if (!list) return;
    e.preventDefault();
    const afterElement = getDragAfterElement(list, e.clientY);
    const draggable = document.querySelector('.dragging');
    if (!draggable) return;
    
    if (afterElement == null) {
      list.appendChild(draggable);
    } else {
      list.insertBefore(draggable, afterElement);
    }
  });

  boardEl.addEventListener('drop', async e => {
    const list = e.target.closest('.card-list');
    if (!list) return;
    e.preventDefault();
    const draggable = document.querySelector('.dragging');
    if (!draggable) return;

    const cardId = parseInt(draggable.dataset.id);
    const columnId = parseInt(list.dataset.columnId);
    
    let nextId = null;
    let prevId = null;

    const nextElement = draggable.nextElementSibling;
    if (nextElement && nextElement.classList.contains('card')) {
      nextId = parseInt(nextElement.dataset.id);
    }

    const prevElement = draggable.previousElementSibling;
    if (prevElement && prevElement.classList.contains('card')) {
      prevId = parseInt(prevElement.dataset.id);
    }

    await fetch(`${API_URL}/cards/${cardId}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, prevId, nextId })
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

function insertCardInOrder(listEl, cardEl, position) {
  cardEl.dataset.position = position;
  const cards = [...listEl.querySelectorAll('.card:not(.dragging)')];
  const nextCard = cards.find(c => parseFloat(c.dataset.position) > position);
  if (nextCard) {
    listEl.insertBefore(cardEl, nextCard);
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
    }

    const listEl = document.querySelector(`.card-list[data-column-id="${newCard.column_id}"]`);
    if (listEl) {
      let cardEl = document.querySelector(`.card[data-id="${newCard.id}"]`);
      if (!cardEl) {
        cardEl = createCardElement(newCard);
      }
      insertCardInOrder(listEl, cardEl, newCard.position);
    }
  });

  eventSource.addEventListener('card_moved', (e) => {
    const updatedCard = JSON.parse(e.data);
    
    boardState.forEach(col => {
      col.cards = col.cards.filter(c => c.id !== updatedCard.id);
    });
    const column = boardState.find(c => c.id === updatedCard.column_id);
    if (column) {
      column.cards.push(updatedCard);
    }

    const listEl = document.querySelector(`.card-list[data-column-id="${updatedCard.column_id}"]`);
    if (listEl) {
      let cardEl = document.querySelector(`.card[data-id="${updatedCard.id}"]`);
      if (!cardEl) {
        cardEl = createCardElement(updatedCard);
      }
      if (!cardEl.classList.contains('dragging')) {
        insertCardInOrder(listEl, cardEl, updatedCard.position);
      } else {
        cardEl.dataset.position = updatedCard.position;
      }
    }
  });

  eventSource.addEventListener('column_renormalized', (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    
    const column = boardState.find(c => c.id === columnId);
    if (column) {
      column.cards = cards;
    }

    const listEl = document.querySelector(`.card-list[data-column-id="${columnId}"]`);
    if (listEl) {
      cards.forEach(card => {
        let cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
        if (cardEl) {
          cardEl.dataset.position = card.position;
          if (!cardEl.classList.contains('dragging')) {
            insertCardInOrder(listEl, cardEl, card.position);
          }
        }
      });
    }
  });
}

fetchBoard().then(() => {
  setupSSE();
});
