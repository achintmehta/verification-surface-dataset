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
    
    listEl.addEventListener('dragover', handleDragOver);
    listEl.addEventListener('drop', handleDrop);

    column.cards.forEach(card => {
      const cardEl = createCardElement(card);
      listEl.appendChild(cardEl);
    });

    colEl.appendChild(listEl);

    const formEl = document.createElement('form');
    formEl.className = 'add-card-form';
    formEl.addEventListener('submit', (e) => handleAddCard(e, column.id));

    const inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.placeholder = 'Add a card...';
    inputEl.required = true;

    const btnEl = document.createElement('button');
    btnEl.type = 'submit';
    btnEl.textContent = 'Add';

    formEl.appendChild(inputEl);
    formEl.appendChild(btnEl);
    colEl.appendChild(formEl);

    boardEl.appendChild(colEl);
  });
}

function createCardElement(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.draggable = true;
  cardEl.dataset.id = card.id;
  cardEl.textContent = card.text;

  cardEl.addEventListener('dragstart', handleDragStart);
  cardEl.addEventListener('dragend', handleDragEnd);

  return cardEl;
}

let draggedCardId = null;

function handleDragStart(e) {
  draggedCardId = parseInt(e.target.dataset.id);
  e.target.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function handleDragEnd(e) {
  e.target.classList.remove('dragging');
  draggedCardId = null;
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  
  const listEl = e.currentTarget;
  const afterElement = getDragAfterElement(listEl, e.clientY);
  const draggingCard = document.querySelector('.dragging');
  
  if (!draggingCard) return;

  if (afterElement == null) {
    listEl.appendChild(draggingCard);
  } else {
    listEl.insertBefore(draggingCard, afterElement);
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

async function handleDrop(e) {
  e.preventDefault();
  const listEl = e.currentTarget;
  const columnId = parseInt(listEl.dataset.columnId);
  
  const draggingCard = document.querySelector('.dragging');
  if (!draggingCard) return;

  const cardId = parseInt(draggingCard.dataset.id);
  
  const cardsInList = [...listEl.querySelectorAll('.card')];
  const cardIndex = cardsInList.indexOf(draggingCard);
  
  const beforeCard = cardsInList[cardIndex + 1];
  const afterCard = cardsInList[cardIndex - 1];
  
  const beforeId = beforeCard ? parseInt(beforeCard.dataset.id) : null;
  const afterId = afterCard ? parseInt(afterCard.dataset.id) : null;

  updateLocalCardPosition(cardId, columnId, beforeId, afterId);

  try {
    const res = await fetch(`${API_URL}/cards/${cardId}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId })
    });
    if (!res.ok) throw new Error('Failed to move card');
  } catch (err) {
    console.error(err);
    fetchBoard();
  }
}

function updateLocalCardPosition(cardId, columnId, beforeId, afterId) {
  let cardToMove = null;
  for (const col of boardState) {
    const idx = col.cards.findIndex(c => c.id === cardId);
    if (idx !== -1) {
      cardToMove = col.cards.splice(idx, 1)[0];
      break;
    }
  }

  if (!cardToMove) return;

  cardToMove.column_id = columnId;

  const targetCol = boardState.find(c => c.id === columnId);
  if (!targetCol) return;

  if (!beforeId && !afterId) {
    targetCol.cards.push(cardToMove);
  } else if (!beforeId) {
    targetCol.cards.push(cardToMove);
  } else if (!afterId) {
    targetCol.cards.unshift(cardToMove);
  } else {
    const beforeIdx = targetCol.cards.findIndex(c => c.id === beforeId);
    targetCol.cards.splice(beforeIdx, 0, cardToMove);
  }
}

async function handleAddCard(e, columnId) {
  e.preventDefault();
  const input = e.target.querySelector('input');
  const text = input.value.trim();
  if (!text) return;

  input.value = '';

  try {
    const res = await fetch(`${API_URL}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text })
    });
    if (!res.ok) throw new Error('Failed to add card');
  } catch (err) {
    console.error(err);
  }
}

function setupSSE() {
  const eventSource = new EventSource(`${API_URL}/stream`);

  eventSource.addEventListener('card_created', (e) => {
    const newCard = JSON.parse(e.data);
    const col = boardState.find(c => c.id === newCard.column_id);
    if (col) {
      if (!col.cards.find(c => c.id === newCard.id)) {
        col.cards.push(newCard);
        col.cards.sort((a, b) => a.position - b.position);
        
        const listEl = document.querySelector(`.card-list[data-column-id="${newCard.column_id}"]`);
        if (listEl) {
          const cardEl = createCardElement(newCard);
          const cardIndex = col.cards.findIndex(c => c.id === newCard.id);
          const nextCard = col.cards[cardIndex + 1];
          if (nextCard) {
            const nextCardEl = document.querySelector(`.card[data-id="${nextCard.id}"]`);
            if (nextCardEl) {
              listEl.insertBefore(cardEl, nextCardEl);
            } else {
              listEl.appendChild(cardEl);
            }
          } else {
            listEl.appendChild(cardEl);
          }
        }
      }
    }
  });

  eventSource.addEventListener('card_moved', (e) => {
    const updatedCard = JSON.parse(e.data);
    
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
      targetCol.cards.sort((a, b) => a.position - b.position);
      
      let cardEl = document.querySelector(`.card[data-id="${updatedCard.id}"]`);
      if (!cardEl) {
        cardEl = createCardElement(updatedCard);
      }
      const listEl = document.querySelector(`.card-list[data-column-id="${updatedCard.column_id}"]`);
      
      if (listEl) {
        const cardIndex = targetCol.cards.findIndex(c => c.id === updatedCard.id);
        const nextCard = targetCol.cards[cardIndex + 1];
        
        if (nextCard) {
          const nextCardEl = document.querySelector(`.card[data-id="${nextCard.id}"]`);
          if (nextCardEl) {
            listEl.insertBefore(cardEl, nextCardEl);
          } else {
            listEl.appendChild(cardEl);
          }
        } else {
          listEl.appendChild(cardEl);
        }
      }
    }
  });

  eventSource.addEventListener('column_renormalized', (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    const col = boardState.find(c => c.id === columnId);
    if (col) {
      col.cards = cards;
      
      const listEl = document.querySelector(`.card-list[data-column-id="${columnId}"]`);
      if (listEl) {
        cards.forEach(card => {
          const cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
          if (cardEl) {
            listEl.appendChild(cardEl);
          }
        });
      }
    }
  });
}

fetchBoard().then(setupSSE);