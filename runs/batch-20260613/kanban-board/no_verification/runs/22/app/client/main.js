// ─── State ────────────────────────────────────────────────────
let boardState = { columns: [] };  // { columns: [{ id, title, position, cards: [{ id, column_id, text, position }] }] }
let dragState = null; // { cardId, sourceColumnId, cardEl }

const API = '/api';

// ─── API helpers ──────────────────────────────────────────────
async function fetchBoard() {
  const res = await fetch(`${API}/board`);
  return res.json();
}

async function createCard(columnId, text) {
  const res = await fetch(`${API}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text }),
  });
  return res.json();
}

async function moveCard(cardId, columnId, afterId, beforeId) {
  const res = await fetch(`${API}/cards/${cardId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, afterId: afterId || null, beforeId: beforeId || null }),
  });
  return res.json();
}

async function deleteCard(cardId) {
  await fetch(`${API}/cards/${cardId}`, { method: 'DELETE' });
}

// ─── Rendering ────────────────────────────────────────────────
const boardEl = document.getElementById('board');

function renderBoard() {
  boardEl.innerHTML = '';
  for (const col of boardState.columns) {
    boardEl.appendChild(createColumnEl(col));
  }
}

function createColumnEl(col) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = col.id;

  const header = document.createElement('div');
  header.className = 'column-header';
  header.textContent = `${col.title} (${col.cards.length})`;
  colEl.appendChild(header);

  const cardList = document.createElement('div');
  cardList.className = 'card-list';
  cardList.dataset.columnId = col.id;

  for (const card of col.cards) {
    cardList.appendChild(createCardEl(card));
  }

  // Drop zone event listeners
  cardList.addEventListener('dragover', handleDragOver);
  cardList.addEventListener('dragleave', handleDragLeave);
  cardList.addEventListener('drop', handleDrop);

  colEl.appendChild(cardList);

  // Add card button/form
  colEl.appendChild(createAddCardUI(col.id));

  return colEl;
}

function createCardEl(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.cardId = card.id;
  el.dataset.columnId = card.column_id;
  el.draggable = true;
  el.textContent = card.text;

  // Delete button
  const delBtn = document.createElement('button');
  delBtn.className = 'delete-btn';
  delBtn.textContent = '×';
  delBtn.title = 'Delete card';
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    el.remove();
    deleteCard(card.id);
    // Remove from state
    for (const col of boardState.columns) {
      const idx = col.cards.findIndex(c => c.id === card.id);
      if (idx !== -1) {
        col.cards.splice(idx, 1);
        updateColumnCount(col.id);
        break;
      }
    }
  });
  el.appendChild(delBtn);

  // Drag events
  el.addEventListener('dragstart', (e) => {
    dragState = { cardId: card.id, sourceColumnId: card.column_id, cardEl: el };
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.id);
  });

  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    clearAllIndicators();
    dragState = null;
  });

  return el;
}

function createAddCardUI(columnId) {
  const wrapper = document.createElement('div');
  wrapper.className = 'add-card-form';

  const btn = document.createElement('button');
  btn.className = 'add-card-btn';
  btn.textContent = '+ Add a card';

  const form = document.createElement('div');
  form.style.display = 'none';

  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Enter card text...';

  const actions = document.createElement('div');
  actions.className = 'form-actions';

  const submitBtn = document.createElement('button');
  submitBtn.className = 'btn-primary';
  submitBtn.textContent = 'Add Card';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-cancel';
  cancelBtn.textContent = '×';

  actions.appendChild(submitBtn);
  actions.appendChild(cancelBtn);
  form.appendChild(textarea);
  form.appendChild(actions);

  btn.addEventListener('click', () => {
    btn.style.display = 'none';
    form.style.display = 'block';
    textarea.focus();
  });

  cancelBtn.addEventListener('click', () => {
    form.style.display = 'none';
    btn.style.display = 'block';
    textarea.value = '';
  });

  const doSubmit = async () => {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = '';
    textarea.focus();
    await createCard(columnId, text);
    // Card will appear via SSE broadcast
  };

  submitBtn.addEventListener('click', doSubmit);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSubmit();
    }
    if (e.key === 'Escape') {
      form.style.display = 'none';
      btn.style.display = 'block';
      textarea.value = '';
    }
  });

  wrapper.appendChild(btn);
  wrapper.appendChild(form);
  return wrapper;
}

