import { fetchBoard, createCard, moveCard, deleteCard, connectSSE } from './api.js';

// In-memory board state
let boardState = { columns: [] };

// Track pending optimistic operations
let pendingMoves = new Set();

// ============= STATE MANAGEMENT =============

function getColumn(columnId) {
  return boardState.columns.find(c => c.id === columnId);
}

function getCardFromBoard(cardId) {
  for (const col of boardState.columns) {
    const card = col.cards.find(c => c.id === cardId);
    if (card) return { card, column: col };
  }
  return null;
}

function removeCardFromAllColumns(cardId) {
  for (const col of boardState.columns) {
    col.cards = col.cards.filter(c => c.id !== cardId);
  }
}

function insertCardIntoColumn(column, card, afterId, beforeId) {
  // Remove from all columns first to prevent duplication
  removeCardFromAllColumns(card.id);
  
  if (afterId) {
    const afterIdx = column.cards.findIndex(c => c.id === afterId);
    if (afterIdx >= 0) {
      column.cards.splice(afterIdx + 1, 0, card);
      return;
    }
  }
  
  if (beforeId) {
    const beforeIdx = column.cards.findIndex(c => c.id === beforeId);
    if (beforeIdx >= 0) {
      column.cards.splice(beforeIdx, 0, card);
      return;
    }
  }
  
  // Default: append to end
  column.cards.push(card);
}

function applyCanonicalCard(card) {
  removeCardFromAllColumns(card.id);
  const col = getColumn(card.columnId);
  if (!col) return;
  
  // Insert in sorted position by server position
  let inserted = false;
  for (let i = 0; i < col.cards.length; i++) {
    if (card.position < col.cards[i].position) {
      col.cards.splice(i, 0, card);
      inserted = true;
      break;
    }
  }
  if (!inserted) {
    col.cards.push(card);
  }
}

// ============= RENDERING =============

function renderBoard() {
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';

  for (const column of boardState.columns) {
    const colEl = createColumnElement(column);
    boardEl.appendChild(colEl);
  }
}

function createColumnElement(column) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = column.id;

  const header = document.createElement('div');
  header.className = 'column-header';
  header.textContent = column.title;
  colEl.appendChild(header);

  const cardList = document.createElement('div');
  cardList.className = 'card-list';
  cardList.dataset.columnId = column.id;

  for (const card of column.cards) {
    const cardEl = createCardElement(card);
    cardList.appendChild(cardEl);
  }

  setupDropZone(cardList, column.id);
  colEl.appendChild(cardList);

  const addForm = createAddCardForm(column.id);
  colEl.appendChild(addForm);

  return colEl;
}

function createCardElement(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.cardId = card.id;
  el.draggable = true;

  const textSpan = document.createElement('span');
  textSpan.textContent = card.text;
  el.appendChild(textSpan);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'delete-btn';
  deleteBtn.textContent = '×';
  deleteBtn.title = 'Delete card';
  deleteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    removeCardFromAllColumns(card.id);
    renderBoard();
    try {
      await deleteCard(card.id);
    } catch (err) {
      console.error('Failed to delete card:', err);
      // Reload to reconcile
      await loadBoard();
    }
  });
  el.appendChild(deleteBtn);

  // Drag events
  el.addEventListener('dragstart', (e) => {
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.id);
    // Use a slight delay so the dragging class shows
    requestAnimationFrame(() => {
      el.style.opacity = '0.5';
    });
  });

  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    el.style.opacity = '';
    clearAllDropIndicators();
  });

  return el;
}

