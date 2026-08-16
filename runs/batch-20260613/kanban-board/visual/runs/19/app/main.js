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
    
    // Sort cards by position
    column.cards.sort((a, b) => a.position - b.position);
    
    column.cards.forEach(card => {
      const cardEl = createCardElement(card);
      listEl.appendChild(cardEl);
    });
    
    colEl.appendChild(listEl);
    
    const formEl = document.createElement('form');
    formEl.className = 'add-card-form';
    formEl.innerHTML = `
      <input type="text" placeholder="Add a card..." required />
      <button type="submit">Add</button>
    `;
    formEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = formEl.querySelector('input');
      const text = input.value;
      input.value = '';
      
      await fetch(`${API_URL}/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId: column.id, text })
      });
    });
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
  cardEl.dataset.columnId = card.column_id;
  cardEl.textContent = card.text;
  
  cardEl.addEventListener('dragstart', () => {
    draggedCard = cardEl;
    setTimeout(() => cardEl.classList.add('dragging'), 0);
  });
  
  cardEl.addEventListener('dragend', () => {
    draggedCard.classList.remove('dragging');
    draggedCard = null;
  });
  
  return cardEl;
}

let draggedCard = null;

function setupDragAndDrop() {
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
      const columnId = list.dataset.columnId;
      
      let beforeId = null;
      let afterId = null;
      
      const nextElement = draggedCard.nextElementSibling;
      if (nextElement && nextElement.classList.contains('card')) {
        beforeId = nextElement.dataset.id;
      }
      
      const prevElement = draggedCard.previousElementSibling;
      if (prevElement && prevElement.classList.contains('card')) {
        afterId = prevElement.dataset.id;
      }
      
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

function updateCardInDOM(card) {
  let cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
  if (!cardEl) {
    cardEl = createCardElement(card);
  } else {
    cardEl.dataset.position = card.position;
    cardEl.dataset.columnId = card.column_id;
  }
  
  const listEl = document.querySelector(`.card-list[data-column-id="${card.column_id}"]`);
  if (listEl) {
    // Insert in correct order
    const siblings = [...listEl.querySelectorAll('.card')].filter(c => c !== cardEl);
    let inserted = false;
    for (let sibling of siblings) {
      if (parseFloat(sibling.dataset.position) > card.position) {
        if (cardEl.nextElementSibling !== sibling) {
          listEl.insertBefore(cardEl, sibling);
        }
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      if (listEl.lastElementChild !== cardEl) {
        listEl.appendChild(cardEl);
      }
    }
  }
}

function setupSSE() {
  const eventSource = new EventSource(`${API_URL}/stream`);
  
  eventSource.addEventListener('card_created', e => {
    const card = JSON.parse(e.data);
    const column = boardState.find(c => c.id == card.column_id);
    if (column) {
      column.cards.push(card);
      updateCardInDOM(card);
    }
  });
  
  eventSource.addEventListener('card_moved', e => {
    const updatedCard = JSON.parse(e.data);
    
    // Remove from old column
    boardState.forEach(col => {
      col.cards = col.cards.filter(c => c.id != updatedCard.id);
    });
    
    // Add to new column
    const column = boardState.find(c => c.id == updatedCard.column_id);
    if (column) {
      column.cards.push(updatedCard);
      updateCardInDOM(updatedCard);
    }
  });
  
  eventSource.addEventListener('column_renormalized', e => {
    const { columnId, cards } = JSON.parse(e.data);
    const column = boardState.find(c => c.id == columnId);
    if (column) {
      column.cards = cards;
      cards.forEach(card => updateCardInDOM(card));
    }
  });
}

fetchBoard().then(setupSSE);
