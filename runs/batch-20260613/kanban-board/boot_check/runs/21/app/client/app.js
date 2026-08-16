// ========================================
// Kanban Board - Client Application
// ========================================

const API_BASE = '/api';

// ---- State ----
let boardState = { columns: [] };
let dragState = null; // { cardId, sourceColumnId, cardEl }

// ---- API Helpers ----
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
    body: JSON.stringify({ columnId, afterId: afterId || null, beforeId: beforeId || null })
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

// ---- Rendering ----
function renderBoard() {
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';

  for (const column of boardState.columns) {
    boardEl.appendChild(createColumnEl(column));
  }
}

function createColumnEl(column) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = column.id;

  const headerEl = document.createElement('div');
  headerEl.className = 'column-header';
  headerEl.textContent = `${column.title} (${column.cards.length})`;
  colEl.appendChild(headerEl);

  const cardListEl = document.createElement('div');
  cardListEl.className = 'card-list';
  cardListEl.dataset.columnId = column.id;

  // Sorted cards
  const sortedCards = [...column.cards].sort((a, b) => a.position - b.position);
  for (const card of sortedCards) {
    cardListEl.appendChild(createCardEl(card));
  }

  // Drop zone events
  cardListEl.addEventListener('dragover', handleDragOver);
  cardListEl.addEventListener('dragenter', handleDragEnter);
  cardListEl.addEventListener('dragleave', handleDragLeave);
  cardListEl.addEventListener('drop', handleDrop);

  colEl.appendChild(cardListEl);

  // Add card button / form
  const addSection = document.createElement('div');
  addSection.className = 'add-card-form';
  addSection.innerHTML = `
    <button class="add-card-btn" data-column-id="${column.id}">+ Add a card</button>
  `;
  addSection.querySelector('.add-card-btn').addEventListener('click', () => showAddCardForm(addSection, column.id));
  colEl.appendChild(addSection);

  return colEl;
}

function createCardEl(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.dataset.cardId = card.id;
  cardEl.dataset.columnId = card.columnId;
  cardEl.draggable = true;

  const textNode = document.createTextNode(card.text);
  cardEl.appendChild(textNode);

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

  cardEl.addEventListener('dragstart', (e) => handleDragStart(e, card));
  cardEl.addEventListener('dragend', handleDragEnd);

  return cardEl;
}

function showAddCardForm(container, columnId) {
  container.innerHTML = `
    <textarea placeholder="Enter a title for this card..." autofocus></textarea>
    <div class="form-actions">
      <button class="btn-add">Add Card</button>
      <button class="btn-cancel">✕</button>
    </div>
  `;

  const textarea = container.querySelector('textarea');
  const addBtn = container.querySelector('.btn-add');
  const cancelBtn = container.querySelector('.btn-cancel');

  textarea.focus();

  const submit = async () => {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.disabled = true;
    addBtn.disabled = true;
    try {
      await createCard(columnId, text);
      // Optionally keep form open for rapid entry
      textarea.value = '';
      textarea.disabled = false;
      addBtn.disabled = false;
      textarea.focus();
    } catch (err) {
      console.error('Failed to create card:', err);
      textarea.disabled = false;
      addBtn.disabled = false;
    }
  };

  addBtn.addEventListener('click', submit);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'Escape') {
      hideAddCardForm(container, columnId);
    }
  });

  cancelBtn.addEventListener('click', () => hideAddCardForm(container, columnId));
}

function hideAddCardForm(container, columnId) {
  container.innerHTML = `
    <button class="add-card-btn" data-column-id="${columnId}">+ Add a card</button>
  `;
  container.querySelector('.add-card-btn').addEventListener('click', () => showAddCardForm(container, columnId));
}

// ---- Drag and Drop ----
function handleDragStart(e, card) {
  dragState = {
    cardId: card.id,
    sourceColumnId: card.columnId,
    cardEl: e.target
  };
  e.target.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', card.id);
}

