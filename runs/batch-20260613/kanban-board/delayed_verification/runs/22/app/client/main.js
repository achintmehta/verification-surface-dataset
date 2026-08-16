// ─── Configuration ──────────────────────────────────────────────────────────

const API_BASE = '/api';

// ─── State ──────────────────────────────────────────────────────────────────

let boardState = []; // Array of { id, title, position, cards: [...] }
let dragState = null; // { cardId, sourceColumnId, cardEl }

// ─── API helpers ────────────────────────────────────────────────────────────

async function fetchBoard() {
  const res = await fetch(`${API_BASE}/board`);
  if (!res.ok) throw new Error('Failed to fetch board');
  return res.json();
}

async function createCard(columnId, text) {
  const res = await fetch(`${API_BASE}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text })
  });
  if (!res.ok) throw new Error('Failed to create card');
  return res.json();
}

async function moveCard(cardId, columnId, afterId, beforeId) {
  const res = await fetch(`${API_BASE}/cards/${cardId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, afterId, beforeId })
  });
  if (!res.ok) throw new Error('Failed to move card');
  return res.json();
}

async function deleteCard(cardId) {
  const res = await fetch(`${API_BASE}/cards/${cardId}`, {
    method: 'DELETE'
  });
  if (!res.ok) throw new Error('Failed to delete card');
  return res.json();
}

// ─── DOM Rendering ──────────────────────────────────────────────────────────

const boardEl = document.getElementById('board');

function renderBoard() {
  boardEl.innerHTML = '';
  for (const column of boardState) {
    boardEl.appendChild(createColumnEl(column));
  }
}

function createColumnEl(column) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = column.id;

  // Header
  const headerEl = document.createElement('div');
  headerEl.className = 'column-header';
  headerEl.textContent = column.title;
  colEl.appendChild(headerEl);

  // Card list
  const listEl = document.createElement('div');
  listEl.className = 'card-list';
  listEl.dataset.columnId = column.id;

  for (const card of column.cards) {
    listEl.appendChild(createCardEl(card));
  }

  colEl.appendChild(listEl);

  // Add card area
  const addFormEl = createAddCardForm(column.id);
  colEl.appendChild(addFormEl);

  // Drag-and-drop events on the card list
  setupDropZone(listEl, column.id);

  return colEl;
}

function createCardEl(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.dataset.cardId = card.id;
  cardEl.dataset.columnId = card.column_id;
  cardEl.draggable = true;

  const textNode = document.createTextNode(card.text);
  cardEl.appendChild(textNode);

  // Delete button
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'delete-btn';
  deleteBtn.textContent = '✕';
  deleteBtn.title = 'Delete card';
  deleteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await deleteCard(card.id);
    } catch (err) {
      console.error('Delete failed:', err);
    }
  });
  cardEl.appendChild(deleteBtn);

  // Drag start
  cardEl.addEventListener('dragstart', (e) => {
    dragState = {
      cardId: card.id,
      sourceColumnId: card.column_id,
      cardEl
    };
    cardEl.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.id.toString());
  });

  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('dragging');
    clearAllDropIndicators();
    clearAllDragOver();
    dragState = null;
  });

  return cardEl;
}

function createAddCardForm(columnId) {
  const container = document.createElement('div');
  container.className = 'add-card-form';

  const addBtn = document.createElement('button');
  addBtn.className = 'add-card-btn';
  addBtn.textContent = '+ Add a card';

  const formEl = document.createElement('div');
  formEl.style.display = 'none';

  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Enter a title for this card...';

  const actions = document.createElement('div');
  actions.className = 'form-actions';

  const submitBtn = document.createElement('button');
  submitBtn.className = 'submit-btn';
  submitBtn.textContent = 'Add Card';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'cancel-btn';
  cancelBtn.textContent = 'Cancel';

  actions.appendChild(submitBtn);
  actions.appendChild(cancelBtn);
  formEl.appendChild(textarea);
  formEl.appendChild(actions);

  addBtn.addEventListener('click', () => {
    addBtn.style.display = 'none';
    formEl.style.display = 'block';
    textarea.value = '';
    textarea.focus();
  });

  cancelBtn.addEventListener('click', () => {
    addBtn.style.display = 'block';
    formEl.style.display = 'none';
  });

  const doSubmit = async () => {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = '';
    try {
      await createCard(columnId, text);
    } catch (err) {
      console.error('Failed to create card:', err);
    }
  };

  submitBtn.addEventListener('click', doSubmit);

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSubmit();
    }
    if (e.key === 'Escape') {
      addBtn.style.display = 'block';
      formEl.style.display = 'none';
    }
  });

  container.appendChild(addBtn);
  container.appendChild(formEl);
  return container;
}

