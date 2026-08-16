const boardEl = document.getElementById('board');

let columns = [];
let draggedCard = null;

async function fetchBoard() {
  const res = await fetch('/api/board');
  columns = await res.json();
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

    const listEl = document.createElement('div');
    listEl.className = 'card-list';
    listEl.dataset.columnId = col.id;
    
    col.cards.forEach(card => {
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
        await addCard(col.id, text);
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
  cardEl.textContent = card.text;
  return cardEl;
}

async function addCard(columnId, text) {
  await fetch('/api/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text })
  });
}

function setupDragAndDrop() {
  const cardLists = document.querySelectorAll('.card-list');

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
    }
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
      
      const prevElement = draggedCard.previousElementSibling;
      const nextElement = draggedCard.nextElementSibling;

      const prevId = prevElement ? parseInt(prevElement.dataset.id) : null;
      const nextId = nextElement ? parseInt(nextElement.dataset.id) : null;

      try {
        const res = await fetch(`/api/cards/${cardId}/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId, prevId, nextId })
        });
        const updatedCard = await res.json();
        draggedCard.dataset.position = updatedCard.position;
      } catch (err) {
        console.error('Failed to move card', err);
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

function setupSSE() {
  const evtSource = new EventSource('/api/stream');
  
  evtSource.addEventListener('card_created', (e) => {
    const card = JSON.parse(e.data);
    if (document.querySelector(`.card[data-id="${card.id}"]`)) return;
    
    const listEl = document.querySelector(`.card-list[data-column-id="${card.column_id}"]`);
    if (listEl) {
      const cardEl = createCardElement(card);
      listEl.appendChild(cardEl);
      
      const col = columns.find(c => c.id === card.column_id);
      if (col) col.cards.push(card);
    }
  });

  evtSource.addEventListener('card_moved', (e) => {
    const card = JSON.parse(e.data);
    const cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
    
    if (cardEl) {
      cardEl.dataset.position = card.position;
      
      const listEl = document.querySelector(`.card-list[data-column-id="${card.column_id}"]`);
      if (listEl) {
        const siblings = [...listEl.querySelectorAll('.card')].filter(c => c !== cardEl);
        const nextSibling = siblings.find(c => parseFloat(c.dataset.position) > card.position);
        
        if (nextSibling) {
          listEl.insertBefore(cardEl, nextSibling);
        } else {
          listEl.appendChild(cardEl);
        }
      }
    } else {
      const listEl = document.querySelector(`.card-list[data-column-id="${card.column_id}"]`);
      if (listEl) {
        const newCardEl = createCardElement(card);
        const siblings = [...listEl.querySelectorAll('.card')];
        const nextSibling = siblings.find(c => parseFloat(c.dataset.position) > card.position);
        if (nextSibling) {
          listEl.insertBefore(newCardEl, nextSibling);
        } else {
          listEl.appendChild(newCardEl);
        }
      }
    }
  });

  evtSource.addEventListener('column_renormalized', (e) => {
    const data = JSON.parse(e.data);
    const listEl = document.querySelector(`.card-list[data-column-id="${data.columnId}"]`);
    if (listEl) {
      data.cards.forEach(card => {
        const cardEl = listEl.querySelector(`.card[data-id="${card.id}"]`);
        if (cardEl) {
          cardEl.dataset.position = card.position;
        }
      });
      const cards = [...listEl.querySelectorAll('.card')];
      cards.sort((a, b) => parseFloat(a.dataset.position) - parseFloat(b.dataset.position));
      cards.forEach(c => listEl.appendChild(c));
    }
  });
}

fetchBoard().then(() => {
  setupSSE();
});
