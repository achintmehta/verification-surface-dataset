const API_URL = 'http://localhost:3001/api';

let boardState = [];
let draggedCard = null;

async function init() {
  await fetchBoard();
  renderBoard();
  setupSSE();
}

async function fetchBoard() {
  const res = await fetch(`${API_URL}/board`);
  boardState = await res.json();
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
    
    column.cards.sort((a, b) => {
      if (a.position === b.position) {
        return a.id.localeCompare(b.id);
      }
      return a.position - b.position;
    });
    
    column.cards.forEach(card => {
      const cardEl = createCardElement(card);
      listEl.appendChild(cardEl);
    });

    colEl.appendChild(listEl);

    const formEl = document.createElement('form');
    formEl.className = 'add-card-form';
    formEl.innerHTML = `
      <input type="text" class="add-card-input" placeholder="Add a card..." required />
      <button type="submit" class="add-card-btn">Add</button>
    `;
    formEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = formEl.querySelector('.add-card-input');
      const text = input.value.trim();
      if (text) {
        input.value = '';
        await createCard(column.id, text);
      }
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
    cardEl.dataset.origColumnId = cardEl.dataset.columnId;
    cardEl.dataset.origNextSiblingId = cardEl.nextElementSibling ? cardEl.nextElementSibling.dataset.id : '';
    setTimeout(() => cardEl.classList.add('dragging'), 0);
  });

  cardEl.addEventListener('dragend', () => {
    draggedCard = null;
    cardEl.classList.remove('dragging');
  });

  return cardEl;
}

function setupDragAndDrop() {
  const lists = document.querySelectorAll('.card-list');
  
  lists.forEach(list => {
    list.addEventListener('dragover', e => {
      e.preventDefault();
      const afterElement = getDragAfterElement(list, e.clientY);
      if (draggedCard) {
        if (afterElement == null) {
          list.appendChild(draggedCard);
        } else {
          list.insertBefore(draggedCard, afterElement);
        }
      }
    });

    list.addEventListener('drop', async e => {
      e.preventDefault();
      if (!draggedCard) return;

      const cardId = draggedCard.dataset.id;
      const newColumnId = list.dataset.columnId;
      
      // Determine beforeId and afterId based on DOM
      const prevSibling = draggedCard.previousElementSibling;
      const nextSibling = draggedCard.nextElementSibling;
      
      const afterId = prevSibling ? prevSibling.dataset.id : null;
      const beforeId = nextSibling ? nextSibling.dataset.id : null;

      const origColumnId = draggedCard.dataset.origColumnId;
      const origNextSiblingId = draggedCard.dataset.origNextSiblingId;
      const currentNextSiblingId = beforeId || '';

      if (newColumnId === origColumnId && currentNextSiblingId === origNextSiblingId) {
        return;
      }

      // Optimistic update of dataset
      draggedCard.dataset.columnId = newColumnId;
      
      // Send request
      try {
        const res = await fetch(`${API_URL}/cards/${cardId}/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId: newColumnId, beforeId, afterId })
        });
        if (!res.ok) {
          console.error('Failed to move card');
          // Revert could be handled by refetching or waiting for SSE
        }
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

async function createCard(columnId, text) {
  await fetch(`${API_URL}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text })
  });
}

function setupSSE() {
  const evtSource = new EventSource(`${API_URL}/stream`);
  
  evtSource.addEventListener('card_created', (e) => {
    const card = JSON.parse(e.data);
    applyCardUpdate(card);
  });

  evtSource.addEventListener('card_moved', (e) => {
    const card = JSON.parse(e.data);
    applyCardUpdate(card);
  });

  evtSource.addEventListener('column_renormalized', (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    cards.forEach(card => applyCardUpdate(card));
  });
}

function applyCardUpdate(updatedCard) {
  // Update state
  for (const col of boardState) {
    const idx = col.cards.findIndex(c => c.id === updatedCard.id);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      break;
    }
  }
  const targetCol = boardState.find(c => c.id === updatedCard.column_id);
  if (targetCol) {
    targetCol.cards.push(updatedCard);
    targetCol.cards.sort((a, b) => {
      if (a.position === b.position) {
        return a.id.localeCompare(b.id);
      }
      return a.position - b.position;
    });
  }

  // Update DOM
  const existingCardEl = document.querySelector(`.card[data-id="${updatedCard.id}"]`);
  
  const listEl = document.querySelector(`.card-list[data-column-id="${updatedCard.column_id}"]`);
  if (!listEl) return;

  let cardEl = existingCardEl;
  if (!cardEl) {
    cardEl = createCardElement(updatedCard);
  } else {
    cardEl.dataset.position = updatedCard.position;
    cardEl.dataset.columnId = updatedCard.column_id;
  }

  // If we are currently dragging this card, we might not want to snap it immediately 
  // unless its position is drastically different. But to ensure convergence, we should snap it.
  // Actually, if it's the one being dragged, the user hasn't dropped it yet.
  // Wait, the server only broadcasts AFTER the drop (when the PATCH request is sent).
  // So if it's dragging, it's a concurrent move from another user?
  // If another user moved it, we should probably snap it.
  
  const cardsInList = Array.from(listEl.querySelectorAll('.card')).filter(c => c !== cardEl);
  
  let inserted = false;
  for (const sibling of cardsInList) {
    const siblingPos = parseFloat(sibling.dataset.position);
    if (updatedCard.position < siblingPos || (updatedCard.position === siblingPos && updatedCard.id.localeCompare(sibling.dataset.id) < 0)) {
      if (cardEl.nextElementSibling !== sibling) {
        listEl.insertBefore(cardEl, sibling);
      }
      inserted = true;
      break;
    }
  }
  if (!inserted) {
    if (cardEl.parentElement !== listEl || cardEl.nextElementSibling !== null) {
      listEl.appendChild(cardEl);
    }
  }
}

init();
