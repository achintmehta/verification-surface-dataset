const boardEl = document.getElementById('board');

let columns = [];
let cards = {};

async function fetchBoard() {
  const res = await fetch('/api/board');
  columns = await res.json();
  
  columns.forEach(col => {
    col.cards.forEach(card => {
      cards[card.id] = card;
    });
  });
  
  renderBoard();
}

function renderBoard() {
  boardEl.innerHTML = '';
  columns.forEach(col => {
    const colEl = document.createElement('div');
    colEl.className = 'column';
    colEl.dataset.id = col.id;
    
    const headerEl = document.createElement('div');
    headerEl.className = 'column-header';
    headerEl.textContent = col.title;
    colEl.appendChild(headerEl);
    
    const cardsEl = document.createElement('div');
    cardsEl.className = 'column-cards';
    cardsEl.dataset.columnId = col.id;
    
    col.cards.sort((a, b) => {
      if (a.position === b.position) return a.id - b.id;
      return a.position - b.position;
    }).forEach(card => {
      const cardEl = createCardElement(card);
      cardsEl.appendChild(cardEl);
    });
    
    colEl.appendChild(cardsEl);
    
    const addCardEl = document.createElement('div');
    addCardEl.className = 'add-card';
    addCardEl.textContent = '+ Add a card';
    addCardEl.onclick = () => {
      addCardEl.style.display = 'none';
      formEl.classList.add('active');
      textarea.focus();
    };
    
    const formEl = document.createElement('div');
    formEl.className = 'add-card-form';
    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Enter a title for this card...';
    const btn = document.createElement('button');
    btn.textContent = 'Add Card';
    
    btn.onclick = async () => {
      const text = textarea.value.trim();
      if (text) {
        await fetch('/api/cards', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId: col.id, text })
        });
        textarea.value = '';
        formEl.classList.remove('active');
        addCardEl.style.display = 'block';
      }
    };
    
    formEl.appendChild(textarea);
    formEl.appendChild(btn);
    
    colEl.appendChild(addCardEl);
    colEl.appendChild(formEl);
    
    boardEl.appendChild(colEl);
  });
  
  setupDragAndDrop();
}

function createCardElement(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.id = card.id;
  el.textContent = card.text;
  el.draggable = true;
  return el;
}

let draggedCard = null;

function setupDragAndDrop() {
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
      syncBoard(); // Sync in case we missed events while dragging
    }
  });
  
  boardEl.addEventListener('dragover', e => {
    e.preventDefault();
    const container = e.target.closest('.column-cards');
    if (!container) return;
    
    const afterElement = getDragAfterElement(container, e.clientY);
    if (afterElement == null) {
      container.appendChild(draggedCard);
    } else {
      container.insertBefore(draggedCard, afterElement);
    }
  });
  
  boardEl.addEventListener('drop', async e => {
    e.preventDefault();
    if (!draggedCard) return;
    
    const container = draggedCard.closest('.column-cards');
    if (!container) return;
    
    const columnId = parseInt(container.dataset.columnId);
    const cardId = parseInt(draggedCard.dataset.id);
    
    const cardElements = [...container.querySelectorAll('.card')];
    const index = cardElements.indexOf(draggedCard);
    
    const beforeId = index > 0 ? parseInt(cardElements[index - 1].dataset.id) : null;
    const afterId = index < cardElements.length - 1 ? parseInt(cardElements[index + 1].dataset.id) : null;
    
    // Optimistic update
    const card = cards[cardId];
    if (card) {
      const oldColId = card.column_id;
      card.column_id = columnId;
      
      // Remove from old column
      const oldCol = columns.find(c => c.id === oldColId);
      if (oldCol) {
        oldCol.cards = oldCol.cards.filter(c => c.id !== cardId);
      }
      
      // Add to new column
      const newCol = columns.find(c => c.id === columnId);
      if (newCol && !newCol.cards.find(c => c.id === cardId)) {
        newCol.cards.push(card);
      }

      // Optimistic position
      let newPos = 0;
      if (beforeId && afterId && cards[beforeId] && cards[afterId]) {
        newPos = (cards[beforeId].position + cards[afterId].position) / 2;
      } else if (beforeId && cards[beforeId]) {
        newPos = cards[beforeId].position + 1000;
      } else if (afterId && cards[afterId]) {
        newPos = cards[afterId].position - 1000;
      } else {
        const maxPos = newCol.cards.reduce((max, c) => Math.max(max, c.position), 0);
        newPos = maxPos + 1000;
      }
      card.position = newPos;
    }
    
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

function syncBoard() {
  if (draggedCard) return; // Don't sync while dragging to avoid interrupting
  
  columns.forEach(col => {
    const cardsEl = document.querySelector(`.column-cards[data-column-id="${col.id}"]`);
    if (!cardsEl) return;
    
    // Sort cards by position
    col.cards.sort((a, b) => {
      if (a.position === b.position) return a.id - b.id;
      return a.position - b.position;
    });
    
    // Reorder DOM elements
    col.cards.forEach((card, index) => {
      let cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
      if (!cardEl) {
        cardEl = createCardElement(card);
      } else {
        cardEl.textContent = card.text; // Update text if needed
      }
      
      if (cardsEl.children[index] !== cardEl) {
        cardsEl.insertBefore(cardEl, cardsEl.children[index] || null);
      }
    });
    
    // Remove cards that are no longer in this column
    const currentCardIds = new Set(col.cards.map(c => c.id.toString()));
    [...cardsEl.children].forEach(child => {
      if (!currentCardIds.has(child.dataset.id)) {
        child.remove();
      }
    });
  });
}

function setupSSE() {
  const evtSource = new EventSource('/api/stream');
  
  evtSource.addEventListener('card_created', e => {
    const card = JSON.parse(e.data);
    cards[card.id] = card;
    const col = columns.find(c => c.id === card.column_id);
    if (col) {
      col.cards.push(card);
      syncBoard();
    }
  });
  
  evtSource.addEventListener('card_moved', e => {
    const updatedCard = JSON.parse(e.data);
    const cardId = updatedCard.id;
    
    // Remove from old column
    columns.forEach(col => {
      col.cards = col.cards.filter(c => c.id !== cardId);
    });
    
    cards[cardId] = updatedCard;
    
    // Add to new column
    const col = columns.find(c => c.id === updatedCard.column_id);
    if (col) {
      col.cards.push(updatedCard);
      syncBoard();
    }
  });
  
  evtSource.addEventListener('column_renormalized', e => {
    const { columnId, cards: reorderedCards } = JSON.parse(e.data);
    
    // Remove these cards from all columns first to prevent duplicates
    const reorderedCardIds = new Set(reorderedCards.map(c => c.id));
    columns.forEach(col => {
      col.cards = col.cards.filter(c => !reorderedCardIds.has(c.id));
    });
    
    const col = columns.find(c => c.id === columnId);
    if (col) {
      col.cards = reorderedCards;
      reorderedCards.forEach(card => {
        cards[card.id] = card;
      });
      syncBoard();
    }
  });
}

fetchBoard().then(setupSSE);
