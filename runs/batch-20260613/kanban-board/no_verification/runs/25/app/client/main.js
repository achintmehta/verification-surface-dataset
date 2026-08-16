// ============================================================================
// Kanban Board - Vanilla JS Frontend
// ============================================================================

const API_BASE = '/api';

// ---- State ----
let boardState = []; // Array of { id, title, position, cards: [] }
let dragState = null; // { cardId, sourceColumnId, cardEl }

// ---- DOM refs ----
const boardEl = document.getElementById('board');
const statusEl = document.getElementById('connection-status');

// ============================================================================
// API calls
// ============================================================================

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
  const body = { columnId };
  if (afterId) body.afterId = afterId;
  if (beforeId) body.beforeId = beforeId;

  const res = await fetch(`${API_BASE}/cards/${cardId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Failed to move card');
  return res.json();
}

// ============================================================================
// Rendering
// ============================================================================

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
  headerEl.innerHTML = `
    <span>${escapeHtml(column.title)}</span>
    <span class="card-count">${column.cards.length}</span>
  `;
  colEl.appendChild(headerEl);

  // Card list
  const listEl = document.createElement('div');
  listEl.className = 'card-list';
  listEl.dataset.columnId = column.id;

  for (const card of column.cards) {
    listEl.appendChild(createCardEl(card));
  }

  // Drag-and-drop events on the list
  listEl.addEventListener('dragover', handleDragOver);
  listEl.addEventListener('dragleave', handleDragLeave);
  listEl.addEventListener('drop', handleDrop);

  colEl.appendChild(listEl);

  // Add card form
  const formEl = document.createElement('div');
  formEl.className = 'add-card-form';
  const inputEl = document.createElement('input');
  inputEl.type = 'text';
  inputEl.placeholder = 'Add a card…';
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && inputEl.value.trim()) {
      const text = inputEl.value.trim();
      inputEl.value = '';
      createCard(column.id, text).catch(console.error);
    }
  });
  formEl.appendChild(inputEl);
  colEl.appendChild(formEl);

  return colEl;
}

function createCardEl(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.dataset.cardId = card.id;
  cardEl.draggable = true;
  cardEl.textContent = card.text;

  cardEl.addEventListener('dragstart', handleDragStart);
  cardEl.addEventListener('dragend', handleDragEnd);

  return cardEl;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================================
// Drag & Drop
// ============================================================================

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
  clearDropIndicators();
  dragState = null;
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  const listEl = e.currentTarget;
  listEl.classList.add('drag-over');

  // Clear previous indicators
  clearDropIndicators();

  // Find the card we're hovering over
  const target = getDropTarget(listEl, e.clientY);
  if (target.card) {
    if (target.position === 'above') {
      target.card.classList.add('drop-target-above');
    } else {
      target.card.classList.add('drop-target-below');
    }
  }
}

function handleDragLeave(e) {
  const listEl = e.currentTarget;
  // Only remove if we're leaving the list (not entering a child)
  if (!listEl.contains(e.relatedTarget)) {
    listEl.classList.remove('drag-over');
    clearDropIndicators();
  }
}

function handleDrop(e) {
  e.preventDefault();
  if (!dragState) return;

  const listEl = e.currentTarget;
  listEl.classList.remove('drag-over');
  clearDropIndicators();

  const targetColumnId = listEl.dataset.columnId;
  const { cardId } = dragState;

  // Find drop position
  const target = getDropTarget(listEl, e.clientY);

  // Determine afterId and beforeId
  let afterId = null;
  let beforeId = null;

  const cardEls = Array.from(listEl.querySelectorAll('.card')).filter(
    (el) => el.dataset.cardId !== cardId
  );

  if (target.card && target.card.dataset.cardId !== cardId) {
    const targetIdx = cardEls.indexOf(target.card);
    if (target.position === 'above') {
      // Insert before the target card
      if (targetIdx > 0) {
        afterId = cardEls[targetIdx - 1].dataset.cardId;
      }
      beforeId = target.card.dataset.cardId;
    } else {
      // Insert after the target card
      afterId = target.card.dataset.cardId;
      if (targetIdx < cardEls.length - 1) {
        beforeId = cardEls[targetIdx + 1].dataset.cardId;
      }
    }
  } else {
    // Drop at the end
    if (cardEls.length > 0) {
      afterId = cardEls[cardEls.length - 1].dataset.cardId;
    }
  }

  // Optimistic update: move card in DOM immediately
  optimisticMove(cardId, targetColumnId, afterId, beforeId);

  // Send to server
  moveCard(cardId, targetColumnId, afterId, beforeId).catch((err) => {
    console.error('Move failed, will reconcile on next server event:', err);
  });

  dragState = null;
}

function getDropTarget(listEl, clientY) {
  const cardEls = Array.from(listEl.querySelectorAll('.card:not(.dragging)'));

  for (const cardEl of cardEls) {
    const rect = cardEl.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;

    if (clientY < midY) {
      return { card: cardEl, position: 'above' };
    }
  }

  // Below all cards or empty list
  if (cardEls.length > 0) {
    return { card: cardEls[cardEls.length - 1], position: 'below' };
  }

  return { card: null, position: 'end' };
}

function clearDropIndicators() {
  document.querySelectorAll('.drop-target-above, .drop-target-below').forEach((el) => {
    el.classList.remove('drop-target-above', 'drop-target-below');
  });
}

// ============================================================================
// Optimistic Updates & Reconciliation
// ============================================================================

function optimisticMove(cardId, targetColumnId, afterId, beforeId) {
  // Remove card from its current column in state
  let card = null;
  for (const col of boardState) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) {
      card = col.cards.splice(idx, 1)[0];
      break;
    }
  }
  if (!card) return;

  // Find target column
  const targetCol = boardState.find((c) => c.id === targetColumnId);
  if (!targetCol) return;

  // Update column_id
  card.column_id = targetColumnId;

  // Find insertion index
  let insertIdx = targetCol.cards.length; // default: end

  if (beforeId) {
    const beforeIdx = targetCol.cards.findIndex((c) => c.id === beforeId);
    if (beforeIdx !== -1) {
      insertIdx = beforeIdx;
    }
  } else if (afterId) {
    const afterIdx = targetCol.cards.findIndex((c) => c.id === afterId);
    if (afterIdx !== -1) {
      insertIdx = afterIdx + 1;
    }
  }

  targetCol.cards.splice(insertIdx, 0, card);

  // Re-render
  renderBoard();
}

function reconcileCard(card, sourceColumnId) {
  // Remove card from any column it's currently in
  for (const col of boardState) {
    const idx = col.cards.findIndex((c) => c.id === card.id);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
    }
  }

  // Add to the correct column at the correct position
  const targetCol = boardState.find((c) => c.id === card.column_id);
  if (!targetCol) return;

  // Insert maintaining position order
  card.position = parseFloat(card.position);
  let inserted = false;
  for (let i = 0; i < targetCol.cards.length; i++) {
    if (card.position < parseFloat(targetCol.cards[i].position)) {
      targetCol.cards.splice(i, 0, card);
      inserted = true;
      break;
    }
  }
  if (!inserted) {
    targetCol.cards.push(card);
  }

  renderBoard();
}

function reconcileColumn(columnId, cards) {
  const col = boardState.find((c) => c.id === columnId);
  if (!col) return;

  // Remove any cards from other columns that belong here
  for (const card of cards) {
    for (const otherCol of boardState) {
      if (otherCol.id !== columnId) {
        const idx = otherCol.cards.findIndex((c) => c.id === card.id);
        if (idx !== -1) {
          otherCol.cards.splice(idx, 1);
        }
      }
    }
  }

  // Sort by position
  col.cards = cards.map((c) => ({
    ...c,
    position: parseFloat(c.position),
  }));
  col.cards.sort((a, b) => a.position - b.position);

  renderBoard();
}

// ============================================================================
// Server-Sent Events
// ============================================================================

function connectSSE() {
  const eventSource = new EventSource(`${API_BASE}/stream`);
  let wasConnected = false;

  eventSource.onopen = async () => {
    statusEl.textContent = 'Connected';
    statusEl.className = 'status connected';

    // If reconnecting, re-fetch full board to catch missed events
    if (wasConnected) {
      try {
        boardState = await fetchBoard();
        for (const col of boardState) {
          col.cards.sort((a, b) => parseFloat(a.position) - parseFloat(b.position));
        }
        renderBoard();
      } catch (err) {
        console.error('Failed to refresh board on reconnect:', err);
      }
    }
    wasConnected = true;
  };

  eventSource.onerror = () => {
    statusEl.textContent = 'Disconnected';
    statusEl.className = 'status disconnected';
  };

  eventSource.addEventListener('card:created', (e) => {
    const { card } = JSON.parse(e.data);

    // Check if card already exists (our own optimistic creation)
    for (const col of boardState) {
      if (col.cards.some((c) => c.id === card.id)) {
        // Already exists, just reconcile position
        reconcileCard(card);
        return;
      }
    }

    // New card from another client
    const targetCol = boardState.find((c) => c.id === card.column_id);
    if (!targetCol) return;

    card.position = parseFloat(card.position);
    targetCol.cards.push(card);
    targetCol.cards.sort((a, b) => a.position - b.position);

    renderBoard();
  });

  eventSource.addEventListener('card:moved', (e) => {
    const { card, sourceColumnId } = JSON.parse(e.data);
    reconcileCard(card, sourceColumnId);
  });

  eventSource.addEventListener('card:deleted', (e) => {
    const { id } = JSON.parse(e.data);
    for (const col of boardState) {
      const idx = col.cards.findIndex((c) => c.id === id);
      if (idx !== -1) {
        col.cards.splice(idx, 1);
        break;
      }
    }
    renderBoard();
  });

  eventSource.addEventListener('column:renormalized', (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    reconcileColumn(columnId, cards);
  });

  return eventSource;
}

// ============================================================================
// Init
// ============================================================================

async function init() {
  try {
    boardState = await fetchBoard();
    // Ensure cards are sorted by position
    for (const col of boardState) {
      col.cards.sort((a, b) => parseFloat(a.position) - parseFloat(b.position));
    }
    renderBoard();
    connectSSE();
  } catch (err) {
    console.error('Failed to initialize:', err);
    boardEl.innerHTML = '<p style="padding:24px;color:#fc8181;">Failed to load board. Is the server running?</p>';
  }
}

init();
