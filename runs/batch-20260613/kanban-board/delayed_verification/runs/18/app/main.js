const API_URL = 'http://localhost:3000/api';

async function fetchBoard() {
  const res = await fetch(`${API_URL}/board`);
  const boardData = await res.json();
  
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';
  
  boardData.forEach(col => {
    const colEl = document.createElement('div');
    colEl.className = 'column';
    colEl.dataset.id = col.id;
    
    const titleEl = document.createElement('div');
    titleEl.className = 'column-title';
    titleEl.textContent = col.title;
    colEl.appendChild(titleEl);
    
    const listEl = document.createElement('div');
    listEl.className = 'card-list';
    listEl.dataset.columnId = col.id;
    
    col.cards.sort((a, b) => {
      if (a.position !== b.position) return a.position - b.position;
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    }).forEach(card => {
      const cardEl = createCardElement(card);
      listEl.appendChild(cardEl);
    });
    
    colEl.appendChild(listEl);
    
    const formEl = document.createElement('form');
    formEl.className = 'add-card-form';
    formEl.onsubmit = async (e) => {
      e.preventDefault();
      const input = formEl.querySelector('input');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      
      await fetch(`${API_URL}/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId: col.id, text })
      });
    };
    
    const inputEl = document.createElement('input');
    inputEl.placeholder = 'Add a card...';
    formEl.appendChild(inputEl);
    
    const btnEl = document.createElement('button');
    btnEl.textContent = 'Add';
    formEl.appendChild(btnEl);
    
    colEl.appendChild(formEl);
    boardEl.appendChild(colEl);
  });
  
  setupDragAndDropForLists();
}

function createCardElement(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.dataset.id = card.id;
  el.dataset.position = card.position;
  el.textContent = card.text;
  
  el.addEventListener('dragstart', () => {
    el.classList.add('dragging');
  });
  
  el.addEventListener('dragend', async () => {
    const list = el.closest('.card-list');
    const columnId = list.dataset.columnId;
    
    const siblings = [...list.querySelectorAll('.card:not(.dragging)')];
    const nextSibling = siblings.find(sibling => {
      return sibling.getBoundingClientRect().top > el.getBoundingClientRect().top;
    });
    
    const prevSibling = nextSibling ? siblings[siblings.indexOf(nextSibling) - 1] : siblings[siblings.length - 1];
    
    const afterId = prevSibling ? prevSibling.dataset.id : null;
    const beforeId = nextSibling ? nextSibling.dataset.id : null;
    
    el.classList.remove('dragging');
    
    await fetch(`${API_URL}/cards/${el.dataset.id}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId })
    });
  });
  
  return el;
}

function setupDragAndDropForLists() {
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

function updateCardInDOM(card) {
  let cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
  
  if (!cardEl) {
    cardEl = createCardElement(card);
  } else {
    cardEl.textContent = card.text;
    cardEl.dataset.position = card.position;
  }
  
  if (cardEl.classList.contains('dragging')) {
    return;
  }
  
  const listEl = document.querySelector(`.card-list[data-column-id="${card.column_id}"]`);
  if (!listEl) return;
  
  const siblings = [...listEl.querySelectorAll('.card')].filter(c => c !== cardEl);
  const nextSibling = siblings.find(sibling => {
    return parseFloat(sibling.dataset.position) > card.position;
  });
  
  if (nextSibling) {
    if (cardEl.nextSibling !== nextSibling) {
      listEl.insertBefore(cardEl, nextSibling);
    }
  } else {
    if (cardEl.parentElement !== listEl || listEl.lastChild !== cardEl) {
      listEl.appendChild(cardEl);
    }
  }
}

const eventSource = new EventSource(`${API_URL}/stream`);

eventSource.addEventListener('card_created', e => {
  const card = JSON.parse(e.data);
  updateCardInDOM(card);
});

eventSource.addEventListener('card_moved', e => {
  const card = JSON.parse(e.data);
  updateCardInDOM(card);
});

eventSource.addEventListener('column_renormalized', e => {
  const { cards } = JSON.parse(e.data);
  cards.forEach(card => updateCardInDOM(card));
});

fetchBoard();