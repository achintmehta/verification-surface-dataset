// ===== State =====
let boardState = { columns: [] };

// Track pending optimistic moves
const pendingMoves = new Map();

// ===== API =====
const API_BASE = '/api';

async function fetchBoard() {
  const res = await fetch(`${API_BASE}/board`);
  if (!res.ok) throw new Error('Failed to fetch board');
  return res.json();
}

async function createCard(columnId, text) {
  const res = await fetch(`${API_BASE}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text }),
  });
  if (!res.ok) throw new Error('Failed to create card');
  return res.json();
}

async function moveCard(cardId, columnId, afterId, beforeId) {
  const res = await fetch(`${API_BASE}/cards/${cardId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, afterId: afterId || null, beforeId: beforeId || null }),
  });
  if (!res.ok) throw new Error('Failed to move card');
  return res.json();
}

async function deleteCard(cardId) {
  const res = await fetch(`${API_BASE}/cards/${cardId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete card');
  return res.json();
}

// ===== SSE =====
function connectSSE() {
  const statusEl = document.getElementById('connection-status');
  const eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.onopen = () => {
    statusEl.className = 'connection-status connected';
    statusEl.querySelector('.status-text').textContent = 'Connected';
  };

  eventSource.onerror = () => {
    statusEl.className = 'connection-status disconnected';
    statusEl.querySelector('.status-text').textContent = 'Reconnecting…';
  };

  eventSource.addEventListener('card:created', (e) => {
    const { card } = JSON.parse(e.data);
    handleCardCreated(card);
  });

  eventSource.addEventListener('card:moved', (e) => {
    const { card, sourceColumnId } = JSON.parse(e.data);
    handleCardMoved(card, sourceColumnId);
  });

  eventSource.addEventListener('card:deleted', (e) => {
    const { cardId, columnId } = JSON.parse(e.data);
    handleCardDeleted(cardId, columnId);
  });

  eventSource.addEventListener('column:renormalized', (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    handleColumnRenormalized(columnId, cards);
  });

  return eventSource;
}

// ===== SSE Handlers =====
function handleCardCreated(card) {
  const column = boardState.columns.find((c) => c.id === card.column_id);
  if (!column) return;

  // Check if card already exists (optimistic add or duplicate event)
  const existing = column.cards.find((c) => c.id === card.id);
  if (existing) {
    Object.assign(existing, card);
  } else {
    column.cards.push(card);
  }
  column.cards.sort((a, b) => a.position - b.position);
  renderColumn(column);
}

function handleCardMoved(card, sourceColumnId) {
  // Remove pending move tracking
  pendingMoves.delete(card.id);

  // Remove card from all columns (ensuring it exists in only one)
  for (const col of boardState.columns) {
    col.cards = col.cards.filter((c) => c.id !== card.id);
  }

  // Add card to target column
  const targetColumn = boardState.columns.find((c) => c.id === card.column_id);
  if (targetColumn) {
    targetColumn.cards.push(card);
    targetColumn.cards.sort((a, b) => a.position - b.position);
  }

  // Re-render affected columns
  const affectedColumnIds = new Set([card.column_id]);
  if (sourceColumnId) affectedColumnIds.add(sourceColumnId);

  for (const colId of affectedColumnIds) {
    const col = boardState.columns.find((c) => c.id === colId);
    if (col) renderColumn(col);
  }
}

function handleCardDeleted(cardId, columnId) {
  const column = boardState.columns.find((c) => c.id === columnId);
  if (!column) return;
  column.cards = column.cards.filter((c) => c.id !== cardId);
  renderColumn(column);
}

function handleColumnRenormalized(columnId, cards) {
  const column = boardState.columns.find((c) => c.id === columnId);
  if (!column) return;
  column.cards = cards;
  column.cards.sort((a, b) => a.position - b.position);
  renderColumn(column);
}

// ===== Drag and Drop =====
let draggedCardId = null;
let draggedSourceColumnId = null;
let dragGhost = null;

function handleDragStart(e, card, columnId) {
  draggedCardId = card.id;
  draggedSourceColumnId = columnId;

  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', card.id);

  // Mark the card as being dragged
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-card-id="${card.id}"]`);
    if (el) el.classList.add('dragging');
  });
}