function createAddCardForm(columnId) {
  const form = document.createElement('div');
  form.className = 'add-card-form';

  const btn = document.createElement('button');
  btn.className = 'add-card-btn';
  btn.textContent = '+ Add a card';
  btn.addEventListener('click', () => {
    form.classList.add('editing');
    textarea.focus();
  });
  form.appendChild(btn);

  const inputArea = document.createElement('div');
  inputArea.className = 'card-input-area';

  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Enter a title for this card...';
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitCard();
    }
    if (e.key === 'Escape') {
      cancelAdd();
    }
  });
  inputArea.appendChild(textarea);

  const actions = document.createElement('div');
  actions.className = 'card-input-actions';

  const addBtn = document.createElement('button');
  addBtn.className = 'btn-add';
  addBtn.textContent = 'Add Card';
  addBtn.addEventListener('click', submitCard);
  actions.appendChild(addBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-cancel';
  cancelBtn.textContent = '×';
  cancelBtn.addEventListener('click', cancelAdd);
  actions.appendChild(cancelBtn);

  inputArea.appendChild(actions);
  form.appendChild(inputArea);

  async function submitCard() {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = '';
    form.classList.remove('editing');

    try {
      await createCard(columnId, text);
      // Card will arrive via SSE and get rendered
    } catch (err) {
      console.error('Failed to create card:', err);
    }
  }

  function cancelAdd() {
    textarea.value = '';
    form.classList.remove('editing');
  }

  return form;
}

// ============= DRAG AND DROP =============

let dragCardId = null;

function clearAllDropIndicators() {
  document.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => {
    el.classList.remove('drag-over-top', 'drag-over-bottom');
  });
  document.querySelectorAll('.drag-over-empty').forEach(el => {
    el.classList.remove('drag-over-empty');
  });
  document.querySelectorAll('.drop-placeholder').forEach(el => {
    el.remove();
  });
}

function setupDropZone(cardList, columnId) {
  cardList.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    clearAllDropIndicators();

    const draggingCardId = getDraggingCardId();
    if (!draggingCardId) return;

    const cards = [...cardList.querySelectorAll('.card:not(.dragging)')];

    if (cards.length === 0) {
      cardList.classList.add('drag-over-empty');
      return;
    }

    const { element, position } = getDropTarget(e, cards);
    if (element) {
      if (position === 'before') {
        element.classList.add('drag-over-top');
      } else {
        element.classList.add('drag-over-bottom');
      }
    } else {
      // After last card
      const lastCard = cards[cards.length - 1];
      if (lastCard) {
        lastCard.classList.add('drag-over-bottom');
      }
    }
  });

  cardList.addEventListener('dragleave', (e) => {
    if (!cardList.contains(e.relatedTarget)) {
      clearAllDropIndicators();
    }
  });

  cardList.addEventListener('drop', async (e) => {
    e.preventDefault();
    clearAllDropIndicators();

    const cardId = e.dataTransfer.getData('text/plain');
    if (!cardId) return;

    const cards = [...cardList.querySelectorAll('.card:not(.dragging)')];
    const { element, position } = getDropTarget(e, cards);

    let afterId = null;
    let beforeId = null;

    if (cards.length === 0) {
      // Empty column, no anchors needed
    } else if (element) {
      const targetCardId = element.dataset.cardId;
      if (position === 'before') {
        beforeId = targetCardId;
        // afterId is the card before this one
        const idx = cards.indexOf(element);
        if (idx > 0) {
          afterId = cards[idx - 1].dataset.cardId;
        }
      } else {
        afterId = targetCardId;
        const idx = cards.indexOf(element);
        if (idx < cards.length - 1) {
          beforeId = cards[idx + 1].dataset.cardId;
        }
      }
    } else {
      // After last card
      if (cards.length > 0) {
        afterId = cards[cards.length - 1].dataset.cardId;
      }
    }

    // Skip if dropping on itself
    const found = getCardFromBoard(cardId);
    if (!found) return;
    
    // Determine if the card would end up in the same position
    if (found.column.id === columnId) {
      const currentCards = found.column.cards;
      const currentIdx = currentCards.findIndex(c => c.id === cardId);
      
      // Build expected neighbor IDs at current position
      const currentAfterId = currentIdx > 0 ? currentCards[currentIdx - 1].id : null;
      const currentBeforeId = currentIdx < currentCards.length - 1 ? currentCards[currentIdx + 1].id : null;
      
      // Check if the drop position is the same as current
      const sameAfter = afterId === currentAfterId || afterId === cardId;
      const sameBefore = beforeId === currentBeforeId || beforeId === cardId;
      
      if ((afterId === currentAfterId && beforeId === currentBeforeId) ||
          (afterId === currentAfterId && beforeId === null && currentBeforeId === null) ||
          (afterId === null && beforeId === currentBeforeId && currentAfterId === null)) {
        return; // Same position, no-op
      }
    }

    // Optimistic update
    if (found) {
      const targetCol = getColumn(columnId);
      if (targetCol) {
        // Remove card from current column
        removeCardFromAllColumns(cardId);
        
        // Insert at correct position  
        let insertIdx = targetCol.cards.length;
        if (beforeId) {
          const bIdx = targetCol.cards.findIndex(c => c.id === beforeId);
          if (bIdx >= 0) insertIdx = bIdx;
        } else if (afterId) {
          const aIdx = targetCol.cards.findIndex(c => c.id === afterId);
          if (aIdx >= 0) insertIdx = aIdx + 1;
        }
        
        const movedCard = { ...found.card, columnId };
        targetCol.cards.splice(insertIdx, 0, movedCard);
        
        pendingMoves.add(cardId);
        renderBoard();
      }
    }

    // Send to server
    try {
      const canonical = await moveCard(cardId, columnId, afterId, beforeId);
      pendingMoves.delete(cardId);
      // Server response will reconcile via SSE
    } catch (err) {
      console.error('Failed to move card:', err);
      pendingMoves.delete(cardId);
      // Reload to reconcile
      await loadBoard();
    }
  });
}