function updateColumnCount(columnId) {
  const colEl = boardEl.querySelector(`.column[data-column-id="${columnId}"]`);
  if (!colEl) return;
  const col = boardState.columns.find(c => c.id === columnId);
  if (!col) return;
  const header = colEl.querySelector('.column-header');
  if (header) header.textContent = `${col.title} (${col.cards.length})`;
}

// ─── Drag and Drop ────────────────────────────────────────────
function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  const cardList = e.currentTarget;
  cardList.classList.add('drag-over');

  // Find insertion point
  clearAllIndicators();
  const afterElement = getDragAfterElement(cardList, e.clientY);
  const indicator = document.createElement('div');
  indicator.className = 'drop-indicator';

  if (afterElement) {
    cardList.insertBefore(indicator, afterElement);
  } else {
    cardList.appendChild(indicator);
  }
}

function handleDragLeave(e) {
  const cardList = e.currentTarget;
  // Only remove if we're actually leaving this element
  if (!cardList.contains(e.relatedTarget)) {
    cardList.classList.remove('drag-over');
    clearIndicatorsIn(cardList);
  }
}

function handleDrop(e) {
  e.preventDefault();
  const cardList = e.currentTarget;
  cardList.classList.remove('drag-over');
  clearAllIndicators();

  if (!dragState) return;

  const targetColumnId = cardList.dataset.columnId;
  const { cardId, cardEl } = dragState;

  // Determine where we're dropping
  const afterElement = getDragAfterElement(cardList, e.clientY);

  // Optimistic DOM update: move the card element
  if (afterElement) {
    cardList.insertBefore(cardEl, afterElement);
  } else {
    cardList.appendChild(cardEl);
  }
  cardEl.classList.remove('dragging');

  // Build afterId / beforeId from the DOM order
  const cardEls = Array.from(cardList.querySelectorAll('.card'));
  const myIndex = cardEls.indexOf(cardEl);
  const afterId = myIndex > 0 ? cardEls[myIndex - 1].dataset.cardId : null;
  const beforeId = myIndex < cardEls.length - 1 ? cardEls[myIndex + 1].dataset.cardId : null;

  // Update state optimistically
  updateStateForMove(cardId, targetColumnId, afterId, beforeId);

  // Update column counts
  updateColumnCount(targetColumnId);
  if (dragState.sourceColumnId !== targetColumnId) {
    updateColumnCount(dragState.sourceColumnId);
  }

  // Send to server
  moveCard(cardId, targetColumnId, afterId, beforeId);
}

function getDragAfterElement(container, y) {
  const cards = Array.from(container.querySelectorAll('.card:not(.dragging)'));

  let closest = null;
  let closestOffset = Number.POSITIVE_INFINITY;

  for (const card of cards) {
    const box = card.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && Math.abs(offset) < closestOffset) {
      closestOffset = Math.abs(offset);
      closest = card;
    }
  }

  return closest;
}

function clearAllIndicators() {
  document.querySelectorAll('.drop-indicator').forEach(el => el.remove());
}

function clearIndicatorsIn(container) {
  container.querySelectorAll('.drop-indicator').forEach(el => el.remove());
}

// ─── State management ─────────────────────────────────────────
function updateStateForMove(cardId, targetColumnId, afterId, beforeId) {
  // Remove card from current column
  let card = null;
  for (const col of boardState.columns) {
    const idx = col.cards.findIndex(c => c.id === cardId);
    if (idx !== -1) {
      card = col.cards.splice(idx, 1)[0];
      break;
    }
  }
  if (!card) return;

  card.column_id = targetColumnId;

  // Find target column
  const targetCol = boardState.columns.find(c => c.id === targetColumnId);
  if (!targetCol) return;

  // Insert at the right position
  if (afterId) {
    const afterIdx = targetCol.cards.findIndex(c => c.id === afterId);
    if (afterIdx !== -1) {
      targetCol.cards.splice(afterIdx + 1, 0, card);
    } else {
      targetCol.cards.push(card);
    }
  } else if (beforeId) {
    const beforeIdx = targetCol.cards.findIndex(c => c.id === beforeId);
    if (beforeIdx !== -1) {
      targetCol.cards.splice(beforeIdx, 0, card);
    } else {
      targetCol.cards.unshift(card);
    }
  } else {
    targetCol.cards.push(card);
  }
}

