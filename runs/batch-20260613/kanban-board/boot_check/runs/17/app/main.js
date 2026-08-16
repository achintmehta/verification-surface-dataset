const boardEl = document.getElementById('board');
let columnsData = [];

async function loadBoard() {
  const res = await fetch('/api/board');
  columnsData = await res.json();
  renderBoard();
}

function renderBoard() {
  boardEl.innerHTML = '';
  columnsData.forEach(col => {
    const colEl = document.createElement('div');
    colEl.className = 'column';
    colEl.dataset.id = col.id;
    
    colEl.innerHTML = `
      <div class="column-header">${col.title}</div>
      <div class="column-cards" data-column-id="${col.id}">
        ${col.cards.map(card => createCardHTML(card)).join('')}
      </div>
      <div class="add-card" onclick="showAddCardForm(${col.id})">+ Add a card</div>
      <div class="add-card-form" id="add-form-${col.id}">
        <textarea placeholder="Enter a title for this card..."></textarea>
        <button onclick="addCard(${col.id})">Add Card</button>
        <button onclick="hideAddCardForm(${col.id})" style="background: transparent; color: #5e6c84; border: none; cursor: pointer; font-size: 16px;">✖</button>
      </div>
    `;
    boardEl.appendChild(colEl);
  });
  
  setupDragAndDrop();
}

function createCardHTML(card) {
  return `
    <div class="card" draggable="true" data-id="${card.id}" data-position="${card.position}">
      ${card.text}
    </div>
  `;
}

window.showAddCardForm = (colId) => {
  document.getElementById(`add-form-${colId}`).classList.add('active');
  document.querySelector(`.column[data-id="${colId}"] .add-card`).style.display = 'none';
};

window.hideAddCardForm = (colId) => {
  document.getElementById(`add-form-${colId}`).classList.remove('active');
  document.querySelector(`.column[data-id="${colId}"] .add-card`).style.display = 'block';
};

window.addCard = async (colId) => {
  const textarea = document.querySelector(`#add-form-${colId} textarea`);
  const text = textarea.value.trim();
  if (!text) return;
  
  textarea.value = '';
  hideAddCardForm(colId);
  
  await fetch('/api/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId: colId, text })
  });
};

let draggedCard = null;

function setupDragAndDrop() {
  // Initial setup for cards rendered on load
  const cards = document.querySelectorAll('.card');
  cards.forEach(attachCardEvents);
  
  const containers = document.querySelectorAll('.column-cards');
  containers.forEach(container => {
    container.addEventListener('dragover', e => {
      e.preventDefault();
      if (!draggedCard) return;
      const afterElement = getDragAfterElement(container, e.clientY);
      if (afterElement == null) {
        container.appendChild(draggedCard);
      } else {
        container.insertBefore(draggedCard, afterElement);
      }
    });
    
    container.addEventListener('drop', async e => {
      e.preventDefault();
      if (!draggedCard) return;
      
      const cardId = parseInt(draggedCard.dataset.id);
      const columnId = parseInt(container.dataset.columnId);
      
      const prevCard = draggedCard.previousElementSibling;
      const nextCard = draggedCard.nextElementSibling;
      
      const beforeId = nextCard ? parseInt(nextCard.dataset.id) : null;
      const afterId = prevCard ? parseInt(prevCard.dataset.id) : null;
      
      // Optimistically update columnsData
      let cardObj = null;
      columnsData.forEach(col => {
        const idx = col.cards.findIndex(c => c.id === cardId);
        if (idx !== -1) {
          cardObj = col.cards.splice(idx, 1)[0];
        }
      });
      
      if (cardObj) {
        cardObj.column_id = columnId;
        let newPos = 0;
        const targetCol = columnsData.find(c => c.id === columnId);
        if (targetCol) {
          const beforeCard = targetCol.cards.find(c => c.id === beforeId);
          const afterCard = targetCol.cards.find(c => c.id === afterId);
          
          if (beforeCard && afterCard) {
            newPos = (beforeCard.position + afterCard.position) / 2;
          } else if (beforeCard) {
            newPos = beforeCard.position - 1000;
          } else if (afterCard) {
            newPos = afterCard.position + 1000;
          } else {
            if (targetCol.cards.length > 0) {
              newPos = targetCol.cards[targetCol.cards.length - 1].position + 1000;
            } else {
              newPos = 1000;
            }
          }
          cardObj.position = newPos;
          targetCol.cards.push(cardObj);
          targetCol.cards.sort((a, b) => a.position !== b.position ? a.position - b.position : a.id - b.id);
        }
      }
      
      await fetch(`/api/cards/${cardId}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId, beforeId, afterId })
      });
    });
  });
}

function attachCardEvents(card) {
  card.addEventListener('dragstart', () => {
    draggedCard = card;
    setTimeout(() => card.classList.add('dragging'), 0);
  });
  
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    draggedCard = null;
    columnsData.forEach(col => reconcileColumnDOM(col));
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

const evtSource = new EventSource('/api/stream');

evtSource.addEventListener('card_created', (e) => {
  const card = JSON.parse(e.data);
  const col = columnsData.find(c => c.id === card.column_id);
  if (col) {
    // Check if it already exists (in case we implement optimistic creation later)
    if (!col.cards.find(c => c.id === card.id)) {
      col.cards.push(card);
      col.cards.sort((a, b) => a.position !== b.position ? a.position - b.position : a.id - b.id);
      reconcileColumnDOM(col);
    }
  }
});

evtSource.addEventListener('card_moved', (e) => {
  const card = JSON.parse(e.data);
  let oldColId = null;
  
  columnsData.forEach(col => {
    const idx = col.cards.findIndex(c => c.id === card.id);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      oldColId = col.id;
    }
  });
  
  const col = columnsData.find(c => c.id === card.column_id);
  if (col) {
    col.cards.push(card);
    col.cards.sort((a, b) => a.position !== b.position ? a.position - b.position : a.id - b.id);
  }
  
  if (oldColId && oldColId !== card.column_id) {
    const oldCol = columnsData.find(c => c.id === oldColId);
    if (oldCol) reconcileColumnDOM(oldCol);
  }
  if (col) {
    reconcileColumnDOM(col);
  }
});

evtSource.addEventListener('column_renormalized', (e) => {
  const { columnId, cards } = JSON.parse(e.data);
  const col = columnsData.find(c => c.id === columnId);
  if (col) {
    col.cards = cards;
    reconcileColumnDOM(col);
  }
});

function reconcileColumnDOM(col) {
  const container = document.querySelector(`.column-cards[data-column-id="${col.id}"]`);
  if (!container) return;
  
  let domIndex = 0;
  col.cards.forEach((card) => {
    let cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
    if (!cardEl) {
      const temp = document.createElement('div');
      temp.innerHTML = createCardHTML(card);
      cardEl = temp.firstElementChild;
      attachCardEvents(cardEl);
    } else {
      cardEl.dataset.position = card.position;
      if (cardEl.innerHTML.trim() !== card.text) {
        cardEl.innerHTML = card.text;
      }
    }
    
    while (container.children[domIndex] === draggedCard && draggedCard !== null) {
      domIndex++;
    }
    
    if (container.children[domIndex] !== cardEl) {
      container.insertBefore(cardEl, container.children[domIndex]);
    }
    domIndex++;
  });
  
  const validIds = new Set(col.cards.map(c => String(c.id)));
  Array.from(container.children).forEach(child => {
    if (!validIds.has(child.dataset.id) && child !== draggedCard) {
      container.removeChild(child);
    }
  });
}

loadBoard();