// ─── Drag and Drop ──────────────────────────────────────────────────────────

function setupDropZone(listEl, columnId) {
  listEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    if (!dragState) return;

    const colEl = listEl.closest('.column');
    colEl.classList.add('drag-over');

    // Determine insertion point
    const cardEls = [...listEl.querySelectorAll('.card:not(.dragging)')];
    const insertIndex = getInsertIndex(cardEls, e.clientY);

    // Show drop indicator
    clearAllDropIndicators();
    showDropIndicator(listEl, insertIndex, cardEls);
  });

  listEl.addEventListener('dragleave', (e) => {
    // Only trigger if actually leaving the list
    if (!listEl.contains(e.relatedTarget)) {
      const colEl = listEl.closest('.column');
      colEl.classList.remove('drag-over');
      clearDropIndicators(listEl);
    }
  });

  listEl.addEventListener('drop', (e) => {
    e.preventDefault();
    clearAllDropIndicators();
    clearAllDragOver();

    if (!dragState) return;

    const { cardId, sourceColumnId } = dragState;

    // Get cards in target column (excluding the dragged card)
    const cardEls = [...listEl.querySelectorAll('.card:not(.dragging)')];
    const insertIndex = getInsertIndex(cardEls, e.clientY);

    // Determine afterId and beforeId
    let afterId = null;
    let beforeId = null;

    if (insertIndex > 0) {
      afterId = parseInt(cardEls[insertIndex - 1].dataset.cardId, 10);
    }
    if (insertIndex < cardEls.length) {
      beforeId = parseInt(cardEls[insertIndex].dataset.cardId, 10);
    }

    // Optimistic update: move cardin DOM immediately
    optimisticMove(cardId, sourceColumnId, columnId, insertIndex, cardEls);

    // Send to server
    moveCard(cardId, columnId, afterId, beforeId).catch(err => {
      console.error('Move failed, re-fetching board:', err);
      // On failure, re-fetch the board to reconcile
      loadBoard();
    });
  });
}

function getInsertIndex(cardEls, mouseY) {
  for (let i = 0; i < cardEls.length; i++) {
    const rect = cardEls[i].getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (mouseY < midY) {
      return i;
    }
  }
  return cardEls.length;
}

function showDropIndicator(listEl, insertIndex, cardEls) {
  const indicator = document.createElement('div');
  indicator.className = 'drop-indicator';

  if (insertIndex < cardEls.length) {
    listEl.insertBefore(indicator, cardEls[insertIndex]);
  } else {
    listEl.appendChild(indicator);
  }
}

function clearDropIndicators(listEl) {
  const indicators = listEl.querySelectorAll('.drop-indicator');
  indicators.forEach(el => el.remove());
}

function clearAllDropIndicators() {
  document.querySelectorAll('.drop-indicator').forEach(el => el.remove());
}

function clearAllDragOver() {
  document.querySelectorAll('.column.drag-over').forEach(el => el.classList.remove('drag-over'));
}

function optimisticMove(cardId, sourceColumnId, targetColumnId, insertIndex, targetCardEls) {
  const cardEl = document.querySelector(`.card[data-card-id="${cardId}"]`);
  if (!cardEl) return;

  // Remove from current location
  cardEl.remove();

  // Insert into target list
  const targetList = document.querySelector(`.card-list[data-column-id="${targetColumnId}"]`);
  if (!targetList) return;

  // Re-query actual card elements in the target (excluding drop indicators)
  const currentCardEls = [...targetList.querySelectorAll('.card')];

  if (insertIndex < currentCardEls.length) {
    targetList.insertBefore(cardEl, currentCardEls[insertIndex]);
  } else {
    targetList.appendChild(cardEl);
  }

  // Update card's columnId data attribute
  cardEl.dataset.columnId = targetColumnId;
  cardEl.classList.add('optimistic');
  cardEl.classList.remove('dragging');
}

// ─── SSE Connection ─────────────────────────────────────────────────────────