function handleDragEnd(e) {
  e.target.classList.remove('dragging');
  // Remove all drop indicators
  document.querySelectorAll('.drop-indicator').forEach(el => el.remove());
  document.querySelectorAll('.card-list.drag-over').forEach(el => el.classList.remove('drag-over'));
  dragState = null;
}

function handleDragEnter(e) {
  e.preventDefault();
  const cardList = e.currentTarget;
  cardList.classList.add('drag-over');
}

function handleDragLeave(e) {
  const cardList = e.currentTarget;
  // Only remove if truly leaving the card list
  if (!cardList.contains(e.relatedTarget)) {
    cardList.classList.remove('drag-over');
    cardList.querySelectorAll('.drop-indicator').forEach(el => el.remove());
  }
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  if (!dragState) return;

  const cardList = e.currentTarget;

  // Remove existing drop indicators
  cardList.querySelectorAll('.drop-indicator').forEach(el => el.remove());

  const cards = [...cardList.querySelectorAll('.card:not(.dragging)')];
  const mouseY = e.clientY;

  let insertBeforeEl = null;
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (mouseY < midY) {
      insertBeforeEl = card;
      break;
    }
  }

  const indicator = document.createElement('div');
  indicator.className = 'drop-indicator';

  if (insertBeforeEl) {
    cardList.insertBefore(indicator, insertBeforeEl);
  } else {
    cardList.appendChild(indicator);
  }
}

function handleDrop(e) {
  e.preventDefault();

  if (!dragState) return;

  const cardList = e.currentTarget;
  const targetColumnId = cardList.dataset.columnId;

  // Remove drop indicators
  cardList.querySelectorAll('.drop-indicator').forEach(el => el.remove());
  cardList.classList.remove('drag-over');

  const cards = [...cardList.querySelectorAll('.card:not(.dragging)')];
  const mouseY = e.clientY;

  let insertBeforeEl = null;
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (mouseY < midY) {
      insertBeforeEl = card;
      break;
    }
  }

  // Determine afterId and beforeId
  let afterId = null;
  let beforeId = null;

  if (insertBeforeEl) {
    beforeId = insertBeforeEl.dataset.cardId;
    const prevEl = insertBeforeEl.previousElementSibling;
    if (prevEl && prevEl.classList.contains('card') && !prevEl.classList.contains('dragging')) {
      afterId = prevEl.dataset.cardId;
    }
  } else {
    // After the last card
    const lastCard = cards[cards.length - 1];
    if (lastCard) {
      afterId = lastCard.dataset.cardId;
    }
  }

  // Optimistic DOM update: move the card element
  const draggingEl = dragState.cardEl;
  draggingEl.classList.remove('dragging');

  // Remove from old position
  if (draggingEl.parentNode) {
    draggingEl.parentNode.removeChild(draggingEl);
  }

  // Insert at new position
  if (insertBeforeEl) {
    cardList.insertBefore(draggingEl, insertBeforeEl);
  } else {
    cardList.appendChild(draggingEl);
  }

  // Update dataset
  draggingEl.dataset.columnId = targetColumnId;

  // Update column headers optimistically
  updateColumnHeaders();

  // Send move request to server
  const { cardId, sourceColumnId } = dragState;
  moveCard(cardId, targetColumnId, afterId, beforeId).catch(err => {
    console.error('Move failed, reloading board:', err);
    loadBoard();
  });

  dragState = null;
}

function updateColumnHeaders() {
  for (const column of boardState.columns) {
    const colEl = document.querySelector(`.column[data-column-id="${column.id}"]`);
    if (colEl) {
      const cardCount = colEl.querySelectorAll('.card-list .card').length;
      const headerEl = colEl.querySelector('.column-header');
      if (headerEl) {
        headerEl.textContent = `${column.title} (${cardCount})`;
      }
    }
  }
}