function handleDragEnd(e) {
  // Remove dragging class
  const el = document.querySelector(`[data-card-id="${draggedCardId}"]`);
  if (el) el.classList.remove('dragging');

  // Remove all drop indicators and drag-over states
  document.querySelectorAll('.drop-indicator').forEach((ind) => ind.remove());
  document.querySelectorAll('.drag-over').forEach((zone) => zone.classList.remove('drag-over'));

  draggedCardId = null;
  draggedSourceColumnId = null;
}

function handleDragOver(e, columnId) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  const cardList = e.currentTarget;
  cardList.classList.add('drag-over');

  // Remove existing drop indicators in this list
  cardList.querySelectorAll('.drop-indicator').forEach((ind) => ind.remove());

  // Find the insertion point
  const cardEls = Array.from(cardList.querySelectorAll('.card:not(.dragging)'));
  const mouseY = e.clientY;

  let insertBefore = null;
  for (const cardEl of cardEls) {
    const rect = cardEl.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (mouseY < midY) {
      insertBefore = cardEl;
      break;
    }
  }

  // Create drop indicator
  const indicator = document.createElement('div');
  indicator.className = 'drop-indicator';

  if (insertBefore) {
    cardList.insertBefore(indicator, insertBefore);
  } else {
    cardList.appendChild(indicator);
  }
}

function handleDragLeave(e) {
  const cardList = e.currentTarget;
  // Only remove if we've actually left the card list
  if (!cardList.contains(e.relatedTarget)) {
    cardList.classList.remove('drag-over');
    cardList.querySelectorAll('.drop-indicator').forEach((ind) => ind.remove());
  }
}

function handleDrop(e, columnId) {
  e.preventDefault();

  const cardList = e.currentTarget;
  cardList.classList.remove('drag-over');
  cardList.querySelectorAll('.drop-indicator').forEach((ind) => ind.remove());

  if (!draggedCardId) return;

  const column = boardState.columns.find((c) => c.id === columnId);
  if (!column) return;

  // Determine where to insert
  const cardEls = Array.from(cardList.querySelectorAll('.card:not(.dragging)'));
  const mouseY = e.clientY;

  let insertBeforeCardId = null;
  for (const cardEl of cardEls) {
    const rect = cardEl.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (mouseY < midY) {
      insertBeforeCardId = cardEl.dataset.cardId;
      break;
    }
  }

  // Get the cards in the target column (excluding the dragged card)
  const targetCards = column.cards.filter((c) => c.id !== draggedCardId);

  let afterId = null;
  let beforeId = null;

  if (insertBeforeCardId) {
    const insertIdx = targetCards.findIndex((c) => c.id === insertBeforeCardId);
    beforeId = insertBeforeCardId;
    if (insertIdx > 0) {
      afterId = targetCards[insertIdx - 1].id;
    }
  } else {
    // Insert at end
    if (targetCards.length > 0) {
      afterId = targetCards[targetCards.length - 1].id;
    }
  }

  // Optimistic update
  applyOptimisticMove(draggedCardId, columnId, afterId, beforeId);

  // Send to server
  const cardId = draggedCardId;
  pendingMoves.set(cardId, true);

  moveCard(cardId, columnId, afterId, beforeId).catch((err) => {
    console.error('Move failed, refetching board:', err);
    pendingMoves.delete(cardId);
    // Refetch full state on error
    fetchBoard().then((data) => {
      boardState = data;
      renderBoard();
    });
  });
}

function applyOptimisticMove(cardId, targetColumnId, afterId, beforeId) {
  // Find and remove card from source
  let card = null;
  for (const col of boardState.columns) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) {
      card = col.cards.splice(idx, 1)[0];
      renderColumn(col);
      break;
    }
  }
  if (!card) return;

  // Insert into target column
  const targetColumn = boardState.columns.find((c) => c.id === targetColumnId);
  if (!targetColumn) return;

  card.column_id = targetColumnId;

  // Calculate optimistic position
  const targetCards = targetColumn.cards;
  if (afterId && beforeId) {
    const afterCard = targetCards.find((c) => c.id === afterId);
    const beforeCard = targetCards.find((c) => c.id === beforeId);
    if (afterCard && beforeCard) {
      card.position = (afterCard.position + beforeCard.position) / 2;
    } else {
      card.position = targetCards.length > 0 ? targetCards[targetCards.length - 1].position + 1000 : 1000;
    }
  } else if (afterId) {
    const afterCard = targetCards.find((c) => c.id === afterId);
    card.position = afterCard ? afterCard.position + 1000 : 1000;
  } else if (beforeId) {
    const beforeCard = targetCards.find((c) => c.id === beforeId);
    card.position = beforeCard ? beforeCard.position - 1000 : 1000;
  } else {
    card.position = targetCards.length > 0 ? targetCards[targetCards.length - 1].position + 1000 : 1000;
  }

  targetColumn.cards.push(card);
  targetColumn.cards.sort((a, b) => a.position - b.position);

  renderColumn(targetColumn);
}

