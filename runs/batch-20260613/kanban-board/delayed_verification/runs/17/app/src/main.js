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
    listEl.dataset.columnId = column.id;

    column.cards.forEach(card => {
      const cardEl = createCardElement(card);
      listEl.appendChild(cardEl);
    });

    colEl.appendChild(listEl);

    const addCardBtn = document.createElement('div');
    addCardBtn.className = 'add-card';
    addCardBtn.textContent = '+ Add a card';
    
    const addCardForm = document.createElement('div');
    addCardForm.className = 'add-card-form';
    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Enter a title for this card...';
    const submitBtn = document.createElement('button');
    submitBtn.textContent = 'Add Card';

    addCardForm.appendChild(textarea);
    addCardForm.appendChild(submitBtn);

    addCardBtn.addEventListener('click', () => {
      addCardBtn.style.display = 'none';
      addCardForm.classList.add('active');
      textarea.focus();
    });

    submitBtn.addEventListener('click', async () => {
      const text = textarea.value.trim();
      if (text) {
        await createCard(column.id, text);
        textarea.value = '';
        addCardForm.classList.remove('active');
        addCardBtn.style.display = 'block';
      }
    });

    colEl.appendChild(addCardBtn);
    colEl.appendChild(addCardForm);

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

async function createCard(columnId, text) {
  await fetch(`${API_URL}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text })
  });
}

function setupDragAndDrop() {
  const boardEl = document.getElementById('board');
  let draggedCard = null;

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

  boardEl.addEventListener('dragover', e => {
    e.preventDefault();
    const colEl = e.target.closest('.column');
    if (!colEl || !draggedCard) return;
    
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

    const colEl = draggedCard.closest('.column');
    if (!colEl) return;
    
    const listEl = colEl.querySelector('.card-list');
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
      const updatedCard = await res.json();
      draggedCard.dataset.position = updatedCard.position;
    } catch (err) {
      console.error('Failed to move card', err);
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

const eventSource = new EventSource(`${API_URL}/stream`);

eventSource.addEventListener('card_created', e => {
  const card = JSON.parse(e.data);
  if (document.querySelector(`.card[data-id="${card.id}"]`)) return;

  const listEl = document.querySelector(`.card-list[data-column-id="${card.column_id}"]`);
  if (listEl) {
    const cardEl = createCardElement(card);
    listEl.appendChild(cardEl);
    sortList(listEl);
  }
});

eventSource.addEventListener('card_moved', e => {
  const card = JSON.parse(e.data);
  let cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
  
  if (!cardEl) {
    cardEl = createCardElement(card);
  } else {
    cardEl.dataset.position = card.position;
    cardEl.textContent = card.text;
  }

  const listEl = document.querySelector(`.card-list[data-column-id="${card.column_id}"]`);
  if (listEl) {
    if (cardEl.parentElement !== listEl) {
      listEl.appendChild(cardEl);
    }
    sortList(listEl);
  }
});

eventSource.addEventListener('column_renormalized', e => {
  const data = JSON.parse(e.data);
  const listEl = document.querySelector(`.card-list[data-column-id="${data.columnId}"]`);
  if (listEl) {
    data.cards.forEach(card => {
      let cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
      if (cardEl) {
        cardEl.dataset.position = card.position;
      }
    });
    sortList(listEl);
  }
});

function sortList(listEl) {
  const cards = [...listEl.querySelectorAll('.card')];
  cards.sort((a, b) => {
    const posDiff = parseFloat(a.dataset.position) - parseFloat(b.dataset.position);
    if (posDiff !== 0) return posDiff;
    return parseInt(a.dataset.id) - parseInt(b.dataset.id);
  });
  cards.forEach((card, index) => {
    if (listEl.children[index] !== card) {
      listEl.insertBefore(card, listEl.children[index]);
    }
  });
}

fetchBoard();
