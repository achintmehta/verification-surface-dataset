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

  boardData.forEach(col => {
    const colEl = document.createElement('div');
    colEl.className = 'column';
    colEl.dataset.id = col.id;

    const headerEl = document.createElement('div');
    headerEl.className = 'column-header';
    headerEl.textContent = col.title;
    colEl.appendChild(headerEl);

    const listEl = document.createElement('div');
    listEl.className = 'card-list';
    listEl.dataset.columnId = col.id;

    col.cards.sort((a, b) => a.position - b.position).forEach(card => {
      const cardEl = createCardElement(card);
      listEl.appendChild(cardEl);
    });

    colEl.appendChild(listEl);
    boardEl.appendChild(colEl);
  });

  setupDragAndDrop();
}

function createCardElement(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.dataset.id = card.id;
  cardEl.textContent = card.text;
  cardEl.draggable = true;
  return cardEl;
}

document.getElementById('add-card-btn').addEventListener('click', async () => {
  const text = prompt('Enter card text:');
  if (!text) return;

  const firstCol = boardData[0];
  if (!firstCol) return;

  await fetch(`${API_URL}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, columnId: firstCol.id })
  });
});

function setupDragAndDropForCard(card) {
  card.addEventListener('dragstart', () => {
    card.classList.add('dragging');
  });

  card.addEventListener('dragend', async () => {
    card.classList.remove('dragging');
    
    const list = card.closest('.card-list');
    if (!list) return;

    const cardId = card.dataset.id;
    const columnId = list.dataset.columnId;

    const cardsInList = [...list.querySelectorAll('.card')];
    const draggedIndex = cardsInList.indexOf(card);
    
    let beforeId = null;
    let afterId = null;

    if (draggedIndex < cardsInList.length - 1) {
      beforeId = cardsInList[draggedIndex + 1].dataset.id;
    }
    if (draggedIndex > 0) {
      afterId = cardsInList[draggedIndex - 1].dataset.id;
    }

    let movedCard = null;
    for (const col of boardData) {
      const idx = col.cards.findIndex(c => c.id === cardId);
      if (idx !== -1) {
        movedCard = col.cards.splice(idx, 1)[0];
        break;
      }
    }

    if (movedCard) {
      movedCard.column_id = columnId;
      const targetCol = boardData.find(c => c.id === columnId);
      if (targetCol) {
        targetCol.cards.push(movedCard);
      }
    }

    await fetch(`${API_URL}/cards/${cardId}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId })
    });
  });
}

function setupDragAndDrop() {
  const cards = document.querySelectorAll('.card');
  cards.forEach(setupDragAndDropForCard);

  const lists = document.querySelectorAll('.card-list');
  lists.forEach(list => {
    list.addEventListener('dragover', e => {
      e.preventDefault();
      const afterElement = getDragAfterElement(list, e.clientY);
      const draggable = document.querySelector('.dragging');
      if (!draggable) return;
      if (afterElement == null) {
        list.appendChild(draggable);
      } else {
        list.insertBefore(draggable, afterElement);
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

function updateColumnDOM(columnId) {
  const col = boardData.find(c => c.id === columnId);
  if (!col) return;

  const listEl = document.querySelector(`.card-list[data-column-id="${columnId}"]`);
  if (!listEl) return;

  col.cards.sort((a, b) => a.position - b.position);

  let currentDOMNode = listEl.firstElementChild;

  col.cards.forEach(c => {
    let el = document.querySelector(`.card[data-id="${c.id}"]`);
    if (!el) {
      el = createCardElement(c);
      setupDragAndDropForCard(el);
    }
    
    if (el.classList.contains('dragging')) {
      return;
    }

    while (currentDOMNode && currentDOMNode.classList.contains('dragging')) {
      currentDOMNode = currentDOMNode.nextElementSibling;
    }

    if (currentDOMNode !== el) {
      listEl.insertBefore(el, currentDOMNode);
    } else {
      currentDOMNode = currentDOMNode.nextElementSibling;
    }
  });
}

const eventSource = new EventSource(`${API_URL}/stream`);

eventSource.addEventListener('card_created', (e) => {
  const newCard = JSON.parse(e.data);
  const col = boardData.find(c => c.id === newCard.column_id);
  if (col) {
    const exists = col.cards.find(c => c.id === newCard.id);
    if (!exists) {
      col.cards.push(newCard);
      updateColumnDOM(newCard.column_id);
    }
  }
});

eventSource.addEventListener('card_moved', (e) => {
  const updatedCard = JSON.parse(e.data);
  
  let oldColumnId = null;
  boardData.forEach(col => {
    const idx = col.cards.findIndex(c => c.id === updatedCard.id);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      oldColumnId = col.id;
    }
  });

  const col = boardData.find(c => c.id === updatedCard.column_id);
  if (col) {
    col.cards.push(updatedCard);
  }

  if (oldColumnId && oldColumnId !== updatedCard.column_id) {
    updateColumnDOM(oldColumnId);
  }
  updateColumnDOM(updatedCard.column_id);
});

eventSource.addEventListener('column_renormalized', (e) => {
  const { columnId, cards } = JSON.parse(e.data);
  const col = boardData.find(c => c.id === columnId);
  if (col) {
    col.cards = cards;
    updateColumnDOM(columnId);
  }
});

fetchBoard();
