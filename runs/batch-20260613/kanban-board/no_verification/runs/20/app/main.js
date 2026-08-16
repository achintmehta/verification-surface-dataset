let boardData = [];
let isDragging = false;
let pendingUpdates = false;

async function fetchBoard() {
  const res = await fetch('/api/board');
  boardData = await res.json();
  renderBoard();
}

function renderBoard() {
  if (isDragging) {
    pendingUpdates = true;
    return;
  }

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

    const cardListEl = document.createElement('div');
    cardListEl.className = 'card-list';
    cardListEl.dataset.columnId = column.id;
    
    column.cards.sort((a, b) => a.position - b.position).forEach(card => {
      const cardEl = createCardElement(card);
      cardListEl.appendChild(cardEl);
    });

    colEl.appendChild(cardListEl);

    const addCardBtn = document.createElement('div');
    addCardBtn.className = 'add-card';
    addCardBtn.textContent = '+ Add a card';
    
    const addCardForm = document.createElement('div');
    addCardForm.className = 'add-card-form';
    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Enter a title for this card...';
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Add Card';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'X';
    
    addCardForm.appendChild(textarea);
    addCardForm.appendChild(saveBtn);
    addCardForm.appendChild(cancelBtn);

    addCardBtn.addEventListener('click', () => {
      addCardBtn.style.display = 'none';
      addCardForm.classList.add('active');
      textarea.focus();
    });

    cancelBtn.addEventListener('click', () => {
      addCardBtn.style.display = 'block';
      addCardForm.classList.remove('active');
      textarea.value = '';
    });

    saveBtn.addEventListener('click', async () => {
      const text = textarea.value.trim();
      if (text) {
        await fetch('/api/cards', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId: column.id, text })
        });
        addCardBtn.style.display = 'block';
        addCardForm.classList.remove('active');
        textarea.value = '';
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

let draggedCard = null;

function setupDragAndDrop() {
  const cards = document.querySelectorAll('.card');
  const cardLists = document.querySelectorAll('.card-list');

  cards.forEach(card => {
    card.addEventListener('dragstart', () => {
      isDragging = true;
      draggedCard = card;
      setTimeout(() => card.classList.add('dragging'), 0);
    });

    card.addEventListener('dragend', () => {
      isDragging = false;
      draggedCard.classList.remove('dragging');
      draggedCard = null;
      if (pendingUpdates) {
        renderBoard();
        pendingUpdates = false;
      }
    });
  });

  cardLists.forEach(list => {
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

      const columnId = parseInt(list.dataset.columnId);
      const cardId = parseInt(draggedCard.dataset.id);
      
      const afterElement = draggedCard.nextElementSibling;
      const beforeElement = draggedCard.previousElementSibling;

      const afterId = afterElement ? parseInt(afterElement.dataset.id) : null;
      const beforeId = beforeElement ? parseInt(beforeElement.dataset.id) : null;

      // Optimistic update: we don't update boardData here, we wait for SSE.
      // But we leave the DOM as is. When SSE arrives, it will re-render and snap to canonical.
      
      await fetch(`/api/cards/${cardId}/move`, {
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

// SSE
const evtSource = new EventSource('/api/stream');

evtSource.addEventListener('card_created', (e) => {
  const card = JSON.parse(e.data);
  const column = boardData.find(c => c.id === card.column_id);
  if (column) {
    column.cards.push(card);
    renderBoard();
  }
});

evtSource.addEventListener('card_moved', (e) => {
  const movedCard = JSON.parse(e.data);
  
  // Remove from old column
  boardData.forEach(col => {
    col.cards = col.cards.filter(c => c.id !== movedCard.id);
  });

  // Add to new column
  const column = boardData.find(c => c.id === movedCard.column_id);
  if (column) {
    column.cards.push(movedCard);
    column.cards.sort((a, b) => a.position - b.position);
  }
  
  renderBoard();
});

evtSource.addEventListener('column_renormalized', (e) => {
  const { columnId, cards } = JSON.parse(e.data);
  const column = boardData.find(c => c.id === columnId);
  if (column) {
    column.cards = cards;
    renderBoard();
  }
});

fetchBoard();