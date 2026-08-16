const API_URL = 'http://localhost:3000/api';

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

    const titleEl = document.createElement('div');
    titleEl.className = 'column-title';
    titleEl.textContent = column.title;
    colEl.appendChild(titleEl);

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
    formEl.onsubmit = async (e) => {
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
    };

    const inputEl = document.createElement('input');
    inputEl.className = 'add-card-input';
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
  return cardEl;
}

let draggedCard = null;

function setupDragAndDrop() {
  const boardEl = document.getElementById('board');

  boardEl.addEventListener('dragstart', e => {
    if (e.target.classList.contains('card')) {
      draggedCard = e.target;
      e.target.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    }
  });

  boardEl.addEventListener('dragend', e => {
    if (e.target.classList.contains('card')) {
      e.target.classList.remove('dragging');
      draggedCard = null;
    }
  });

  boardEl.addEventListener('dragover', e => {
    e.preventDefault();
    const listEl = e.target.closest('.card-list');
    if (!listEl || !draggedCard) return;

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

    const listEl = draggedCard.closest('.card-list');
    if (!listEl) return;

    const columnId = parseInt(listEl.dataset.columnId);
    const cardId = parseInt(draggedCard.dataset.id);

    const prevCard = draggedCard.previousElementSibling;
    const nextCard = draggedCard.nextElementSibling;

    const afterId = prevCard ? parseInt(prevCard.dataset.id) : null;
    const beforeId = nextCard ? parseInt(nextCard.dataset.id) : null;

    try {
      const res = await fetch(`${API_URL}/cards/${cardId}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId, beforeId, afterId })
      });
      if (!res.ok) {
        console.error('Failed to move card');
        fetchBoard();
      }
    } catch (err) {
      console.error(err);
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
  const evtSource = new EventSource(`${API_URL}/stream`);

  evtSource.addEventListener('card_created', e => {
    const card = JSON.parse(e.data);
    const col = boardData.find(c => c.id === card.column_id);
    if (col) {
      col.cards.push(card);
      const listEl = document.querySelector(`.card-list[data-column-id="${card.column_id}"]`);
      if (listEl) {
        if (!listEl.querySelector(`.card[data-id="${card.id}"]`)) {
          const cardEl = createCardElement(card);
          listEl.appendChild(cardEl);
        }
      }
    }
  });

  evtSource.addEventListener('card_moved', e => {
    const movedCard = JSON.parse(e.data);
    
    let oldCol = null;
    let cardIndex = -1;
    for (const col of boardData) {
      cardIndex = col.cards.findIndex(c => c.id === movedCard.id);
      if (cardIndex !== -1) {
        oldCol = col;
        break;
      }
    }

    if (oldCol) {
      oldCol.cards.splice(cardIndex, 1);
    }

    const newCol = boardData.find(c => c.id === movedCard.column_id);
    if (newCol) {
      if (!newCol.cards.find(c => c.id === movedCard.id)) {
        newCol.cards.push(movedCard);
      } else {
        const existing = newCol.cards.find(c => c.id === movedCard.id);
        Object.assign(existing, movedCard);
      }
      newCol.cards.sort((a, b) => a.position - b.position);
    }

    const existingCardEl = document.querySelector(`.card[data-id="${movedCard.id}"]`);
    const listEl = document.querySelector(`.card-list[data-column-id="${movedCard.column_id}"]`);
    
    if (existingCardEl && listEl) {
      existingCardEl.dataset.position = movedCard.position;
      
      const cardsInList = [...listEl.querySelectorAll('.card')];
      const otherCards = cardsInList.filter(c => c !== existingCardEl);
      
      let insertBeforeEl = null;
      for (const c of otherCards) {
        if (parseFloat(c.dataset.position) > movedCard.position) {
          insertBeforeEl = c;
          break;
        }
      }

      if (insertBeforeEl) {
        if (existingCardEl.nextElementSibling !== insertBeforeEl) {
          listEl.insertBefore(existingCardEl, insertBeforeEl);
        }
      } else {
        if (listEl.lastElementChild !== existingCardEl) {
          listEl.appendChild(existingCardEl);
        }
      }
    } else if (!existingCardEl && listEl) {
      const cardEl = createCardElement(movedCard);
      
      const cardsInList = [...listEl.querySelectorAll('.card')];
      let insertBeforeEl = null;
      for (const c of cardsInList) {
        if (parseFloat(c.dataset.position) > movedCard.position) {
          insertBeforeEl = c;
          break;
        }
      }

      if (insertBeforeEl) {
        listEl.insertBefore(cardEl, insertBeforeEl);
      } else {
        listEl.appendChild(cardEl);
      }
    }
  });

  evtSource.addEventListener('column_renormalized', e => {
    const data = JSON.parse(e.data);
    const col = boardData.find(c => c.id === data.columnId);
    if (col && data.cards) {
      col.cards = data.cards;
      col.cards.sort((a, b) => a.position - b.position);
      
      const listEl = document.querySelector(`.card-list[data-column-id="${data.columnId}"]`);
      if (listEl) {
        listEl.innerHTML = '';
        col.cards.forEach(card => {
          listEl.appendChild(createCardElement(card));
        });
      }
    }
  });
}

fetchBoard().then(() => {
  setupSSE();
});
