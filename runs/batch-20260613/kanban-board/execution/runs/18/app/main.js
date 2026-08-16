const API_URL = 'http://localhost:3000/api';

let boardData = [];
let draggedCard = null;

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
    
    colEl.appendChild(listEl);
    
    const addEl = document.createElement('div');
    addEl.className = 'add-card';
    addEl.textContent = '+ Add a card';
    addEl.onclick = () => addCard(column.id);
    colEl.appendChild(addEl);
    
    boardEl.appendChild(colEl);
  });
  
  setupListDrop();
  syncDOM();
}

function createCardElement(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.draggable = true;
  cardEl.dataset.id = card.id;
  cardEl.textContent = card.text;
  return cardEl;
}

function setupCardDrag(card) {
  card.addEventListener('dragstart', () => {
    draggedCard = card;
    setTimeout(() => card.classList.add('dragging'), 0);
  });
  
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    draggedCard = null;
    syncDOM();
  });
}

function syncDOM() {
  boardData.forEach(column => {
    const listEl = document.querySelector(`.card-list[data-column-id="${column.id}"]`);
    if (!listEl) return;
    
    column.cards.sort((a, b) => {
      if (a.position === b.position) return a.id - b.id;
      return a.position - b.position;
    });
    
    column.cards.forEach((card, index) => {
      let cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
      if (!cardEl) {
        cardEl = createCardElement(card);
        setupCardDrag(cardEl);
      }
      
      if (cardEl.classList.contains('dragging')) {
        return;
      }
      
      if (cardEl.parentElement !== listEl) {
        listEl.appendChild(cardEl);
      }
      
      const expectedSibling = listEl.children[index];
      if (expectedSibling !== cardEl) {
        listEl.insertBefore(cardEl, expectedSibling);
      }
      
      if (cardEl.textContent !== card.text) {
        cardEl.textContent = card.text;
      }
    });
  });
}

async function addCard(columnId) {
  const text = prompt('Enter card text:');
  if (!text) return;
  
  await fetch(`${API_URL}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text })
  });
}

function setupListDrop() {
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
      
      const prevCard = draggedCard.previousElementSibling;
      const nextCard = draggedCard.nextElementSibling;
      
      const afterId = prevCard ? parseInt(prevCard.dataset.id) : null;
      const beforeId = nextCard ? parseInt(nextCard.dataset.id) : null;
      
      // Optimistic update
      boardData.forEach(col => {
        col.cards = col.cards.filter(c => c.id !== cardId);
      });
      const col = boardData.find(c => c.id === columnId);
      if (col) {
        let newPos = 0;
        let beforePos = null;
        let afterPos = null;
        
        if (beforeId) {
          const bCard = col.cards.find(c => c.id === beforeId);
          if (bCard) beforePos = bCard.position;
        }
        if (afterId) {
          const aCard = col.cards.find(c => c.id === afterId);
          if (aCard) afterPos = aCard.position;
        }
        
        if (beforePos !== null && afterPos !== null) {
          newPos = (beforePos + afterPos) / 2;
        } else if (beforePos !== null) {
          newPos = beforePos - 1000;
        } else if (afterPos !== null) {
          newPos = afterPos + 1000;
        } else {
          const maxPos = col.cards.length > 0 ? Math.max(...col.cards.map(c => c.position)) : 0;
          newPos = maxPos + 1000;
        }
        
        col.cards.push({
          id: cardId,
          column_id: columnId,
          text: draggedCard.textContent,
          position: newPos
        });
      }
      
      try {
        await fetch(`${API_URL}/cards/${cardId}/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId, beforeId, afterId })
        });
      } catch (err) {
        console.error(err);
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

const eventSource = new EventSource(`${API_URL}/stream`);
eventSource.onmessage = (e) => {
  const data = JSON.parse(e.data);
  
  if (data.type === 'CARD_CREATED') {
    const col = boardData.find(c => c.id === data.card.column_id);
    if (col) {
      col.cards.push(data.card);
      syncDOM();
    }
  } else if (data.type === 'CARD_MOVED') {
    boardData.forEach(col => {
      col.cards = col.cards.filter(c => c.id !== data.card.id);
    });
    const col = boardData.find(c => c.id === data.card.column_id);
    if (col) {
      col.cards.push(data.card);
      syncDOM();
    }
  } else if (data.type === 'COLUMN_RENORMALIZED') {
    const col = boardData.find(c => c.id === data.columnId);
    if (col) {
      col.cards = data.cards;
      syncDOM();
    }
  }
};

fetchBoard();
