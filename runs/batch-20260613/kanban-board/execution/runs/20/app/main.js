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
    column.cards.sort((a, b) => {
      if (a.position === b.position) return a.id - b.id;
      return a.position - b.position;
    });
    
    column.cards.forEach(card => {
      const cardEl = createCardElement(card);
      listEl.appendChild(cardEl);
    });

    colEl.appendChild(listEl);

    // Add card form
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

    colEl.appendChild(addCardForm);
    colEl.appendChild(addCardBtn);

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
  // Optimistic update could be done here, but we'll rely on SSE for simplicity
  // Actually, the prompt says "Optimistic UI: the dragging client updates immediately, then reconciles against the server's authoritative ordering."
  // For creation, we can just wait for SSE or do optimistic. Let's just do API call.
  await fetch(`${API_URL}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text })
  });
}

let draggedCard = null;
let isDragging = false;

function setupDragAndDrop() {
  const cards = document.querySelectorAll('.card');
  const lists = document.querySelectorAll('.card-list');

  cards.forEach(card => {
    card.addEventListener('dragstart', () => {
      draggedCard = card;
      isDragging = true;
      setTimeout(() => card.classList.add('dragging'), 0);
    });

    card.addEventListener('dragend', () => {
      if (draggedCard) {
        draggedCard.classList.remove('dragging');
      }
      draggedCard = null;
      isDragging = false;
    });
  });

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

      const cardId = parseInt(draggedCard.dataset.id);
      const columnId = parseInt(list.dataset.columnId);
      
      // Find before and after elements
      const nextElement = draggedCard.nextElementSibling;
      const prevElement = draggedCard.previousElementSibling;
      
      const beforeId = nextElement ? parseInt(nextElement.dataset.id) : null;
      const afterId = prevElement ? parseInt(prevElement.dataset.id) : null;

      // Optimistic update in local state
      const cardToMove = boardState.flatMap(c => c.cards).find(c => c.id === cardId);
      if (cardToMove) {
        boardState.forEach(col => {
          col.cards = col.cards.filter(c => c.id !== cardId);
        });
        const col = boardState.find(c => c.id === columnId);
        if (col) {
          let beforePos = null;
          let afterPos = null;
          if (beforeId) {
            const beforeCard = col.cards.find(c => c.id === beforeId);
            if (beforeCard) beforePos = beforeCard.position;
          }
          if (afterId) {
            const afterCard = col.cards.find(c => c.id === afterId);
            if (afterCard) afterPos = afterCard.position;
          }
          
          let newPos;
          if (beforePos !== null && afterPos !== null) {
            newPos = (beforePos + afterPos) / 2;
          } else if (beforePos !== null) {
            newPos = beforePos - 1000;
          } else if (afterPos !== null) {
            newPos = afterPos + 1000;
          } else {
            newPos = 1000;
          }
          
          cardToMove.column_id = columnId;
          cardToMove.position = newPos;
          col.cards.push(cardToMove);
          col.cards.sort((a, b) => {
            if (a.position === b.position) return a.id - b.id;
            return a.position - b.position;
          });
        }
      }
      
      // Send API request
      try {
        const res = await fetch(`${API_URL}/cards/${cardId}/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId, beforeId, afterId })
        });
        const updatedCard = await res.json();
        // Reconcile with server response
        updateCardInState(updatedCard);
        if (!isDragging) renderBoard();
      } catch (err) {
        console.error('Move failed', err);
        // Revert on failure by re-fetching
        fetchBoard();
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

function updateCardInState(updatedCard) {
  // Remove from old column
  boardState.forEach(col => {
    col.cards = col.cards.filter(c => c.id !== updatedCard.id);
  });
  
  // Add to new column
  const col = boardState.find(c => c.id === updatedCard.column_id);
  if (col) {
    col.cards.push(updatedCard);
    col.cards.sort((a, b) => {
      if (a.position === b.position) return a.id - b.id;
      return a.position - b.position;
    });
  }
}

function setupSSE() {
  const evtSource = new EventSource(`${API_URL}/stream`);
  
  evtSource.addEventListener('card_created', (e) => {
    const newCard = JSON.parse(e.data);
    updateCardInState(newCard);
    if (!isDragging) renderBoard();
  });

  evtSource.addEventListener('card_moved', (e) => {
    const updatedCard = JSON.parse(e.data);
    updateCardInState(updatedCard);
    if (!isDragging) renderBoard();
  });

  evtSource.addEventListener('column_renormalized', (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    const col = boardState.find(c => c.id === columnId);
    if (col) {
      col.cards = cards;
    }
    if (!isDragging) renderBoard();
  });
}

fetchBoard().then(() => {
  setupSSE();
});