// ---- SSE Connection ----
function connectSSE() {
  const statusEl = document.getElementById('connection-status');
  const evtSource = new EventSource(`${API_BASE}/stream`);

  evtSource.onopen = () => {
    statusEl.textContent = 'Connected';
    statusEl.className = 'status connected';
  };

  evtSource.onerror = () => {
    statusEl.textContent = 'Disconnected';
    statusEl.className = 'status disconnected';
  };

  evtSource.addEventListener('card-created', (e) => {
    const card = JSON.parse(e.data);
    handleCardCreated(card);
  });

  evtSource.addEventListener('card-moved', (e) => {
    const data = JSON.parse(e.data);
    handleCardMoved(data);
  });

  evtSource.addEventListener('card-deleted', (e) => {
    const data = JSON.parse(e.data);
    handleCardDeleted(data);
  });

  evtSource.addEventListener('column-renormalized', (e) => {
    const data = JSON.parse(e.data);
    handleColumnRenormalized(data);
  });

  return evtSource;
}

// ---- SSE Event Handlers ----
function handleCardCreated(card) {
  // Update state
  const column = boardState.columns.find(c => c.id === card.columnId);
  if (!column) return;

  // Check if card already exists (from our own optimistic add)
  const existingIdx = column.cards.findIndex(c => c.id === card.id);
  if (existingIdx >= 0) {
    column.cards[existingIdx] = card;
  } else {
    column.cards.push(card);
  }

  // Sort and re-render cards in this column
  renderColumnCards(column);
}

function handleCardMoved(data) {
  const { card, sourceColumnId } = data;

  // Remove card from all columns in state
  for (const col of boardState.columns) {
    col.cards = col.cards.filter(c => c.id !== card.id);
  }

  // Add card to target column
  const targetCol = boardState.columns.find(c => c.id === card.columnId);
  if (targetCol) {
    targetCol.cards.push(card);
  }

  // Re-render affected columns
  const affectedColumnIds = new Set([card.columnId]);
  if (sourceColumnId) affectedColumnIds.add(sourceColumnId);

  for (const colId of affectedColumnIds) {
    const col = boardState.columns.find(c => c.id === colId);
    if (col) renderColumnCards(col);
  }
}

function handleCardDeleted(data) {
  const { id, columnId } = data;
  const column = boardState.columns.find(c => c.id === columnId);
  if (column) {
    column.cards = column.cards.filter(c => c.id !== id);
    renderColumnCards(column);
  }
}

function handleColumnRenormalized(data) {
  const { columnId, cards: updatedCards } = data;
  const column = boardState.columns.find(c => c.id === columnId);
  if (!column) return;

  for (const update of updatedCards) {
    const card = column.cards.find(c => c.id === update.id);
    if (card) {
      card.position = update.position;
    }
  }
  // No need to re-render since order doesn't change during renormalization
}

function renderColumnCards(column) {
  const cardListEl = document.querySelector(`.card-list[data-column-id="${column.id}"]`);
  if (!cardListEl) return;

  // Preserve any active drag
  const draggingCardId = dragState ? dragState.cardId : null;

  // Sort cards by position
  const sortedCards = [...column.cards].sort((a, b) => a.position - b.position);

  // Clear and rebuild
  cardListEl.innerHTML = '';
  for (const card of sortedCards) {
    const cardEl = createCardEl(card);
    if (card.id === draggingCardId) {
      cardEl.classList.add('dragging');
    }
    cardListEl.appendChild(cardEl);
  }

  // Update column header
  const colEl = cardListEl.closest('.column');
  if (colEl) {
    const headerEl = colEl.querySelector('.column-header');
    if (headerEl) {
      headerEl.textContent = `${column.title} (${sortedCards.length})`;
    }
  }
}

// ---- Initial Load ----
async function loadBoard() {
  try {
    const data = await fetchBoard();
    boardState = data;
    renderBoard();
  } catch (err) {
    console.error('Failed to load board:', err);
    document.getElementById('board').innerHTML = '<p style="color:white;padding:20px;">Failed to load board. Please refresh.</p>';
  }
}

// ---- Bootstrap ----
async function init() {
  await loadBoard();
  connectSSE();
}

init();
