const API_URL = 'http://localhost:3000/api';

let boardData = [];
let isDragging = false;
let pendingRender = false;

async function fetchBoard() {
  const res = await fetch(`${API_URL}/board`);
  boardData = await res.json();
  renderBoard();
}

function renderBoard() {
  const boardEl = document.getElementById('board');
  
  if (boardEl.children.length === 0) {
    // Initial render of columns
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

      const addBtn = document.createElement('div');
      addBtn.className = 'add-card';
      addBtn.textContent = '+ Add a card';
      
      const formEl = document.createElement('div');
      formEl.className = 'add-card-form';
      const textarea = document.createElement('textarea');
      textarea.placeholder = 'Enter a title for this card...';
      const saveBtn = document.createElement('button');
      saveBtn.textContent = 'Add Card';
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      
      addBtn.onclick = () => {
        addBtn.style.display = 'none';
        formEl.classList.add('active');
        textarea.focus();
      };

      saveBtn.onclick = async () => {
        const text = textarea.value.trim();
        if (text) {
          await createCard(column.id, text);
          textarea.value = '';
          formEl.classList.remove('active');
          addBtn.style.display = 'block';
        }
      };

      cancelBtn.onclick = () => {
        textarea.value = '';
        formEl.classList.remove('active');
        addBtn.style.display = 'block';
      };

      formEl.appendChild(textarea);
      formEl.appendChild(saveBtn);
      formEl.appendChild(cancelBtn);
      
      colEl.appendChild(addBtn);
      colEl.appendChild(formEl);

      boardEl.appendChild(colEl);
    });
    
    setupDragAndDrop();
  }

  // Update cards
  boardData.forEach(column => {
    const listEl = boardEl.querySelector(`.card-list[data-column-id="${column.id}"]`);
    if (!listEl) return;
    
    listEl.innerHTML = '';
    column.cards.sort((a, b) => a.position - b.position);

    column.cards.forEach(card => {
      const cardEl = createCardElement(card);
      listEl.appendChild(cardEl);
    });
  });

  // Re-attach drag events to new card elements
  setupCardDragEvents();
}

function createCardElement(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.id = card.id;
  el.textContent = card.text;
  el.draggable = true;
  return el;
}

async function createCard(columnId, text) {
  await fetch(`${API_URL}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text })
  });
}

function setupCardDragEvents() {
  const cards = document.querySelectorAll('.card');
  cards.forEach(card => {
    card.addEventListener('dragstart', () => {
      isDragging = true;
      draggedCard = card;
      setTimeout(() => card.classList.add('dragging'), 0);
    });

    card.addEventListener('dragend', () => {
      if (draggedCard) draggedCard.classList.remove('dragging');
      draggedCard = null;
      isDragging = false;
      if (pendingRender) {
        pendingRender = false;
        renderBoard();
      }
    });
  });
}

let draggedCard = null;

function setupDragAndDrop() {
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

      const columnId = list.dataset.columnId;
      const cardId = draggedCard.dataset.id;

      const prev = draggedCard.previousElementSibling;
      const next = draggedCard.nextElementSibling;

      const afterId = prev ? prev.dataset.id : null;
      const beforeId = next ? next.dataset.id : null;

      await fetch(`${API_URL}/cards/${cardId}/move`, {
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

const eventSource = new EventSource(`${API_URL}/stream`);

eventSource.onmessage = (e) => {
  const data = JSON.parse(e.data);
  
  if (data.type === 'CARD_CREATED') {
    const col = boardData.find(c => c.id === data.card.column_id);
    if (col && !col.cards.find(c => c.id === data.card.id)) {
      col.cards.push(data.card);
      requestRender();
    }
  } else if (data.type === 'CARD_MOVED') {
    boardData.forEach(col => {
      col.cards = col.cards.filter(c => c.id !== data.card.id);
    });
    const col = boardData.find(c => c.id === data.card.column_id);
    if (col) {
      col.cards.push(data.card);
    }
    requestRender();
  } else if (data.type === 'COLUMN_RENORMALIZED') {
    const col = boardData.find(c => c.id === data.columnId);
    if (col) {
      col.cards = data.cards;
    }
    requestRender();
  }
};

function requestRender() {
  if (isDragging) {
    pendingRender = true;
  } else {
    renderBoard();
  }
}

fetchBoard();
