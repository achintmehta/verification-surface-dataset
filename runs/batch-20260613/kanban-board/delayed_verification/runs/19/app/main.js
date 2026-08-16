let boardData = [];
let isDragging = false;

async function init() {
  const res = await fetch('/api/board');
  boardData = await res.json();
  renderBoard();
  setupSSE();
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
    listEl.dataset.id = col.id;
    
    col.cards.sort((a, b) => a.position - b.position).forEach(card => {
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
    
    const formEl = document.createElement('div');
    formEl.className = 'add-card-form';
    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Enter a title for this card...';
    const submitBtn = document.createElement('button');
    submitBtn.textContent = 'Add Card';
    
    submitBtn.onclick = async () => {
      const text = textarea.value.trim();
      if (text) {
        await fetch('/api/cards', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId: col.id, text })
        });
        textarea.value = '';
        formEl.classList.remove('active');
        addCardBtn.style.display = 'block';
      }
    };
    
    formEl.appendChild(textarea);
    formEl.appendChild(submitBtn);
    
    colEl.appendChild(addCardBtn);
    colEl.appendChild(formEl);
    
    boardEl.appendChild(colEl);
  });
  
  setupDragAndDrop();
}

function createCardElement(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.dataset.id = card.id;
  el.dataset.position = card.position;
  el.textContent = card.text;
  
  el.addEventListener('dragstart', () => {
    isDragging = true;
    el.classList.add('dragging');
  });
  
  el.addEventListener('dragend', async () => {
    el.classList.remove('dragging');
    isDragging = false;
    
    const list = el.closest('.card-list');
    const columnId = list.dataset.id;
    
    const siblings = [...list.querySelectorAll('.card')];
    const index = siblings.indexOf(el);
    
    const beforeId = index > 0 ? siblings[index - 1].dataset.id : null;
    const afterId = index < siblings.length - 1 ? siblings[index + 1].dataset.id : null;
    
    await fetch(`/api/cards/${el.dataset.id}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId })
    });
  });
  
  return el;
}

function setupDragAndDrop() {
  const lists = document.querySelectorAll('.card-list');
  
  lists.forEach(list => {
    list.addEventListener('dragover', e => {
      e.preventDefault();
      const draggingCard = document.querySelector('.dragging');
      if (!draggingCard) return;
      
      const afterElement = getDragAfterElement(list, e.clientY);
      if (afterElement == null) {
        list.appendChild(draggingCard);
      } else {
        list.insertBefore(draggingCard, afterElement);
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

function insertCardInDOM(card) {
  // Remove existing card if any
  const existing = document.querySelector(`.card[data-id="${card.id}"]`);
  if (existing) {
    existing.remove();
  }
  
  const list = document.querySelector(`.card-list[data-id="${card.column_id}"]`);
  if (!list) return;
  
  const cardEl = createCardElement(card);
  
  const siblings = [...list.querySelectorAll('.card')];
  const nextSibling = siblings.find(sibling => parseFloat(sibling.dataset.position) > card.position);
  
  if (nextSibling) {
    list.insertBefore(cardEl, nextSibling);
  } else {
    list.appendChild(cardEl);
  }
}

function setupSSE() {
  const evtSource = new EventSource('/api/stream');
  
  evtSource.addEventListener('card_created', (e) => {
    const card = JSON.parse(e.data);
    insertCardInDOM(card);
  });
  
  evtSource.addEventListener('card_moved', (e) => {
    const card = JSON.parse(e.data);
    const draggingCard = document.querySelector('.dragging');
    if (draggingCard && draggingCard.dataset.id === card.id) {
      return;
    }
    insertCardInDOM(card);
  });
  
  evtSource.addEventListener('column_renormalized', (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    const list = document.querySelector(`.card-list[data-id="${columnId}"]`);
    if (list) {
      const draggingCard = document.querySelector('.dragging');
      
      cards.sort((a, b) => a.position - b.position).forEach(card => {
        let el = list.querySelector(`.card[data-id="${card.id}"]`);
        if (!el) {
          el = createCardElement(card);
        } else {
          el.dataset.position = card.position;
          el.textContent = card.text;
        }
        
        if (draggingCard && draggingCard === el) {
          // Don't move the dragging card in the DOM
          return;
        }
        
        // Append to list to reorder
        list.appendChild(el);
      });
      
      // Remove cards that are no longer in the column
      [...list.querySelectorAll('.card')].forEach(el => {
        if (!cards.find(c => c.id === el.dataset.id)) {
          if (draggingCard && draggingCard === el) return;
          el.remove();
        }
      });
    }
  });
}

init();