function applyCardCreated(card) {
  const col = boardState.columns.find(c => c.id === card.column_id);
  if (!col) return;

  // Don't duplicate
  if (col.cards.some(c => c.id === card.id)) return;

  // Insert in correct position order
  let inserted = false;
  for (let i = 0; i < col.cards.length; i++) {
    if (card.position < col.cards[i].position) {
      col.cards.splice(i, 0, card);
      inserted = true;
      break;
    }
  }
  if (!inserted) col.cards.push(card);

  // Re-render this column's card list
  rerenderColumn(col.id);
}

function applyCardMoved(card) {
  // Track which columns need re-rendering
  const affectedColumns = new Set();

  // Remove card from any column it might be in
  for (const col of boardState.columns) {
    const idx = col.cards.findIndex(c => c.id === card.id);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      affectedColumns.add(col.id);
      break;
    }
  }

  // Insert into target column at correct position
  const targetCol = boardState.columns.find(c => c.id === card.column_id);
  if (!targetCol) return;

  affectedColumns.add(targetCol.id);

  let inserted = false;
  for (let i = 0; i < targetCol.cards.length; i++) {
    if (card.position < targetCol.cards[i].position) {
      targetCol.cards.splice(i, 0, card);
      inserted = true;
      break;
    }
  }
  if (!inserted) targetCol.cards.push(card);

  // Re-render all affected columns to reconcile
  for (const colId of affectedColumns) {
    rerenderColumn(colId);
  }
}

function applyColumnRenormalized(columnId, cards) {
  const col = boardState.columns.find(c => c.id === columnId);
  if (!col) return;

  // Replace all cards in this column with the server's canonical list
  // But first, remove these cards from any other column (in case of cross-column move)
  const cardIds = new Set(cards.map(c => c.id));
  for (const c of boardState.columns) {
    c.cards = c.cards.filter(card => !cardIds.has(card.id) || c.id === columnId);
  }

  col.cards = cards;
  renderBoard();
}

function applyCardDeleted(cardId, columnId) {
  for (const col of boardState.columns) {
    const idx = col.cards.findIndex(c => c.id === cardId);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      rerenderColumn(col.id);
      break;
    }
  }
}

function rerenderColumn(columnId) {
  const col = boardState.columns.find(c => c.id === columnId);
  if (!col) return;

  const colEl = boardEl.querySelector(`.column[data-column-id="${columnId}"]`);
  if (!colEl) {
    renderBoard();
    return;
  }

  // Update header
  const header = colEl.querySelector('.column-header');
  if (header) header.textContent = `${col.title} (${col.cards.length})`;

  // Replace card list element to ensure clean event listeners
  const oldCardList = colEl.querySelector('.card-list');
  if (!oldCardList) return;

  const cardList = document.createElement('div');
  cardList.className = 'card-list';
  cardList.dataset.columnId = col.id;

  for (const card of col.cards) {
    cardList.appendChild(createCardEl(card));
  }

  cardList.addEventListener('dragover', handleDragOver);
  cardList.addEventListener('dragleave', handleDragLeave);
  cardList.addEventListener('drop', handleDrop);

  colEl.replaceChild(cardList, oldCardList);
}

// ─── SSE Connection ───────────────────────────────────────────
function connectSSE() {
  const statusEl = document.getElementById('connection-status');
  const es = new EventSource(`${API}/stream`);

  es.onopen = () => {
    statusEl.textContent = 'Connected';
    statusEl.className = 'status connected';
  };

  es.onerror = () => {
    statusEl.textContent = 'Disconnected';
    statusEl.className = 'status disconnected';
  };

  es.addEventListener('card:created', (e) => {
    const { card } = JSON.parse(e.data);
    applyCardCreated(card);
  });

  es.addEventListener('card:moved', (e) => {
    const { card } = JSON.parse(e.data);
    applyCardMoved(card);
  });

  es.addEventListener('column:renormalized', (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    applyColumnRenormalized(columnId, cards);
  });

  es.addEventListener('card:deleted', (e) => {
    const { cardId, columnId } = JSON.parse(e.data);
    applyCardDeleted(cardId, columnId);
  });

  return es;
}

// ─── Init ─────────────────────────────────────────────────────
async function init() {
  try {
    const data = await fetchBoard();
    boardState = data;
    renderBoard();
    connectSSE();
  } catch (err) {
    console.error('Failed to initialize board:', err);
    boardEl.innerHTML = '<p style="color:white;padding:20px;">Failed to load board. Is the server running?</p>';
  }
}

init();
