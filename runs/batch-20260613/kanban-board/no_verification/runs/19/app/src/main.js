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
    listEl.dataset.id = column.id;
    
    column.cards.sort((a, b) => a.position - b.position);

    column.cards.forEach(card => {
      const cardEl = createCardElement(card);
      listEl.appendChild(cardEl);
    });

    colEl.appendChild(listEl);

    const addCardContainer = document.createElement('div');
    
    const addBtn = document.createElement('div');
    addBtn.className = 'add-card';
    addBtn.textContent = '+ Add a card';
    
    const formEl = document.createElement('div');
    formEl.className = 'add-card-form';
    
    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Enter a title for this card...';
    
    const submitBtn = document.createElement('button');
    submitBtn.textContent = 'Add Card';
    
    formEl.appendChild(textarea);
    formEl.appendChild(submitBtn);
    
    addBtn.addEventListener('click', () => {
      addBtn.style.display = 'none';
      formEl.classList.add('active');
      textarea.focus();
    });
    
    submitBtn.addEventListener('click', async () => {
      const text = textarea.value.trim();
      if (text) {
        await createCard(column.id, text);
        textarea.value = '';
        formEl.classList.remove('active');
        addBtn.style.display = 'block';
      }
    });
    
    addCardContainer.appendChild(addBtn);
    addCardContainer.appendChild(formEl);
    colEl.appendChild(addCardContainer);

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

document.addEventListener('dragstart', e => {
  if (e.target.classList && e.target.classList.contains('card')) {
    e.target.classList.add('dragging');
  }
});

document.addEventListener('dragend', async e => {
  if (e.target.classList && e.target.classList.contains('card')) {
    const card = e.target;
    card.classList.remove('dragging');
    
    const list = card.closest('.card-list');
    if (!list) return;
    
    const columnId = list.dataset.id;
    const cardElements = [...list.querySelectorAll('.card')];
    const index = cardElements.indexOf(card);
    
    const beforeCard = cardElements[index + 1];
    const afterCard = cardElements[index - 1];
    
    const beforeId = beforeCard ? beforeCard.dataset.id : null;
    const afterId = afterCard ? afterCard.dataset.id : null;
    
    const cardId = card.dataset.id;
    
    await fetch(`${API_URL}/cards/${cardId}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId })
    });
  }
});

function setupDragAndDrop() {
  const lists = document.querySelectorAll('.card-list');
  lists.forEach(list => {
    list.removeEventListener('dragover', handleDragOver);
    list.addEventListener('dragover', handleDragOver);
  });
}

function handleDragOver(e) {
  e.preventDefault();
  const list = e.currentTarget;
  const afterElement = getDragAfterElement(list, e.clientY);
  const draggable = document.querySelector('.dragging');
  if (draggable) {
    if (afterElement == null) {
      list.appendChild(draggable);
    } else {
      list.insertBefore(draggable, afterElement);
    }
  }
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

eventSource.addEventListener('card_created', (e) => {
  const card = JSON.parse(e.data);
  const column = boardData.find(c => c.id === card.column_id);
  if (column) {
    column.cards.push(card);
    const listEl = document.querySelector(`.card-list[data-id="${card.column_id}"]`);
    if (listEl) {
      if (!document.querySelector(`.card[data-id="${card.id}"]`)) {
        const cardEl = createCardElement(card);
        const siblings = [...listEl.querySelectorAll('.card')];
        const nextSibling = siblings.find(c => parseFloat(c.dataset.position) > card.position);
        if (nextSibling) {
          listEl.insertBefore(cardEl, nextSibling);
        } else {
          listEl.appendChild(cardEl);
        }
      }
    }
  }
});

eventSource.addEventListener('card_moved', (e) => {
  const movedCard = JSON.parse(e.data);
  
  boardData.forEach(col => {
    col.cards = col.cards.filter(c => c.id !== movedCard.id);
    if (col.id === movedCard.column_id) {
      col.cards.push(movedCard);
      col.cards.sort((a, b) => a.position - b.position);
    }
  });

  const cardEl = document.querySelector(`.card[data-id="${movedCard.id}"]`);
  if (cardEl) {
    cardEl.dataset.position = movedCard.position;
    const targetList = document.querySelector(`.card-list[data-id="${movedCard.column_id}"]`);
    
    if (targetList) {
      const siblings = [...targetList.querySelectorAll('.card')].filter(c => c !== cardEl);
      const nextSibling = siblings.find(c => parseFloat(c.dataset.position) > movedCard.position);
      
      if (nextSibling) {
        targetList.insertBefore(cardEl, nextSibling);
      } else {
        targetList.appendChild(cardEl);
      }
    }
  } else {
    const targetList = document.querySelector(`.card-list[data-id="${movedCard.column_id}"]`);
    if (targetList) {
      const newCardEl = createCardElement(movedCard);
      
      const siblings = [...targetList.querySelectorAll('.card')];
      const nextSibling = siblings.find(c => parseFloat(c.dataset.position) > movedCard.position);
      
      if (nextSibling) {
        targetList.insertBefore(newCardEl, nextSibling);
      } else {
        targetList.appendChild(newCardEl);
      }
    }
  }
});

eventSource.addEventListener('column_renormalized', (e) => {
  const { columnId, cards } = JSON.parse(e.data);
  
  const column = boardData.find(c => c.id === columnId);
  if (column) {
    column.cards = cards;
  }
  
  const listEl = document.querySelector(`.card-list[data-id="${columnId}"]`);
  if (listEl) {
    listEl.innerHTML = '';
    cards.forEach(card => {
      listEl.appendChild(createCardElement(card));
    });
  }
});

fetchBoard();
