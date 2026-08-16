import { getState as getBoardState, subscribe, moveCardInState, removeCardFromAllColumns } from './store.js';
import { createCard, moveCard, deleteCard } from './api.js';

let boardEl = null;

// Drag state
let dragCardId = null;
let dragSourceColumnId = null;

export function initRenderer() {
  boardEl = document.getElementById('board');
  subscribe(render);
  render(getBoardState());
}

function render(state) {
  if (!boardEl) return;

  const { columns } = state;
  
  // Reconcile columns: update existing, add new, remove old
  const existingColumnEls = boardEl.querySelectorAll('.column');
  const existingMap = new Map();
  existingColumnEls.forEach(el => existingMap.set(el.dataset.columnId, el));

  const newColumnIds = new Set(columns.map(c => c.id));

  // Remove columns no longer present
  existingColumnEls.forEach(el => {
    if (!newColumnIds.has(el.dataset.columnId)) {
      el.remove();
    }
  });

  // Create or update columns in order
  let prevEl = null;
  for (const col of columns) {
    let colEl = existingMap.get(col.id);
    if (!colEl) {
      colEl = createColumnElement(col);
      if (prevEl && prevEl.nextSibling) {
        boardEl.insertBefore(colEl, prevEl.nextSibling);
      } else {
        boardEl.appendChild(colEl);
      }
    } else {
      // Ensure order in DOM
      if (prevEl && prevEl.nextSibling !== colEl) {
        if (prevEl.nextSibling) {
          boardEl.insertBefore(colEl, prevEl.nextSibling);
        } else {
          boardEl.appendChild(colEl);
        }
      }
    }
    updateColumnCards(colEl, col);
    prevEl = colEl;
  }
}

function createColumnElement(col) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = col.id;

  const header = document.createElement('div');
  header.className = 'column-header';
  header.textContent = col.title;
  colEl.appendChild(header);

  const cardList = document.createElement('div');
  cardList.className = 'card-list';
  colEl.appendChild(cardList);

  // Add card section
  const addCard = document.createElement('div');
  addCard.className = 'add-card';

  const addBtn = document.createElement('button');
  addBtn.className = 'add-card-btn';
  addBtn.textContent = '+ Add a card';

  const form = document.createElement('div');
  form.className = 'add-card-form';
  form.innerHTML = `
    <textarea placeholder="Enter card text..." data-column-id="${col.id}"></textarea>
    <div class="form-actions">
      <button class="btn-add">Add Card</button>
      <button class="btn-cancel">Cancel</button>
    </div>
  `;

  addBtn.addEventListener('click', () => {
    addBtn.style.display = 'none';
    form.classList.add('active');
    const textarea = form.querySelector('textarea');
    textarea.focus();
    textarea.value = '';
  });

  const cancelBtn = form.querySelector('.btn-cancel');
  cancelBtn.addEventListener('click', () => {
    form.classList.remove('active');
    addBtn.style.display = '';
  });

  const submitBtn = form.querySelector('.btn-add');
  const textarea = form.querySelector('textarea');

  async function handleSubmit() {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = '';
    try {
      await createCard(col.id, text);
    } catch (err) {
      console.error('Failed to create card:', err);
    }
  }

  submitBtn.addEventListener('click', handleSubmit);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === 'Escape') {
      form.classList.remove('active');
      addBtn.style.display = '';
    }
  });

  addCard.appendChild(addBtn);
  addCard.appendChild(form);
  colEl.appendChild(addCard);

  // Drop zone events
  setupColumnDropZone(colEl, cardList);

  return colEl;
}

function updateColumnCards(colEl, col) {
  const cardList = colEl.querySelector('.card-list');
  const existingCards = cardList.querySelectorAll('.card');
  const existingMap = new Map();
  existingCards.forEach(el => existingMap.set(el.dataset.cardId, el));

  const newCardIds = new Set(col.cards.map(c => c.id));

  // Remove cards no longer in this column
  existingCards.forEach(el => {
    if (!newCardIds.has(el.dataset.cardId)) {
      el.remove();
    }
  });

  // Create or reorder cards
  let prevCardEl = null;
  for (const card of col.cards) {
    let cardEl = existingMap.get(card.id);
    if (!cardEl) {
      cardEl = createCardElement(card);
    } else {
      // Update text if changed
      const textEl = cardEl.querySelector('.card-text');
      if (textEl && textEl.textContent !== card.text) {
        textEl.textContent = card.text;
      }
    }

    // Ensure order
    if (prevCardEl) {
      if (prevCardEl.nextElementSibling !== cardEl) {
        if (prevCardEl.nextSibling) {
          cardList.insertBefore(cardEl, prevCardEl.nextSibling);
        } else {
          cardList.appendChild(cardEl);
        }
      }
    } else {
      if (cardList.firstElementChild !== cardEl) {
        cardList.insertBefore(cardEl, cardList.firstElementChild);
      }
    }
    prevCardEl = cardEl;
  }
}

