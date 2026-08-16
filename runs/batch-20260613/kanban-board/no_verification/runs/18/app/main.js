let columns = [];
let cards = {}; // id -> card
let isDragging = false;
let pendingReconciliation = false;

async function init() {
  const res = await fetch('/api/board');
  columns = await res.json();
  
  columns.forEach(col => {
    col.cards.forEach(card => {
      cards[card.id] = card;
    });
  });

  renderBoard();
  setupSSE();
}

function renderBoard() {
  const boardEl = document.getElementById('board');
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
    listEl.dataset.id = col.id;
    
    // Sort cards by position
    const colCards = Object.values(cards)
      .filter(c => c.column_id === col.id)
      .sort((a, b) => a.position - b.position);

    colCards.forEach(card => {
      listEl.appendChild(createCardElement(card));
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
    const addBtn = document.createElement('button');
    addBtn.textContent = 'Add Card';
    
    addBtn.onclick = async () => {
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
    formEl.appendChild(addBtn);

    colEl.appendChild(addCardBtn);
    colEl.appendChild(formEl);

    boardEl.appendChild(colEl);
  });

  setupDragAndDrop();
}

function createCardElement(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.id = card.id;
  el.textContent = card.text;
  el.draggable = true;
  return el;
}

function setupDragAndDrop() {
  const boardEl = document.getElementById('board');
  let draggedEl = null;

  boardEl.addEventListener('dragstart', e => {
    if (e.target.classList.contains('card')) {
      isDragging = true;
      draggedEl = e.target;
      e.target.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    }
  });

  boardEl.addEventListener('dragend', e => {
    if (e.target.classList.contains('card')) {
      e.target.classList.remove('dragging');
      draggedEl = null;
      isDragging = false;
      if (pendingReconciliation) {
        pendingReconciliation = false;
        reconcileBoard();
      }
    }
  });

  boardEl.addEventListener('dragover', e => {
    e.preventDefault();
    const colEl = e.target.closest('.column');
    if (!colEl || !draggedEl) return;
    const listEl = colEl.querySelector('.card-list');
    if (!listEl) return;

    const afterElement = getDragAfterElement(listEl, e.clientY);
    if (afterElement == null) {
      listEl.appendChild(draggedEl);
    } else {
      listEl.insertBefore(draggedEl, afterElement);
    }
  });

  boardEl.addEventListener('drop', async e => {
    e.preventDefault();
    if (!draggedEl) return;

    const colEl = e.target.closest('.column');
    if (!colEl) return;
    const listEl = colEl.querySelector('.card-list');
    if (!listEl) return;

    const columnId = listEl.dataset.id;
    const cardId = draggedEl.dataset.id;

    // Find beforeId and afterId
    const prevEl = draggedEl.previousElementSibling;
    const nextEl = draggedEl.nextElementSibling;

    const afterId = prevEl ? prevEl.dataset.id : null; // The card above us
    const beforeId = nextEl ? nextEl.dataset.id : null; // The card below us

    // Optimistic update
    if (cards[cardId]) {
      cards[cardId].column_id = columnId;
      let beforePos = beforeId && cards[beforeId] ? cards[beforeId].position : null;
      let afterPos = afterId && cards[afterId] ? cards[afterId].position : null;
      if (beforePos !== null && afterPos !== null) {
        cards[cardId].position = (beforePos + afterPos) / 2;
      } else if (beforePos !== null) {
        cards[cardId].position = beforePos - 1000;
      } else if (afterPos !== null) {
        cards[cardId].position = afterPos + 1000;
      } else {
        cards[cardId].position = 1000;
      }
    }

    try {
      const res = await fetch(`/api/cards/${cardId}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId, beforeId, afterId })
      });
      const updatedCard = await res.json();
      cards[updatedCard.id] = updatedCard;
      reconcileBoard();
    } catch (err) {
      console.error(err);
      reconcileBoard();
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

function setupSSE() {
  const evtSource = new EventSource('/api/stream');
  
  evtSource.addEventListener('card_created', e => {
    const card = JSON.parse(e.data);
    cards[card.id] = card;
    reconcileBoard();
  });

  evtSource.addEventListener('card_moved', e => {
    const card = JSON.parse(e.data);
    cards[card.id] = card;
    reconcileBoard();
  });

  evtSource.addEventListener('column_renormalized', e => {
    const { columnId, cards: updatedCards } = JSON.parse(e.data);
    updatedCards.forEach(c => {
      cards[c.id] = c;
    });
    reconcileBoard();
  });
}

function reconcileBoard() {
  if (isDragging) {
    pendingReconciliation = true;
    return;
  }

  columns.forEach(col => {
    const listEl = document.querySelector(\`.card-list[data-id="\${col.id}"]\`);
    if (!listEl) return;

    const colCards = Object.values(cards)
      .filter(c => c.column_id === col.id)
      .sort((a, b) => a.position - b.position);

    const currentEls = [...listEl.children];
    let matches = true;
    if (currentEls.length !== colCards.length) {
      matches = false;
    } else {
      for (let i = 0; i < currentEls.length; i++) {
        if (currentEls[i].dataset.id !== colCards[i].id) {
          matches = false;
          break;
        }
      }
    }

    if (!matches) {
      listEl.innerHTML = '';
      colCards.forEach(card => {
        listEl.appendChild(createCardElement(card));
      });
    }
  });
}

init();