function connectSSE() {
  const statusEl = document.getElementById('connection-status');
  const evtSource = new EventSource(`${API_BASE}/stream`);

  evtSource.addEventListener('connected', () => {
    statusEl.textContent = 'Connected';
    statusEl.className = 'status connected';
  });

  evtSource.addEventListener('card_created', (e) => {
    const { card } = JSON.parse(e.data);
    handleCardCreated(card);
  });

  evtSource.addEventListener('card_moved', (e) => {
    const { card, fromColumnId, toColumnId } = JSON.parse(e.data);
    handleCardMoved(card, fromColumnId, toColumnId);
  });

  evtSource.addEventListener('card_deleted', (e) => {
    const { cardId, columnId } = JSON.parse(e.data);
    handleCardDeleted(cardId, columnId);
  });

  evtSource.addEventListener('column_renormalized', (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    handleColumnRenormalized(columnId, cards);
  });

  evtSource.onerror = () => {
    statusEl.textContent = 'Disconnected';
    statusEl.className = 'status disconnected';
  };

  evtSource.onopen = () => {
    statusEl.textContent = 'Connected';
    statusEl.className = 'status connected';
  };

  return evtSource;
}

// ─── SSE Event Handlers ────────────────────────────────────────────────────

function handleCardCreated(card) {
  // Update internal state
  const column = boardState.find(c => c.id === card.column_id);
  if (column) {
    // Remove if already exists (dedup)
    column.cards = column.cards.filter(c => c.id !== card.id);
    column.cards.push(card);
    column.cards.sort((a, b) => a.position - b.position || a.id - b.id);
  }

  // Update DOM: ensure the card is in the correct column and position
  reconcileCard(card);
}

function handleCardMoved(card, fromColumnId, toColumnId) {
  // Update internal state: remove card from all columns, add to target
  for (const col of boardState) {
    col.cards = col.cards.filter(c => c.id !== card.id);
  }
  const targetCol = boardState.find(c => c.id === toColumnId);
  if (targetCol) {
    targetCol.cards.push(card);
    targetCol.cards.sort((a, b) => a.position - b.position || a.id - b.id);
  }

  // Reconcile DOM
  reconcileCard(card);
}

function handleCardDeleted(cardId, columnId) {
  // Update internal state
  for (const col of boardState) {
    col.cards = col.cards.filter(c => c.id !== cardId);
  }

  // Remove from DOM
  const cardEl = document.querySelector(`.card[data-card-id="${cardId}"]`);
  if (cardEl) cardEl.remove();
}

function handleColumnRenormalized(columnId, cards) {
  // Update internal state
  const column = boardState.find(c => c.id === columnId);
  if (column) {
    column.cards = cards;
    column.cards.sort((a, b) => a.position - b.position || a.id - b.id);
  }

  // Re-render the affected column's card list
  reconcileColumn(columnId);
}

// ─── Reconciliation ────────────────────────────────────────────────────────

function reconcileCard(card) {
  // Remove the card from wherever it currently is in the DOM
  const existingEl = document.querySelector(`.card[data-card-id="${card.id}"]`);
  if (existingEl) {
    existingEl.remove();
  }

  // Find the target column's card list
  const targetList = document.querySelector(`.card-list[data-column-id="${card.column_id}"]`);
  if (!targetList) return;

  // Create the card element
  const newCardEl = createCardEl(card);

  // Find the correct position using the internal state
  const column = boardState.find(c => c.id === card.column_id);
  if (!column) return;

  const cardIndex = column.cards.findIndex(c => c.id === card.id);

  // Get existing card elements in the target list
  const cardEls = [...targetList.querySelectorAll('.card')];

  // Find the card element that should come after this one
  let insertBefore = null;
  if (cardIndex >= 0 && cardIndex < column.cards.length - 1) {
    const nextCardId = column.cards[cardIndex + 1].id;
    insertBefore = targetList.querySelector(`.card[data-card-id="${nextCardId}"]`);
  }

  if (insertBefore) {
    targetList.insertBefore(newCardEl, insertBefore);
  } else {
    targetList.appendChild(newCardEl);
  }
}

function reconcileColumn(columnId) {
  const column = boardState.find(c => c.id === columnId);
  if (!column) return;

  const listEl = document.querySelector(`.card-list[data-column-id="${columnId}"]`);
  if (!listEl) return;

  // Remove all card elements
  const existingCards = listEl.querySelectorAll('.card');
  existingCards.forEach(el => el.remove());

  // Re-create in order
  for (const card of column.cards) {
    listEl.appendChild(createCardEl(card));
  }
}

// ─── Initialization ────────────────────────────────────────────────────────

async function loadBoard() {
  try {
    boardState = await fetchBoard();
    renderBoard();
  } catch (err) {
    console.error('Failed to load board:', err);
    boardEl.innerHTML = '<p style="color:white;padding:20px;">Failed to load board. Is the server running?</p>';
  }
}

async function init() {
  await loadBoard();
  connectSSE();
}

init();
