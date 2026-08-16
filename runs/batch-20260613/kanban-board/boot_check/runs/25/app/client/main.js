const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? `http://localhost:3000`
  : '';

// ─── State ──────────────────────────────────────────────────────
let boardState = []; // array of { id, title, position, cards: [] }

// ─── DOM References ─────────────────────────────────────────────
const boardEl = document.getElementById('board');
const statusEl = document.getElementById('connection-status');

// ─── Drag & Drop State ──────────────────────────────────────────
let draggedCardId = null;
let draggedCardEl = null;
let currentDropTarget = null; // { columnId, afterId, beforeId }

// ─── API Helpers ────────────────────────────────────────────────
async function fetchBoard() {
  const res = await fetch(`${API_BASE}/api/board`);
  return res.json();
}

async function createCard(columnId, text) {
  const res = await fetch(`${API_BASE}/api/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text }),
  });
  return res.json();
}

async function moveCard(cardId, columnId, afterId, beforeId) {
  const res = await fetch(`${API_BASE}/api/cards/${cardId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, afterId: afterId || null, beforeId: beforeId || null }),
  });
  return res.json();
}

async function deleteCard(cardId) {
  await fetch(`${API_BASE}/api/cards/${cardId}`, { method: 'DELETE' });
}

// ─── Rendering ──────────────────────────────────────────────────
function render() {
  boardEl.innerHTML = '';
  for (const column of boardState) {
    boardEl.appendChild(renderColumn(column));
  }
}

function renderColumn(column) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = column.id;

  const headerEl = document.createElement('div');
  headerEl.className = 'column-header';
  headerEl.textContent = `${column.title} (${column.cards.length})`;
  colEl.appendChild(headerEl);

  const listEl = document.createElement('div');
  listEl.className = 'card-list';
  listEl.dataset.columnId = column.id;

  // Drag-over events for the list area (for empty columns or dropping at end)
  listEl.addEventListener('dragover', handleListDragOver);
  listEl.addEventListener('dragleave', handleListDragLeave);
  listEl.addEventListener('drop', handleDrop);

  for (const card of column.cards) {
    listEl.appendChild(renderCard(card));
  }
  colEl.appendChild(listEl);

  // Add card form
  colEl.appendChild(renderAddCardForm(column.id));

  return colEl;
}

function renderCard(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.dataset.cardId = card.id;
  cardEl.dataset.columnId = card.column_id;
  cardEl.draggable = true;
  cardEl.textContent = card.text;

  // Delete button
  const delBtn = document.createElement('button');
  delBtn.className = 'card-delete';
  delBtn.textContent = '✕';
  delBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    // Optimistically remove
    removeCardFromState(card.id);
    render();
    await deleteCard(card.id);
  });
  cardEl.appendChild(delBtn);

  // Drag events
  cardEl.addEventListener('dragstart', (e) => {
    draggedCardId = card.id;
    draggedCardEl = cardEl;
    cardEl.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.id);
  });

  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('dragging');
    clearAllDropIndicators();
    draggedCardId = null;
    draggedCardEl = null;
    currentDropTarget = null;
  });

  cardEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!draggedCardId || draggedCardId === card.id) return;

    e.dataTransfer.dropEffect = 'move';

    const rect = cardEl.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const isAbove = e.clientY < midY;

    clearAllDropIndicators();

    if (isAbove) {
      cardEl.classList.add('drag-over-top');
    } else {
      cardEl.classList.add('drag-over-bottom');
    }

    const columnId = cardEl.closest('.card-list').dataset.columnId;
    const column = boardState.find(c => c.id === columnId);
    if (!column) return;

    const cardIndex = column.cards.findIndex(c => c.id === card.id);

    if (isAbove) {
      // Insert before this card
      currentDropTarget = {
        columnId,
        afterId: cardIndex > 0 ? column.cards[cardIndex - 1].id : null,
        beforeId: card.id,
      };
    } else {
      // Insert after this card
      currentDropTarget = {
        columnId,
        afterId: card.id,
        beforeId: cardIndex < column.cards.length - 1 ? column.cards[cardIndex + 1].id : null,
      };
    }
  });

  cardEl.addEventListener('dragleave', () => {
    cardEl.classList.remove('drag-over-top', 'drag-over-bottom');
  });

  cardEl.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handleDropAction();
  });

  return cardEl;
}

