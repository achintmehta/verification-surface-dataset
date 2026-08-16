const API_URL = '/api';

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
    
    column.cards.forEach(card => {
      const cardEl = createCardElement(card);
      listEl.appendChild(cardEl);
    });

    colEl.appendChild(listEl);

    const formEl = document.createElement('form');
    formEl.className = 'add-card-form';
    formEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = formEl.querySelector('input');
      const text = input.value.trim();
      if (text) {
        input.value = '';
        await createCard(column.id, text);
      }
    });

    const inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.placeholder = 'Add a card...';
    formEl.appendChild(inputEl);
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

function setupDragAndDropForCard(card) {
  card.addEventListener('dragstart', () => {
    card.classList.add('dragging');
  });

  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
  });
}

function setupDragAndDrop() {
  const cards = document.querySelectorAll('.card');
  const lists = document.querySelectorAll('.card-list');

  cards.forEach(setupDragAndDropForCard);

  lists.forEach(list => {
    list.addEventListener('dragover', e => {
      e.preventDefault();
      const afterElement = getDragAfterElement(list, e.clientY);
      const draggable = document.querySelector('.dragging');
      if (afterElement == null) {
        list.appendChild(draggable);
      } else {
        list.insertBefore(draggable, afterElement);
      }
    });

    list.addEventListener('drop', async e => {
      e.preventDefault();
      const draggable = document.querySelector('.dragging');
      const cardId = draggable.dataset.id;
      const columnId = list.dataset.columnId;
      
      const prevElement = draggable.previousElementSibling;
      const nextElement = draggable.nextElementSibling;

      let beforeId = null;
      let afterId = null;

      if (prevElement && prevElement.classList.contains('card')) {
        afterId = prevElement.dataset.id;
      }
      if (nextElement && nextElement.classList.contains('card')) {
        beforeId = nextElement.dataset.id;
      }

      // Optimistic update is already done by DOM manipulation
      // Now send to server
      await fetch(`${API_URL}/cards/${cardId}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          columnId: parseInt(columnId),
          beforeId: beforeId ? parseInt(beforeId) : null,
          afterId: afterId ? parseInt(afterId) : null
        })
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

function setupSSE() {
  const eventSource = new EventSource(`${API_URL}/stream`);

  eventSource.addEventListener('card_created', (e) => {
    const card = JSON.parse(e.data);
    const column = boardState.find(c => c.id === card.column_id);
    if (column) {
      column.cards.push(card);
      column.cards.sort((a, b) => a.position !== b.position ? a.position - b.position : a.id - b.id);
      
      const listEl = document.querySelector(`.card-list[data-column-id="${card.column_id}"]`);
      if (listEl) {
        const cardEl = createCardElement(card);
        listEl.appendChild(cardEl);
        setupDragAndDropForCard(cardEl);
      }
    }
  });

  eventSource.addEventListener('card_moved', (e) => {
    const updatedCard = JSON.parse(e.data);
    
    // Remove from old column
    boardState.forEach(col => {
      col.cards = col.cards.filter(c => c.id !== updatedCard.id);
    });

    // Add to new column
    const column = boardState.find(c => c.id === updatedCard.column_id);
    if (column) {
      column.cards.push(updatedCard);
      column.cards.sort((a, b) => a.position !== b.position ? a.position - b.position : a.id - b.id);
    }
    
    const cardEl = document.querySelector(`.card[data-id="${updatedCard.id}"]`);
    if (cardEl && column) {
      const listEl = document.querySelector(`.card-list[data-column-id="${updatedCard.column_id}"]`);
      if (listEl) {
        const index = column.cards.findIndex(c => c.id === updatedCard.id);
        if (index === column.cards.length - 1) {
          listEl.appendChild(cardEl);
        } else {
          const nextCard = column.cards[index + 1];
          const nextCardEl = document.querySelector(`.card[data-id="${nextCard.id}"]`);
          if (nextCardEl) {
            listEl.insertBefore(cardEl, nextCardEl);
          } else {
            listEl.appendChild(cardEl);
          }
        }
      }
    }
  });

  eventSource.addEventListener('column_renormalized', (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    const column = boardState.find(c => c.id === columnId);
    if (column) {
      column.cards = cards;
      renderBoard();
    }
  });
}

fetchBoard().then(() => {
  setupSSE();
});