function createCardElement(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.dataset.cardId = card.id;
  cardEl.draggable = true;

  const textSpan = document.createElement('span');
  textSpan.className = 'card-text';
  textSpan.textContent = card.text;
  cardEl.appendChild(textSpan);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'delete-btn';
  deleteBtn.textContent = '✕';
  deleteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await deleteCard(card.id);
    } catch (err) {
      console.error('Failed to delete card:', err);
    }
  });
  cardEl.appendChild(deleteBtn);

  // Drag events
  cardEl.addEventListener('dragstart', (e) => {
    dragCardId = card.id;
    const col = cardEl.closest('.column');
    dragSourceColumnId = col ? col.dataset.columnId : null;
    cardEl.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.id);
  });

  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('dragging');
    dragCardId = null;
    dragSourceColumnId = null;
    clearAllDropIndicators();
  });

  return cardEl;
}

function setupColumnDropZone(colEl, cardList) {
  colEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    colEl.classList.add('drag-over');

    // Determine insertion point
    clearAllDropIndicators();
    const cardEls = [...cardList.querySelectorAll('.card:not(.dragging)')];
    const target = getDropTarget(cardEls, e.clientY);
    
    if (target.element) {
      if (target.position === 'above') {
        target.element.classList.add('drop-target-above');
      } else {
        target.element.classList.add('drop-target-below');
      }
    }
  });

  colEl.addEventListener('dragleave', (e) => {
    // Only remove if we actually left the column
    if (!colEl.contains(e.relatedTarget)) {
      colEl.classList.remove('drag-over');
      clearAllDropIndicators();
    }
  });

  colEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    colEl.classList.remove('drag-over');
    clearAllDropIndicators();

    if (!dragCardId) return;

    const targetColumnId = colEl.dataset.columnId;
    const cardEls = [...cardList.querySelectorAll('.card:not(.dragging)')];
    const target = getDropTarget(cardEls, e.clientY);

    let afterId = null;
    let beforeId = null;

    if (cardEls.length === 0) {
      // Empty column — no after/before
    } else if (!target.element) {
      // After the last card
      afterId = cardEls[cardEls.length - 1].dataset.cardId;
    } else {
      const idx = cardEls.indexOf(target.element);
      if (target.position === 'above') {
        // Before this card
        beforeId = target.element.dataset.cardId;
        if (idx > 0) {
          afterId = cardEls[idx - 1].dataset.cardId;
        }
      } else {
        // After this card
        afterId = target.element.dataset.cardId;
        if (idx < cardEls.length - 1) {
          beforeId = cardEls[idx + 1].dataset.cardId;
        }
      }
    }

    // Optimistic update: get current card state and compute an optimistic position
    const state = getBoardState();
    let movedCard = null;
    for (const col of state.columns) {
      const found = col.cards.find(c => c.id === dragCardId);
      if (found) {
        movedCard = { ...found };
        break;
      }
    }

    if (!movedCard) return;

    // Compute optimistic position
    let optPosition;
    const targetCol = state.columns.find(c => c.id === targetColumnId);
    const targetCards = targetCol ? targetCol.cards.filter(c => c.id !== dragCardId) : [];

    if (afterId && beforeId) {
      const afterCard = targetCards.find(c => c.id === afterId);
      const beforeCard = targetCards.find(c => c.id === beforeId);
      if (afterCard && beforeCard) {
        optPosition = (afterCard.position + beforeCard.position) / 2;
      } else {
        optPosition = targetCards.length > 0 
          ? targetCards[targetCards.length - 1].position + 1000 
          : 1000;
      }
    } else if (afterId) {
      const afterCard = targetCards.find(c => c.id === afterId);
      optPosition = afterCard ? afterCard.position + 1000 : 1000;
    } else if (beforeId) {
      const beforeCard = targetCards.find(c => c.id === beforeId);
      optPosition = beforeCard ? beforeCard.position / 2 : 1000;
    } else {
      optPosition = targetCards.length > 0 
        ? targetCards[targetCards.length - 1].position + 1000 
        : 1000;
    }

    // Optimistic UI update
    const optimisticCard = {
      ...movedCard,
      column_id: targetColumnId,
      position: optPosition,
    };
    
    // Remove from old and add to new
    removeCardFromAllColumns(dragCardId);
    moveCardInState(optimisticCard, dragSourceColumnId);

    // Send to server — server response will reconcile via SSE
    try {
      await moveCard(dragCardId, targetColumnId, afterId, beforeId);
    } catch (err) {
      console.error('Failed to move card:', err);
    }
  });
}

function getDropTarget(cardEls, mouseY) {
  if (cardEls.length === 0) {
    return { element: null, position: null };
  }

  for (const cardEl of cardEls) {
    const rect = cardEl.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (mouseY < midY) {
      return { element: cardEl, position: 'above' };
    }
  }

  // Below all cards
  return { element: null, position: null };
}

function clearAllDropIndicators() {
  document.querySelectorAll('.drop-target-above').forEach(el => el.classList.remove('drop-target-above'));
  document.querySelectorAll('.drop-target-below').forEach(el => el.classList.remove('drop-target-below'));
}