function renderAddCardForm(columnId) {
  const formContainer = document.createElement('div');
  formContainer.className = 'add-card-form';

  const addBtn = document.createElement('button');
  addBtn.className = 'add-card-btn';
  addBtn.textContent = '+ Add a card';

  const inputContainer = document.createElement('div');
  inputContainer.style.display = 'none';

  const textarea = document.createElement('textarea');
  textarea.className = 'add-card-input';
  textarea.placeholder = 'Enter a title for this card...';

  const actions = document.createElement('div');
  actions.className = 'add-card-actions';

  const submitBtn = document.createElement('button');
  submitBtn.className = 'add-card-submit';
  submitBtn.textContent = 'Add Card';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'add-card-cancel';
  cancelBtn.textContent = '✕';

  actions.appendChild(submitBtn);
  actions.appendChild(cancelBtn);
  inputContainer.appendChild(textarea);
  inputContainer.appendChild(actions);

  addBtn.addEventListener('click', () => {
    addBtn.style.display = 'none';
    inputContainer.style.display = 'block';
    textarea.focus();
  });

  cancelBtn.addEventListener('click', () => {
    addBtn.style.display = 'block';
    inputContainer.style.display = 'none';
    textarea.value = '';
  });

  async function submitCard() {
    const text = textarea.value.trim();
    if (!text) return;

    textarea.value = '';
    textarea.focus();

    // Optimistic: we'll get the server response via SSE
    await createCard(columnId, text);
  }

  submitBtn.addEventListener('click', submitCard);

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitCard();
    }
    if (e.key === 'Escape') {
      addBtn.style.display = 'block';
      inputContainer.style.display = 'none';
      textarea.value = '';
    }
  });

  formContainer.appendChild(addBtn);
  formContainer.appendChild(inputContainer);

  return formContainer;
}

// ─── Drag & Drop Helpers ────────────────────────────────────────
function handleListDragOver(e) {
  e.preventDefault();
  if (!draggedCardId) return;

  e.dataTransfer.dropEffect = 'move';

  const listEl = e.currentTarget;
  const columnId = listEl.dataset.columnId;
  const column = boardState.find(c => c.id === columnId);
  if (!column) return;

  // Only show empty-column indicator if there are no other cards (or only the dragged card)
  const otherCards = column.cards.filter(c => c.id !== draggedCardId);
  if (otherCards.length === 0) {
    listEl.classList.add('drag-over-empty');
    currentDropTarget = { columnId, afterId: null, beforeId: null };
  }
}

function handleListDragLeave(e) {
  e.currentTarget.classList.remove('drag-over-empty');
}

function handleDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over-empty');
  handleDropAction();
}

function handleDropAction() {
  if (!draggedCardId || !currentDropTarget) return;

  const { columnId, afterId, beforeId } = currentDropTarget;

  // Filter out self-references
  const safeAfterId = afterId === draggedCardId ? null : afterId;
  const safeBeforeId = beforeId === draggedCardId ? null : beforeId;

  // Check if the card is being dropped in the same position
  const srcColumn = boardState.find(c => c.cards.some(card => card.id === draggedCardId));
  if (srcColumn) {
    const srcIndex = srcColumn.cards.findIndex(c => c.id === draggedCardId);
    if (srcColumn.id === columnId) {
      const destIndex = getInsertIndex(columnId, safeAfterId, safeBeforeId, draggedCardId);
      // Adjust for the removal of the dragged card
      const adjustedSrcIndex = srcIndex;
      const cards = srcColumn.cards.filter(c => c.id !== draggedCardId);
      const adjustedDestIndex = Math.min(destIndex, cards.length);
      if (adjustedSrcIndex === adjustedDestIndex || 
          (safeAfterId === null && safeBeforeId === null && srcIndex === srcColumn.cards.length - 1 && srcColumn.cards.length === 1)) {
        // If same column, same position, do nothing
        if (adjustedSrcIndex === adjustedDestIndex) {
          clearAllDropIndicators();
          return;
        }
      }
    }
  }

  // Optimistic UI update
  optimisticMove(draggedCardId, columnId, safeAfterId, safeBeforeId);
  render();

  // Send to server
  moveCard(draggedCardId, columnId, safeAfterId, safeBeforeId).catch(err => {
    console.error('Move failed:', err);
    // On error, re-fetch canonical state
    fetchBoard().then(data => {
      boardState = data;
      render();
    });
  });

  clearAllDropIndicators();
  draggedCardId = null;
  draggedCardEl = null;
  currentDropTarget = null;
}

