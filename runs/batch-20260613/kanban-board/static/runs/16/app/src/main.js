let boardData = [];

async function init() {
  const res = await fetch('/api/board');
  boardData = await res.json();
  renderBoard();
  setupSSE();
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
    
    column.cards.sort((a, b) => a.position - b.position).forEach(card => {
      listEl.appendChild(createCardElement(card));
    });
    
    colEl.appendChild(listEl);
    
    const formEl = document.createElement('form');
    formEl.className = 'add-card-form';
    formEl.onsubmit = async (e) => {
      e.preventDefault();
      const input = formEl.querySelector('input');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      
      // Optimistic UI could be added here, but for simplicity we just wait for SSE or response
      const res = await fetch('/api/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId: column.id, text })
      });
      const newCard = await res.json();
      // We rely on SSE to update the board, but we can also update locally if SSE is slow
    };
    
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
      e.dataTransfer.setData('text/plain', e.target.dataset.id);
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
    if (!draggedCard) return;
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
    
    // Determine beforeId and afterId
    const prevCard = draggedCard.previousElementSibling;
    const nextCard = draggedCard.nextElementSibling;
    
    const afterId = prevCard ? prevCard.dataset.id : null;
    const beforeId = nextCard ? nextCard.dataset.id : null;
    
    // Optimistic update
    // We already moved the DOM element.
    
    await fetch(`/api/cards/${cardId}/move`, {
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
  const evtSource = new EventSource('/api/stream');
  
  evtSource.addEventListener('card_created', e => {
    const card = JSON.parse(e.data);
    const col = boardData.find(c => c.id === card.column_id);
    if (col) {
      col.cards.push(card);
      // Update DOM if not already there
      if (!document.querySelector(`.card[data-id="${card.id}"]`)) {
        const listEl = document.querySelector(`.card-list[data-column-id="${card.column_id}"]`);
        if (listEl) {
          listEl.appendChild(createCardElement(card));
        }
      }
    }
  });
  
  evtSource.addEventListener('card_moved', e => {
    const updatedCard = JSON.parse(e.data);
    
    // Remove from old column in data
    boardData.forEach(col => {
      col.cards = col.cards.filter(c => c.id !== updatedCard.id);
    });
    
    // Add to new column in data
    const col = boardData.find(c => c.id === updatedCard.column_id);
    if (col) {
      col.cards.push(updatedCard);
      col.cards.sort((a, b) => a.position - b.position);
    }
    
    // Update DOM
    let existingCardEl = document.querySelector(`.card[data-id="${updatedCard.id}"]`);
    if (!existingCardEl) {
      existingCardEl = createCardElement(updatedCard);
    }
    
    existingCardEl.dataset.position = updatedCard.position;
    
    if (existingCardEl.classList.contains('dragging')) {
      return;
    }
    
    const listEl = document.querySelector(`.card-list[data-column-id="${updatedCard.column_id}"]`);
    
    if (listEl) {
      // Find correct position in DOM
      const cards = [...listEl.querySelectorAll('.card')].filter(c => c !== existingCardEl);
      let inserted = false;
      for (const cardEl of cards) {
        if (parseFloat(cardEl.dataset.position) > updatedCard.position) {
          listEl.insertBefore(existingCardEl, cardEl);
          inserted = true;
          break;
        }
      }
      if (!inserted) {
        listEl.appendChild(existingCardEl);
      }
    }
  });
  
  evtSource.addEventListener('column_renormalized', async e => {
    // Fetch full board again to be safe
    const res = await fetch('/api/board');
    boardData = await res.json();
    renderBoard();
  });
}

init();
