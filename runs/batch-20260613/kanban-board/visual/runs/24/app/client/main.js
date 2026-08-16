// ---- State ----
let boardState = { columns: [] };
let dragState = null; // { cardId, sourceColumnId, cardEl }

const API_BASE = '/api';

// ---- DOM References ----
const boardEl = document.getElementById('board');
const statusEl = document.getElementById('connection-status');

// ---- API ----
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
  const res = await fetch(`${API_BASE}/cards/${cardId}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to delete card');
  return res.json();
}

// ---- Rendering ----
function renderBoard() {
  boardEl.innerHTML = '';
  for (const column of boardState.columns) {
    boardEl.appendChild(renderColumn(column));
  }
}

function renderColumn(column) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = column.id;

  // Header
  const headerEl = document.createElement('div');
  headerEl.className = 'column-header';
  headerEl.innerHTML = `
    <h2>${escapeHtml(column.title)}</h2>
    <span class="card-count">${column.cards.length}</span>
  `;
  colEl.appendChild(headerEl);

  // Card list
  const listEl = document.createElement('div');
  listEl.className = 'card-list';
  listEl.dataset.columnId = column.id;

  for (const card of column.cards) {
    listEl.appendChild(renderCard(card));
  }

  // Drag-and-drop events on the list
  listEl.addEventListener('dragover', handleDragOver);
  listEl.addEventListener('dragenter', handleDragEnter);
  listEl.addEventListener('dragleave', handleDragLeave);
  listEl.addEventListener('drop', handleDrop);

  colEl.appendChild(listEl);

  // Add card button / form
  const addSection = createAddCardSection(column.id);
  colEl.appendChild(addSection);

  return colEl;
}

function renderCard(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.dataset.cardId = card.id;
  cardEl.draggable = true;

  const created = card.created_at ? new Date(card.created_at).toLocaleDateString() : '';

  cardEl.innerHTML = `
    <div class="card-text">${escapeHtml(card.text)}</div>
    <div class="card-meta">
      <span>${created}</span>
      <button class="delete-btn" title="Delete card">✕</button>
    </div>
  `;

  // Drag events
  cardEl.addEventListener('dragstart', handleDragStart);
  cardEl.addEventListener('dragend', handleDragEnd);

  // Delete
  cardEl.querySelector('.delete-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    // Optimistic remove
    removeCardFromState(card.id);
    renderBoard();
    try {
      await deleteCard(card.id);
    } catch {
      // Refresh on failure
      const data = await fetchBoard();
      boardState = data;
      renderBoard();
    }
  });

  return cardEl;
}

function createAddCardSection(columnId) {
  const container = document.createElement('div');

  // Trigger button
  const trigger = document.createElement('button');
  trigger.className = 'add-card-trigger';
  trigger.innerHTML = '+ Add a card';
  trigger.addEventListener('click', () => {
    container.innerHTML = '';
    container.appendChild(createAddCardForm(columnId, container));
  });

  container.appendChild(trigger);
  return container;
}

function createAddCardForm(columnId, container) {
  const formEl = document.createElement('div');
  formEl.className = 'add-card-form';

  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Enter card text…';
  textarea.rows = 2;
  formEl.appendChild(textarea);

  const actions = document.createElement('div');
  actions.className = 'form-actions';

  const addBtn = document.createElement('button');
  addBtn.className = 'btn btn-primary';
  addBtn.textContent = 'Add';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-secondary';
  cancelBtn.textContent = 'Cancel';

  actions.appendChild(addBtn);
  actions.appendChild(cancelBtn);
  formEl.appendChild(actions);

  const submitForm = async () => {
    const text = textarea.value.trim();
    if (!text) return;

    textarea.disabled = true;
    addBtn.disabled = true;

    try {
      await createCard(columnId, text);
      // SSE will handle updating the board, but we also refetch for safety
      textarea.value = '';
      textarea.disabled = false;
      addBtn.disabled = false;
      textarea.focus();
    } catch {
      textarea.disabled = false;
      addBtn.disabled = false;
    }
  };

  addBtn.addEventListener('click', submitForm);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitForm();
    }
    if (e.key === 'Escape') {
      container.innerHTML = '';
      const trigger = document.createElement('button');
      trigger.className = 'add-card-trigger';
      trigger.innerHTML = '+ Add a card';
      trigger.addEventListener('click', () => {
        container.innerHTML = '';
        container.appendChild(createAddCardForm(columnId, container));
      });
      container.appendChild(trigger);
    }
  });

  cancelBtn.addEventListener('click', () => {
    container.innerHTML = '';
    const trigger = document.createElement('button');
    trigger.className = 'add-card-trigger';
    trigger.innerHTML = '+ Add a card';
    trigger.addEventListener('click', () => {
      container.innerHTML = '';
      container.appendChild(createAddCardForm(columnId, container));
    });
    container.appendChild(trigger);
  });

  setTimeout(() => textarea.focus(), 0);
  return formEl;
}

// ---- Drag and Drop ----
function handleDragStart(e) {
  const cardEl = e.target.closest('.card');
  if (!cardEl) return;

  const cardId = cardEl.dataset.cardId;
  const listEl = cardEl.closest('.card-list');
  const sourceColumnId = listEl.dataset.columnId;

  dragState = { cardId, sourceColumnId, cardEl };

  cardEl.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', cardId);
}

function handleDragEnd(e) {
  const cardEl = e.target.closest('.card');
  if (cardEl) cardEl.classList.remove('dragging');

  // Clean up any drop indicators
  document.querySelectorAll('.drop-indicator').forEach((el) => el.remove());
  document.querySelectorAll('.card-list.drag-over').forEach((el) => el.classList.remove('drag-over'));

  dragState = null;
}

function handleDragEnter(e) {
  e.preventDefault();
  const listEl = e.target.closest('.card-list');
  if (listEl) listEl.classList.add('drag-over');
}

function handleDragLeave(e) {
  const listEl = e.target.closest('.card-list');
  if (listEl && !listEl.contains(e.relatedTarget)) {
    listEl.classList.remove('drag-over');
    // Remove drop indicators when leaving
    listEl.querySelectorAll('.drop-indicator').forEach((el) => el.remove());
  }
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  const listEl = e.target.closest('.card-list');
  if (!listEl) return;

  // Remove existing drop indicators
  listEl.querySelectorAll('.drop-indicator').forEach((el) => el.remove());

  const cards = [...listEl.querySelectorAll('.card:not(.dragging)')];
  const insertInfo = getDropPosition(cards, e.clientY);

  // Add drop indicator
  const indicator = document.createElement('div');
  indicator.className = 'drop-indicator';

  if (insertInfo.beforeElement) {
    listEl.insertBefore(indicator, insertInfo.beforeElement);
  } else {
    listEl.appendChild(indicator);
  }
}

function handleDrop(e) {
  e.preventDefault();

  const listEl = e.target.closest('.card-list');
  if (!listEl || !dragState) return;

  listEl.classList.remove('drag-over');
  listEl.querySelectorAll('.drop-indicator').forEach((el) => el.remove());

  const targetColumnId = listEl.dataset.columnId;
  const cards = [...listEl.querySelectorAll('.card:not(.dragging)')];
  const insertInfo = getDropPosition(cards, e.clientY);

  // Determine afterId and beforeId
  let afterId = null;
  let beforeId = null;

  if (insertInfo.index === 0) {
    // Inserting at the top
    beforeId = cards.length > 0 ? cards[0].dataset.cardId : null;
  } else if (insertInfo.index >= cards.length) {
    // Inserting at the bottom
    afterId = cards.length > 0 ? cards[cards.length - 1].dataset.cardId : null;
  } else {
    afterId = cards[insertInfo.index - 1].dataset.cardId;
    beforeId = cards[insertInfo.index].dataset.cardId;
  }

  // Filter out the dragged card from afterId/beforeId
  if (afterId === dragState.cardId) afterId = null;
  if (beforeId === dragState.cardId) beforeId = null;

  // Optimistic update: move card in DOM immediately
  optimisticMove(dragState.cardId, dragState.sourceColumnId, targetColumnId, afterId, beforeId);

  // Send to server
  moveCard(dragState.cardId, targetColumnId, afterId, beforeId).catch(async () => {
    // On failure, refetch full state
    const data = await fetchBoard();
    boardState = data;
    renderBoard();
  });
}

function getDropPosition(cards, mouseY) {
  let index = cards.length; // Default: end
  let beforeElement = null;

  for (let i = 0; i < cards.length; i++) {
    const rect = cards[i].getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (mouseY < midY) {
      index = i;
      beforeElement = cards[i];
      break;
    }
  }

  return { index, beforeElement };
}

function optimisticMove(cardId, sourceColumnId, targetColumnId, afterId, beforeId) {
  // Find the card in state
  let card = null;

  for (const col of boardState.columns) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) {
      card = col.cards.splice(idx, 1)[0];
      break;
    }
  }

  if (!card) return;

  // Find target column
  const targetCol = boardState.columns.find((c) => c.id === targetColumnId);
  if (!targetCol) return;

  card.column_id = targetColumnId;

  // Insert at correct position
  if (beforeId) {
    const beforeIdx = targetCol.cards.findIndex((c) => c.id === beforeId);
    if (beforeIdx !== -1) {
      targetCol.cards.splice(beforeIdx, 0, card);
    } else {
      targetCol.cards.push(card);
    }
  } else if (afterId) {
    const afterIdx = targetCol.cards.findIndex((c) => c.id === afterId);
    if (afterIdx !== -1) {
      targetCol.cards.splice(afterIdx + 1, 0, card);
    } else {
      targetCol.cards.push(card);
    }
  } else {
    targetCol.cards.push(card);
  }

  renderBoard();
}

// ---- State Helpers ----
function removeCardFromState(cardId) {
  for (const col of boardState.columns) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      return;
    }
  }
}

function findCardInState(cardId) {
  for (const col of boardState.columns) {
    const card = col.cards.find((c) => c.id === cardId);
    if (card) return { card, column: col };
  }
  return null;
}

// ---- SSE ----
function connectSSE() {
  const evtSource = new EventSource(`${API_BASE}/stream`);

  evtSource.onopen = async () => {
    statusEl.textContent = 'Connected';
    statusEl.className = 'status connected';
    // Refetch full board on (re)connect to ensure convergence
    try {
      const data = await fetchBoard();
      boardState = data;
      renderBoard();
    } catch {
      // Will retry on next reconnect
    }
  };

  evtSource.onerror = () => {
    statusEl.textContent = 'Disconnected';
    statusEl.className = 'status disconnected';
    // EventSource auto-reconnects by default
  };

  evtSource.addEventListener('card:created', (e) => {
    const { card } = JSON.parse(e.data);
    handleCardCreated(card);
  });

  evtSource.addEventListener('card:moved', (e) => {
    const { card, sourceColumnId } = JSON.parse(e.data);
    handleCardMoved(card, sourceColumnId);
  });

  evtSource.addEventListener('card:deleted', (e) => {
    const { id } = JSON.parse(e.data);
    handleCardDeleted(id);
  });

  evtSource.addEventListener('column:renormalized', (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    handleColumnRenormalized(columnId, cards);
  });

  return evtSource;
}

function handleCardCreated(card) {
  // If we already have this card (e.g., from optimistic update), update it
  const existing = findCardInState(card.id);
  if (existing) {
    // Update with server data
    Object.assign(existing.card, card);
    // Possibly move to correct position
    reconcileCardPosition(card);
  } else {
    // Add to column
    const col = boardState.columns.find((c) => c.id === card.column_id);
    if (col) {
      col.cards.push(card);
      // Sort by position
      col.cards.sort((a, b) => a.position - b.position);
    }
  }
  renderBoard();
}

function handleCardMoved(card, sourceColumnId) {
  // Remove card from wherever it currently is
  removeCardFromState(card.id);

  // Add to correct column at correct position
  const col = boardState.columns.find((c) => c.id === card.column_id);
  if (col) {
    col.cards.push(card);
    // Sort by position to ensure correct ordering
    col.cards.sort((a, b) => a.position - b.position);
  }
  renderBoard();
}

function handleCardDeleted(cardId) {
  removeCardFromState(cardId);
  renderBoard();
}

function handleColumnRenormalized(columnId, cards) {
  const col = boardState.columns.find((c) => c.id === columnId);
  if (!col) return;

  // Update positions for all cards in this column
  // Build a map of card id to new data
  const cardMap = new Map(cards.map((c) => [c.id, c]));

  for (const card of col.cards) {
    const updated = cardMap.get(card.id);
    if (updated) {
      card.position = updated.position;
    }
  }

  col.cards.sort((a, b) => a.position - b.position);
  // Note: we don't re-render here because card:moved will also fire
}

function reconcileCardPosition(card) {
  // Ensure the card is in the correct column
  for (const col of boardState.columns) {
    if (col.id !== card.column_id) {
      const idx = col.cards.findIndex((c) => c.id === card.id);
      if (idx !== -1) {
        col.cards.splice(idx, 1);
      }
    }
  }

  const targetCol = boardState.columns.find((c) => c.id === card.column_id);
  if (targetCol) {
    const existingIdx = targetCol.cards.findIndex((c) => c.id === card.id);
    if (existingIdx === -1) {
      targetCol.cards.push(card);
    }
    targetCol.cards.sort((a, b) => a.position - b.position);
  }
}

// ---- Utilities ----
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ---- Init ----
async function init() {
  try {
    const data = await fetchBoard();
    boardState = data;
    renderBoard();
    connectSSE();
  } catch (err) {
    console.error('Failed to initialize board:', err);
    boardEl.innerHTML = '<p style="padding:24px;color:#ef5350;">Failed to load board. Is the server running?</p>';
  }
}

init();