function getDraggingCardId() {
  const dragging = document.querySelector('.card.dragging');
  return dragging ? dragging.dataset.cardId : null;
}

function getDropTarget(e, cards) {
  if (cards.length === 0) {
    return { element: null, position: null };
  }

  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    
    if (e.clientY < midY) {
      return { element: card, position: 'before' };
    }
  }

  return { element: cards[cards.length - 1], position: 'after' };
}

// ============= SSE EVENT HANDLERS =============

function handleCardCreated(card) {
  // Check if card already exists (from our own optimistic create)
  const existing = getCardFromBoard(card.id);
  if (existing) return;

  const col = getColumn(card.columnId);
  if (!col) return;

  applyCanonicalCard(card);
  renderBoard();
}

function handleCardMoved(data) {
  const { card, sourceColumnId } = data;

  // If this was our own pending move, reconcile
  if (pendingMoves.has(card.id)) {
    // The SSE event confirms our move. Apply canonical state to fix any position discrepancies.
    pendingMoves.delete(card.id);
  }

  applyCanonicalCard(card);
  renderBoard();
}

function handleCardDeleted(data) {
  removeCardFromAllColumns(data.id);
  renderBoard();
}

function handleColumnRenormalized(data) {
  const col = getColumn(data.columnId);
  if (!col) return;

  // Update positions for all cards in the column
  for (const update of data.cards) {
    const card = col.cards.find(c => c.id === update.id);
    if (card) {
      card.position = update.position;
    }
  }

  // Re-sort the column by position
  col.cards.sort((a, b) => a.position - b.position);
  renderBoard();
}

// ============= INITIALIZATION =============

async function loadBoard() {
  try {
    const data = await fetchBoard();
    boardState = data;
    renderBoard();
  } catch (err) {
    console.error('Failed to load board:', err);
    setTimeout(loadBoard, 2000);
  }
}

function setupSSE() {
  const statusEl = document.getElementById('connection-status');

  connectSSE({
    onCardCreated: handleCardCreated,
    onCardMoved: handleCardMoved,
    onCardDeleted: handleCardDeleted,
    onColumnRenormalized: handleColumnRenormalized,
    onConnected: () => {
      statusEl.textContent = 'Connected';
      statusEl.className = 'status connected';
      // Reload board on reconnection to catch up on missed events
      loadBoard();
    },
    onDisconnected: () => {
      statusEl.textContent = 'Reconnecting...';
      statusEl.className = 'status disconnected';
    }
  });
}

// Start the app
loadBoard();
setupSSE();
