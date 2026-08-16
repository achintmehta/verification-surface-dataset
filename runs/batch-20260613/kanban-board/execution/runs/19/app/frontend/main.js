const API_URL = 'http://localhost:3000/api';

let columns = [];
let cards = new Map(); // id -> card object

const boardEl = document.getElementById('board');
const columnSelectEl = document.getElementById('new-card-column');
const addCardForm = document.getElementById('add-card-form');

async function init() {
  const res = await fetch(`${API_URL}/board`);
  columns = await res.json();
  
  columns.forEach(col => {
    const option = document.createElement('option');
    option.value = col.id;
    option.textContent = col.title;
    columnSelectEl.appendChild(option);
    
    col.cards.forEach(card => {
      cards.set(card.id, card);
    });
  });
  
  renderBoard();
  setupSSE();
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
    
    // Sort cards by position
    const colCards = Array.from(cards.values())
      .filter(c => c.column_id === col.id)
      .sort((a, b) => {
        if (a.position === b.position) return a.id - b.id;
        return a.position - b.position;
      });
      
    colCards.forEach(card => {
      listEl.appendChild(createCardElement(card));
    });
    
    colEl.appendChild(listEl);
    boardEl.appendChild(colEl);
  });
  
  setupDragAndDrop();
}

function createCardElement(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.id = card.id;
  el.draggable = true;
  el.textContent = card.text;
  return el;
}

addCardForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const textInput = document.getElementById('new-card-text');
  const text = textInput.value;
  const columnId = parseInt(columnSelectEl.value);
  
  textInput.value = '';
  
  await fetch(`${API_URL}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text })
  });
});

function setupSSE() {
  const evtSource = new EventSource(`${API_URL}/stream`);
  
  evtSource.addEventListener('card_created', (e) => {
    const card = JSON.parse(e.data);
    cards.set(card.id, card);
    if (!draggedCardId) renderBoard();
  });
  
  evtSource.addEventListener('card_moved', (e) => {
    const card = JSON.parse(e.data);
    cards.set(card.id, card);
    if (!draggedCardId) renderBoard();
  });
  
  evtSource.addEventListener('column_renormalized', (e) => {
    const data = JSON.parse(e.data);
    data.cards.forEach(card => {
      cards.set(card.id, card);
    });
    if (!draggedCardId) renderBoard();
  });
}

let draggedCardId = null;

function setupDragAndDrop() {
  const cardEls = document.querySelectorAll('.card');
  const listEls = document.querySelectorAll('.card-list');
  
  cardEls.forEach(card => {
    card.addEventListener('dragstart', () => {
      draggedCardId = parseInt(card.dataset.id);
      card.classList.add('dragging');
    });
    
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      draggedCardId = null;
      renderBoard();
    });
  });
  
  listEls.forEach(list => {
    list.addEventListener('dragover', (e) => {
      e.preventDefault();
      const afterElement = getDragAfterElement(list, e.clientY);
      const draggable = document.querySelector('.dragging');
      if (afterElement == null) {
        list.appendChild(draggable);
      } else {
        list.insertBefore(draggable, afterElement);
      }
    });
    
    list.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (!draggedCardId) return;
      
      const draggable = document.querySelector('.dragging');
      const columnId = parseInt(list.dataset.columnId);
      
      // Determine beforeId and afterId based on DOM position
      const siblings = [...list.querySelectorAll('.card')];
      const index = siblings.indexOf(draggable);
      
      let beforeId = null;
      let afterId = null;
      
      if (index < siblings.length - 1) {
        beforeId = parseInt(siblings[index + 1].dataset.id);
      }
      if (index > 0) {
        afterId = parseInt(siblings[index - 1].dataset.id);
      }
      
      // Optimistic update
      const card = cards.get(draggedCardId);
      card.column_id = columnId;
      
      let newPos;
      if (!beforeId && !afterId) {
        newPos = 1000;
      } else if (!beforeId) {
        newPos = cards.get(afterId).position + 1000;
      } else if (!afterId) {
        newPos = cards.get(beforeId).position / 2;
      } else {
        newPos = (cards.get(beforeId).position + cards.get(afterId).position) / 2;
      }
      card.position = newPos;
      
      await fetch(`${API_URL}/cards/${draggedCardId}/move`, {
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

init();