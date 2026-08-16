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
    
    column.cards.forEach(card => {
      const cardEl = createCardElement(card);
      listEl.appendChild(cardEl);
    });

    colEl.appendChild(listEl);

    const formEl = document.createElement('form');
    formEl.className = 'add-card-form';
    formEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = formEl.querySelector('.add-card-input');
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
    inputEl.className = 'add-card-input';
    inputEl.placeholder = 'Add a card...';
    formEl.appendChild(inputEl);

    const btnEl = document.createElement('button');
    btnEl.className = 'add-card-btn';
    btnEl.textContent = 'Add Card';
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
  cardEl.dataset.columnId = card.column_id;
  cardEl.textContent = card.text;
  return cardEl;
}

let draggedCard = null;

function setupDragAndDrop() {
  const boardEl = document.getElementById('board');

  boardEl.addEventListener('dragstart', e => {
    if (e.target.classList.contains('card')) {
      draggedCard = e.target;
      setTimeout(() => e.target.classList.add('dragging'), 0);
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

      const cardId = draggedCard.dataset.id;
      const newColumnId = list.dataset.columnId;
      
      const prevSibling = draggedCard.previousElementSibling;
      const nextSibling = draggedCard.nextElementSibling;

      const afterId = prevSibling ? prevSibling.dataset.id : null;
      const beforeId = nextSibling ? nextSibling.dataset.id : null;

      draggedCard.dataset.columnId = newColumnId;

      try {
        await fetch(`${API_URL}/cards/${cardId}/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            columnId: parseInt(newColumnId, 10),
            afterId: afterId ? parseInt(afterId, 10) : null,
            beforeId: beforeId ? parseInt(beforeId, 10) : null
          })
        });
      } catch (err) {
        console.error('Failed to move card', err);
      }
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

  eventSource.addEventListener('card_created', e => {
    const newCard = JSON.parse(e.data);
    const col = boardState.find(c => c.id === newCard.column_id);
    if (col) {
      col.cards.push(newCard);
      const listEl = document.querySelector(`.card-list[data-column-id="${newCard.column_id}"]`);
      if (listEl) {
        if (!document.querySelector(`.card[data-id="${newCard.id}"]`)) {
          listEl.appendChild(createCardElement(newCard));
        }
      }
    }
  });

  eventSource.addEventListener('card_moved', e => {
    const updatedCard = JSON.parse(e.data);
    
    boardState.forEach(col => {
      col.cards = col.cards.filter(c => c.id !== updatedCard.id);
    });
    const targetCol = boardState.find(c => c.id === updatedCard.column_id);
    if (targetCol) {
      targetCol.cards.push(updatedCard);
      targetCol.cards.sort((a, b) => a.position - b.position);
    }

    let cardEl = document.querySelector(`.card[data-id="${updatedCard.id}"]`);
    if (!cardEl) {
      cardEl = createCardElement(updatedCard);
    }

    if (cardEl) {
      cardEl.dataset.columnId = updatedCard.column_id;
      const listEl = document.querySelector(`.card-list[data-column-id="${updatedCard.column_id}"]`);
      
      if (targetCol && listEl) {
        const index = targetCol.cards.findIndex(c => c.id === updatedCard.id);
        const nextCard = targetCol.cards[index + 1];
        
        if (nextCard) {
          const nextCardEl = document.querySelector(`.card[data-id="${nextCard.id}"]`);
          if (nextCardEl) {
            if (cardEl.nextElementSibling !== nextCardEl) {
              listEl.insertBefore(cardEl, nextCardEl);
            }
          } else {
            listEl.appendChild(cardEl);
          }
        } else {
          if (listEl.lastElementChild !== cardEl) {
            listEl.appendChild(cardEl);
          }
        }
      }
    }
  });

  eventSource.addEventListener('column_renormalized', e => {
    const { columnId, cards } = JSON.parse(e.data);
    const col = boardState.find(c => c.id === columnId);
    if (col) {
      col.cards = cards;
      const listEl = document.querySelector(`.card-list[data-column-id="${columnId}"]`);
      if (listEl) {
        listEl.innerHTML = '';
        cards.forEach(card => {
          listEl.appendChild(createCardElement(card));
        });
      }
    }
  });
}

fetchBoard().then(setupSSE);
