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

async function createCard(columnId, text) {
  await fetch(`${API_URL}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text })
  });
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

  boardEl.addEventListener('dragover', e => {
    e.preventDefault();
    const listEl = e.target.closest('.card-list');
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

    const listEl = draggedCard.closest('.card-list');
    if (!listEl) return;

    const columnId = listEl.dataset.columnId;
    const cardId = draggedCard.dataset.id;

    const prevCard = draggedCard.previousElementSibling;
    const nextCard = draggedCard.nextElementSibling;

    const beforeId = nextCard ? nextCard.dataset.id : null;
    const afterId = prevCard ? prevCard.dataset.id : null;

    const beforePos = nextCard ? parseFloat(nextCard.dataset.position) : null;
    const afterPos = prevCard ? parseFloat(prevCard.dataset.position) : null;
    
    let optimisticPos;
    if (beforePos === null && afterPos === null) optimisticPos = 1000;
    else if (beforePos === null) optimisticPos = afterPos + 1000;
    else if (afterPos === null) optimisticPos = beforePos / 2;
    else optimisticPos = (beforePos + afterPos) / 2;

    draggedCard.dataset.position = optimisticPos;

    try {
      const res = await fetch(`${API_URL}/cards/${cardId}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId, beforeId, afterId })
      });
      if (!res.ok) throw new Error('Move failed');
      const updatedCard = await res.json();
      draggedCard.dataset.position = updatedCard.position;
    } catch (err) {
      console.error('Move failed', err);
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
    const card = JSON.parse(e.data);
    applyCardUpdate(card);
  });

  eventSource.addEventListener('card_moved', e => {
    const card = JSON.parse(e.data);
    applyCardUpdate(card);
  });

  eventSource.addEventListener('column_renormalized', e => {
    const { columnId, cards } = JSON.parse(e.data);
    cards.forEach(card => applyCardUpdate(card));
  });
}

function applyCardUpdate(card) {
  let cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
  
  if (cardEl && cardEl.classList.contains('dragging')) {
    return;
  }

  if (!cardEl) {
    cardEl = createCardElement(card);
  } else {
    cardEl.dataset.position = card.position;
    cardEl.textContent = card.text;
  }

  const listEl = document.querySelector(`.card-list[data-column-id="${card.column_id}"]`);
  if (!listEl) return;

  if (cardEl.parentNode) {
    cardEl.parentNode.removeChild(cardEl);
  }

  const currentCards = [...listEl.querySelectorAll('.card')];
  
  let inserted = false;
  for (let i = 0; i < currentCards.length; i++) {
    const currentCard = currentCards[i];
    if (parseFloat(card.position) < parseFloat(currentCard.dataset.position)) {
      listEl.insertBefore(cardEl, currentCard);
      inserted = true;
      break;
    }
  }

  if (!inserted) {
    listEl.appendChild(cardEl);
  }
}

fetchBoard();
setupDragAndDrop();
setupSSE();