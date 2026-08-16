const API_URL = 'http://localhost:3000/api';

let boardState = [];

async function fetchBoard() {
  const res = await fetch(`${API_URL}/board`);
  boardState = await res.json();
  renderBoard();
}

let draggedCard = null;
let pendingRender = false;
let dropFired = false;

function renderBoard() {
  if (draggedCard) {
    pendingRender = true;
    return;
  }
  
  const textareas = document.querySelectorAll('.add-card-form textarea');
  const textareaStates = {};
  textareas.forEach(ta => {
    const colId = ta.closest('.column').dataset.id;
    textareaStates[colId] = {
      value: ta.value,
      focused: document.activeElement === ta,
      formActive: ta.closest('.add-card-form').classList.contains('active')
    };
  });
  
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
    
    const cardListEl = document.createElement('div');
    cardListEl.className = 'card-list';
    cardListEl.dataset.columnId = column.id;
    
    column.cards.forEach(card => {
      const cardEl = createCardElement(card);
      cardListEl.appendChild(cardEl);
    });
    
    colEl.appendChild(cardListEl);
    
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
        await fetch(`${API_URL}/cards`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId: column.id, text })
        });
        textarea.value = '';
        formEl.classList.remove('active');
        addCardEl.style.display = 'block';
      }
    };
    
    formEl.appendChild(textarea);
    formEl.appendChild(btn);
    
    const state = textareaStates[column.id];
    if (state) {
      textarea.value = state.value;
      if (state.formActive) {
        addCardEl.style.display = 'none';
        formEl.classList.add('active');
      }
      if (state.focused) {
        setTimeout(() => textarea.focus(), 0);
      }
    }
    
    colEl.appendChild(addCardEl);
    colEl.appendChild(formEl);
    
    boardEl.appendChild(colEl);
  });
  
  setupDragAndDrop();
}

function createCardElement(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.dataset.id = card.id;
  cardEl.dataset.position = card.position;
  cardEl.textContent = card.text;
  cardEl.draggable = true;
  return cardEl;
}

function setupDragAndDrop() {
  const cards = document.querySelectorAll('.card');
  const lists = document.querySelectorAll('.card-list');
  
  cards.forEach(card => {
    card.addEventListener('dragstart', () => {
      draggedCard = card;
      dropFired = false;
      setTimeout(() => card.classList.add('dragging'), 0);
    });
    
    card.addEventListener('dragend', () => {
      draggedCard.classList.remove('dragging');
      draggedCard = null;
      if (pendingRender || !dropFired) {
        pendingRender = false;
        renderBoard();
      }
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
      dropFired = true;
      
      const cardId = draggedCard.dataset.id;
      const columnId = list.dataset.columnId;
      
      const prev = draggedCard.previousElementSibling;
      const next = draggedCard.nextElementSibling;
      
      const afterId = prev ? prev.dataset.id : null;
      const beforeId = next ? next.dataset.id : null;
      
      let newPos = 0;
      if (prev && next) {
        newPos = (parseFloat(prev.dataset.position) + parseFloat(next.dataset.position)) / 2;
      } else if (prev) {
        newPos = parseFloat(prev.dataset.position) + 1000;
      } else if (next) {
        newPos = parseFloat(next.dataset.position) - 1000;
      } else {
        newPos = 1000;
      }
      
      const cardToMove = {
        id: parseInt(cardId),
        column_id: parseInt(columnId),
        text: draggedCard.textContent,
        position: newPos
      };
      
      boardState.forEach(c => {
        c.cards = c.cards.filter(card => card.id != cardId);
      });
      const targetCol = boardState.find(c => c.id == columnId);
      if (targetCol) {
        targetCol.cards.push(cardToMove);
        targetCol.cards.sort((a, b) => a.position !== b.position ? a.position - b.position : a.id - b.id);
      }
      
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

function setupSSE() {
  const evtSource = new EventSource(`${API_URL}/stream`);
  
  evtSource.addEventListener('card_created', e => {
    const card = JSON.parse(e.data);
    const col = boardState.find(c => c.id === card.column_id);
    if (col) {
      col.cards.push(card);
      col.cards.sort((a, b) => a.position !== b.position ? a.position - b.position : a.id - b.id);
      renderBoard();
    }
  });
  
  evtSource.addEventListener('card_moved', e => {
    const updatedCard = JSON.parse(e.data);
    
    // Remove from old column
    boardState.forEach(col => {
      col.cards = col.cards.filter(c => c.id !== updatedCard.id);
    });
    
    // Add to new column
    const col = boardState.find(c => c.id === updatedCard.column_id);
    if (col) {
      col.cards.push(updatedCard);
      col.cards.sort((a, b) => a.position !== b.position ? a.position - b.position : a.id - b.id);
    }
    
    renderBoard();
  });
  
  evtSource.addEventListener('column_renormalized', e => {
    const { columnId, cards } = JSON.parse(e.data);
    const col = boardState.find(c => c.id === columnId);
    if (col) {
      col.cards = cards;
      renderBoard();
    }
  });
}

fetchBoard().then(setupSSE);