function getInsertIndex(columnId, afterId, beforeId, excludeId) {
  const column = boardState.find(c => c.id === columnId);
  if (!column) return 0;

  const cards = column.cards.filter(c => c.id !== excludeId);

  if (afterId) {
    const afterIdx = cards.findIndex(c => c.id === afterId);
    return afterIdx >= 0 ? afterIdx + 1 : cards.length;
  }
  if (beforeId) {
    const beforeIdx = cards.findIndex(c => c.id === beforeId);
    return beforeIdx >= 0 ? beforeIdx : 0;
  }
  return cards.length;
}

function optimisticMove(cardId, targetColumnId, afterId, beforeId) {
  // Find and remove card from current column
  let card = null;
  for (const col of boardState) {
    const idx = col.cards.findIndex(c => c.id === cardId);
    if (idx >= 0) {
      card = { ...col.cards[idx] };
      col.cards.splice(idx, 1);
      break;
    }
  }
  if (!card) return;

  card.column_id = targetColumnId;

  // Insert into target column
  const targetCol = boardState.find(c => c.id === targetColumnId);
  if (!targetCol) return;

  const insertIdx = getInsertIndex(targetColumnId, afterId, beforeId, cardId);
  targetCol.cards.splice(insertIdx, 0, card);
}

function clearAllDropIndicators() {
  document.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => {
    el.classList.remove('drag-over-top', 'drag-over-bottom');
  });
  document.querySelectorAll('.drag-over-empty').forEach(el => {
    el.classList.remove('drag-over-empty');
  });
}

function removeCardFromState(cardId) {
  for (const col of boardState) {
    const idx = col.cards.findIndex(c => c.id === cardId);
    if (idx >= 0) {
      col.cards.splice(idx, 1);
      break;
    }
  }
}

// ─── SSE Connection ─────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource(`${API_BASE}/api/stream`);

  es.onopen = () => {
    statusEl.textContent = 'Connected';
    statusEl.className = 'status connected';
  };

  es.onerror = () => {
    statusEl.textContent = 'Disconnected';
    statusEl.className = 'status disconnected';
  };

  es.addEventListener('card-created', (e) => {
    const { card } = JSON.parse(e.data);
    // Add card to the appropriate column in state, maintaining position order
    const column = boardState.find(c => c.id === card.column_id);
    if (!column) return;

    // Check if card already exists (from optimistic update)
    const existingIdx = column.cards.findIndex(c => c.id === card.id);
    if (existingIdx >= 0) {
      // Update with canonical data
      column.cards[existingIdx] = card;
    } else {
      column.cards.push(card);
    }

    // Sort by position
    column.cards.sort((a, b) => a.position - b.position);
    render();
  });

  es.addEventListener('card-moved', (e) => {
    const { card } = JSON.parse(e.data);

    // Remove card from all columns (it should only be in one, but be safe)
    for (const col of boardState) {
      col.cards = col.cards.filter(c => c.id !== card.id);
    }

    // Add to target column
    const targetCol = boardState.find(c => c.id === card.column_id);
    if (targetCol) {
      targetCol.cards.push(card);
      targetCol.cards.sort((a, b) => a.position - b.position);
    }

    render();
  });

  es.addEventListener('card-deleted', (e) => {
    const { cardId } = JSON.parse(e.data);
    removeCardFromState(cardId);
    render();
  });

  es.addEventListener('column-renormalized', (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    const column = boardState.find(c => c.id === columnId);
    if (!column) return;
    column.cards = cards;
    render();
  });

  return es;
}

// ─── Initialize ─────────────────────────────────────────────────
async function init() {
  try {
    boardState = await fetchBoard();
    render();
    connectSSE();
  } catch (err) {
    console.error('Failed to load board:', err);
    boardEl.innerHTML = '<p style="color:white;padding:20px;">Failed to load board. Is the server running?</p>';
  }
}

init();
