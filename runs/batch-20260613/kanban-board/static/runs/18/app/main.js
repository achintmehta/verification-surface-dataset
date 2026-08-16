import './style.css';

const API_URL = '/api';

let boardData = [];
let isDragging = false;
let dragAndDropSetup = false;

async function fetchBoard() {
  const res = await fetch(`${API_URL}/board`);
  boardData = await res.json();
  renderBoard();
}

function renderBoard() {
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
    
    const listEl = document.createElement('div');
    listEl.className = 'card-list';
    listEl.dataset.columnId = column.id;
    
    column.cards.forEach(card => {
      const cardEl = createCardElement(card);
      listEl.appendChild(cardEl);
    });
    
    colEl.appendChild(listEl);
    
    const addCardBtn = document.createElement('div');
    addCardBtn.className = 'add-card';
    addCardBtn.textContent = '+ Add a card';
    addCardBtn.onclick = () => {
      addCardBtn.style.display = 'none';
      formEl.classList.add('active');
      textarea.focus();
    };
    colEl.appendChild(addCardBtn);
    
    const formEl = document.createElement('div');
    formEl.className = 'add-card-form';
    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Enter a title for this card...';
    const addBtn = document.createElement('button');
    addBtn.textContent = 'Add Card';
    
    addBtn.onclick = async () => {
      const text = textarea.value.trim();
      if (text) {
        await createCard(column.id, text);
        textarea.value = '';
        formEl.classList.remove('active');
        addCardBtn.style.display = 'block';
      }
    };
    
    formEl.appendChild(textarea);
    formEl.appendChild(addBtn);
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

function setupDragAndDrop() {
  if (dragAndDropSetup) return;
  dragAndDropSetup = true;
  
  const boardEl = document.getElementById('board');
  let draggedCard = null;
  
  boardEl.addEventListener('dragstart', e => {
    if (e.target.classList.contains('card')) {
      isDragging = true;
      draggedCard = e.target;
      setTimeout(() => e.target.classList.add('dragging'), 0);
    }
  });
  
  boardEl.addEventListener('dragend', async e => {
    if (e.target.classList.contains('card')) {
      e.target.classList.remove('dragging');
      isDragging = false;
      
      const listEl = draggedCard.closest('.card-list');
      if (!listEl) {
        renderBoard();
        return;
      }
      
      const targetColumnId = listEl.dataset.columnId;
      const cards = [...listEl.querySelectorAll('.card')];
      const index = cards.indexOf(draggedCard);
      
      const afterId = index > 0 ? cards[index - 1].dataset.id : null;
      const beforeId = index < cards.length - 1 ? cards[index + 1].dataset.id : null;
      
      const cardId = draggedCard.dataset.id;
      
      // Optimistic update
      let movedCardData = null;
      boardData.forEach(col => {
        const idx = col.cards.findIndex(c => c.id == cardId);
        if (idx !== -1) {
          movedCardData = col.cards.splice(idx, 1)[0];
        }
      });
      
      if (movedCardData) {
        movedCardData.column_id = parseInt(targetColumnId);
        const targetCol = boardData.find(c => c.id == targetColumnId);
        if (targetCol) {
          targetCol.cards.splice(index, 0, movedCardData);
          targetCol.cards.forEach((c, i) => c.position = i * 1000);
        }
      }
      
      renderBoard();
      
      try {
        await fetch(`${API_URL}/cards/${cardId}/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            columnId: parseInt(targetColumnId),
            beforeId: beforeId ? parseInt(beforeId) : null,
            afterId: afterId ? parseInt(afterId) : null
          })
        });
      } catch (err) {
        console.error(err);
      }
      
      draggedCard = null;
    }
  });
  
  boardEl.addEventListener('dragover', e => {
    e.preventDefault();
    const listEl = e.target.closest('.card-list');
    if (!listEl || !draggedCard) return;
    
    const afterElement = getDragAfterElement(listEl, e.clientY);
    if (afterElement == null) {
      listEl.appendChild(draggedCard);
    } else {
      listEl.insertBefore(draggedCard, afterElement);
    }
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

function updateCardInDOM(card) {
  let cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
  if (!cardEl) {
    cardEl = createCardElement(card);
  } else {
    cardEl.textContent = card.text;
  }
  
  const listEl = document.querySelector(`.card-list[data-column-id="${card.column_id}"]`);
  if (!listEl) return;
  
  const col = boardData.find(c => c.id === card.column_id);
  const index = col.cards.findIndex(c => c.id === card.id);
  
  const currentCards = [...listEl.querySelectorAll('.card')].filter(el => el !== cardEl);
  
  if (index < currentCards.length) {
    listEl.insertBefore(cardEl, currentCards[index]);
  } else {
    listEl.appendChild(cardEl);
  }
}

function setupSSE() {
  const eventSource = new EventSource(`${API_URL}/stream`);
  
  eventSource.addEventListener('card_created', e => {
    const card = JSON.parse(e.data);
    const col = boardData.find(c => c.id === card.column_id);
    if (col) {
      const existing = col.cards.find(c => c.id === card.id);
      if (!existing) {
        col.cards.push(card);
        col.cards.sort((a, b) => a.position - b.position);
        if (!isDragging) updateCardInDOM(card);
      }
    }
  });
  
  eventSource.addEventListener('card_moved', e => {
    const movedCard = JSON.parse(e.data);
    
    boardData.forEach(col => {
      col.cards = col.cards.filter(c => c.id !== movedCard.id);
    });
    
    const col = boardData.find(c => c.id === movedCard.column_id);
    if (col) {
      col.cards.push(movedCard);
      col.cards.sort((a, b) => a.position - b.position);
    }
    
    if (!isDragging) updateCardInDOM(movedCard);
  });
  
  eventSource.addEventListener('column_renormalized', e => {
    fetchBoard();
  });
}

fetchBoard().then(setupSSE);