// ===== Rendering =====
function renderBoard() {
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';
  boardEl.className = 'board';

  for (const column of boardState.columns) {
    const colEl = createColumnElement(column);
    boardEl.appendChild(colEl);
  }
}

function createColumnElement(column) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = column.id;

  // Header
  const header = document.createElement('div');
  header.className = 'column-header';
  header.innerHTML = `
    <h2>${escapeHtml(column.title)}</h2>
    <span class="card-count">${column.cards.length}</span>
  `;
  colEl.appendChild(header);

  // Card list
  const cardList = document.createElement('div');
  cardList.className = 'card-list';
  cardList.dataset.columnId = column.id;

  // Drag and drop events
  cardList.addEventListener('dragover', (e) => handleDragOver(e, column.id));
  cardList.addEventListener('dragleave', (e) => handleDragLeave(e));
  cardList.addEventListener('drop', (e) => handleDrop(e, column.id));

  for (const card of column.cards) {
    cardList.appendChild(createCardElement(card, column.id));
  }

  colEl.appendChild(cardList);

  // Add card form
  const form = document.createElement('div');
  form.className = 'add-card-form';
  form.innerHTML = `
    <textarea placeholder="Add a card…" rows="1"></textarea>
    <button class="add-card-btn">Add Card</button>
  `;

  const textarea = form.querySelector('textarea');
  const addBtn = form.querySelector('.add-card-btn');

  // Auto-resize textarea
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 100) + 'px';
  });

  // Submit on Enter (without shift)
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitCard();
    }
  });

  addBtn.addEventListener('click', submitCard);

  async function submitCard() {
    const text = textarea.value.trim();
    if (!text) return;

    addBtn.disabled = true;
    textarea.value = '';
    textarea.style.height = 'auto';

    try {
      await createCard(column.id, text);
    } catch (err) {
      console.error('Failed to create card:', err);
      textarea.value = text;
    } finally {
      addBtn.disabled = false;
    }
  }

  colEl.appendChild(form);

  return colEl;
}

function createCardElement(card, columnId) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  if (pendingMoves.has(card.id)) {
    cardEl.classList.add('optimistic');
  }
  cardEl.dataset.cardId = card.id;
  cardEl.draggable = true;

  const textEl = document.createElement('div');
  textEl.className = 'card-text';
  textEl.textContent = card.text;
  cardEl.appendChild(textEl);

  // Delete button
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'card-delete';
  deleteBtn.textContent = '✕';
  deleteBtn.title = 'Delete card';
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
  cardEl.addEventListener('dragstart', (e) => handleDragStart(e, card, columnId));
  cardEl.addEventListener('dragend', (e) => handleDragEnd(e));

  return cardEl;
}

function renderColumn(column) {
  const colEl = document.querySelector(`[data-column-id="${column.id}"].column`);
  if (!colEl) {
    // Column doesn't exist in DOM yet, re-render entire board
    renderBoard();
    return;
  }

  // Update card count
  const countEl = colEl.querySelector('.card-count');
  if (countEl) countEl.textContent = column.cards.length;

  // Re-render card list
  const cardList = colEl.querySelector('.card-list');
  const scrollTop = cardList.scrollTop;

  // Preserve event listeners by recreating children
  cardList.innerHTML = '';
  for (const card of column.cards) {
    cardList.appendChild(createCardElement(card, column.id));
  }

  cardList.scrollTop = scrollTop;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ===== Init =====
async function init() {
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '<div class="loading"><span>Loading board…</span></div>';

  try {
    const data = await fetchBoard();
    boardState = data;
    renderBoard();
    // Connect to SSE for real-time updates
    connectSSE();
  } catch (err) {
    console.error('Failed to initialize board:', err);
    boardEl.innerHTML = '<div class="loading"><span>Failed to load board. Make sure the server is running.</span></div>';
  }
}

init();
