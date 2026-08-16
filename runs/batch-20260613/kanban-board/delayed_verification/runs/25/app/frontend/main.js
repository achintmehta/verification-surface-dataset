// ── State ────────────────────────────────────────────────────────────────────

let boardState = []; // Array of { id, title, position, cards: [{ id, column_id, text, position, created_at }] }
let draggedCardId = null;
let draggedCardElement = null;
let dropIndicator = null;

const boardEl = document.getElementById('board');

// ── API ──────────────────────────────────────────────────────────────────────

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
    body: JSON.stringify({ columnId, afterId, beforeId }),
  });
  if (!res.ok) throw new Error('Failed to move card');
  return res.json();
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderBoard() {
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
  headerEl.textContent = column.title;
  colEl.appendChild(headerEl);

  const listEl = document.createElement('div');
  listEl.className = 'card-list';
  listEl.dataset.columnId = column.id;

  for (const card of column.cards) {
    listEl.appendChild(renderCard(card));
  }

  // Drag-and-drop events on the card list
  listEl.addEventListener('dragover', handleDragOver);
  listEl.addEventListener('dragleave', handleDragLeave);
  listEl.addEventListener('drop', handleDrop);

  colEl.appendChild(listEl);

  // Add card form
  colEl.appendChild(renderAddCardForm(column.id));

  return colEl;
}

function renderCard(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.textContent = card.text;
  cardEl.draggable = true;
  cardEl.dataset.cardId = card.id;
  cardEl.dataset.columnId = card.column_id;
  cardEl.dataset.position = card.position;

  cardEl.addEventListener('dragstart', handleDragStart);
  cardEl.addEventListener('dragend', handleDragEnd);

  return cardEl;
}

function renderAddCardForm(columnId) {
  const formEl = document.createElement('div');
  formEl.className = 'add-card-form';

  const btn = document.createElement('button');
  btn.className = 'add-card-btn';
  btn.textContent = '+ Add a card';
  btn.addEventListener('click', () => showAddCardInput(formEl, columnId));

  formEl.appendChild(btn);
  return formEl;
}

function showAddCardInput(formEl, columnId) {
  formEl.innerHTML = '';

  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Enter a title for this card…';
  formEl.appendChild(textarea);

  const actions = document.createElement('div');
  actions.className = 'add-card-actions';

  const submitBtn = document.createElement('button');
  submitBtn.className = 'add-card-submit';
  submitBtn.textContent = 'Add Card';
  submitBtn.addEventListener('click', async () => {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = '';
    try {
      await createCard(columnId, text);
      // Card will appear via SSE broadcast
    } catch (err) {
      console.error('Failed to create card:', err);
    }
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'add-card-cancel';
  cancelBtn.textContent = '✕';
  cancelBtn.addEventListener('click', () => {
    formEl.innerHTML = '';
    const btn = document.createElement('button');
    btn.className = 'add-card-btn';
    btn.textContent = '+ Add a card';
    btn.addEventListener('click', () => showAddCardInput(formEl, columnId));
    formEl.appendChild(btn);
  });

  actions.appendChild(submitBtn);
  actions.appendChild(cancelBtn);
  formEl.appendChild(actions);

  textarea.focus();

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitBtn.click();
    }
    if (e.key === 'Escape') {
      cancelBtn.click();
    }
  });
}

// ── Drag and Drop ────────────────────────────────────────────────────────────

function handleDragStart(e) {
  draggedCardId = e.target.dataset.cardId;
  draggedCardElement = e.target;
  e.target.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', draggedCardId);

  // Create drop indicator
  dropIndicator = document.createElement('div');
  dropIndicator.className = 'drop-indicator';
}

function handleDragEnd(e) {
  e.target.classList.remove('dragging');
  draggedCardId = null;
  draggedCardElement = null;
  removeDropIndicator();
}

function removeDropIndicator() {
  if (dropIndicator && dropIndicator.parentNode) {
    dropIndicator.parentNode.removeChild(dropIndicator);
  }
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  const listEl = e.currentTarget;
  if (!draggedCardId) return;

  removeDropIndicator();

  const cards = Array.from(listEl.querySelectorAll('.card:not(.dragging)'));

  if (cards.length === 0) {
    // Empty column or all cards are being dragged
    listEl.appendChild(dropIndicator);
    return;
  }

  // Find the card we're hovering over
  let insertBefore = null;
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY < midY) {
      insertBefore = card;
      break;
    }
  }

  if (insertBefore) {
    listEl.insertBefore(dropIndicator, insertBefore);
  } else {
    listEl.appendChild(dropIndicator);
  }
}

function handleDragLeave(e) {
  // Only remove indicator if we're actually leaving the list
  const listEl = e.currentTarget;
  const relatedTarget = e.relatedTarget;
  if (!listEl.contains(relatedTarget)) {
    removeDropIndicator();
  }
}

function handleDrop(e) {
  e.preventDefault();
  const listEl = e.currentTarget;
  const targetColumnId = listEl.dataset.columnId;

  if (!draggedCardId) return;

  const cardId = draggedCardId;

  // Determine afterId and beforeId based on the drop indicator position
  const allCards = Array.from(listEl.querySelectorAll('.card:not(.dragging)'));

  // Find where the drop indicator is
  let dropIndex = -1;
  const children = Array.from(listEl.children);
  const indicatorIndex = children.indexOf(dropIndicator);

  // Build an ordered list of card IDs excluding the dragged card
  const orderedCards = allCards.filter((c) => c.dataset.cardId !== cardId);

  // Find the position of the indicator relative to cards
  let afterId = null;
  let beforeId = null;

  if (indicatorIndex >= 0) {
    // Count how many cards are before the indicator
    let cardsBefore = 0;
    for (let i = 0; i < indicatorIndex; i++) {
      if (children[i].classList && children[i].classList.contains('card') && children[i].dataset.cardId !== cardId) {
        cardsBefore++;
      }
    }

    if (cardsBefore > 0 && cardsBefore <= orderedCards.length) {
      afterId = orderedCards[cardsBefore - 1].dataset.cardId;
    }
    if (cardsBefore < orderedCards.length) {
      beforeId = orderedCards[cardsBefore].dataset.cardId;
    }
  } else {
    // No indicator, drop at end
    if (orderedCards.length > 0) {
      afterId = orderedCards[orderedCards.length - 1].dataset.cardId;
    }
  }

  removeDropIndicator();

  // ── Optimistic update ──────────────────────────────────────────────────
  applyOptimisticMove(cardId, targetColumnId, afterId, beforeId);

  // ── Server request ─────────────────────────────────────────────────────
  moveCard(cardId, targetColumnId, afterId, beforeId).catch((err) => {
    console.error('Move failed, reloading board:', err);
    loadBoard();
  });
}

function applyOptimisticMove(cardId, targetColumnId, afterId, beforeId) {
  // Find and remove the card from its current column in state
  let card = null;
  for (const col of boardState) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) {
      card = { ...col.cards[idx] };
      col.cards.splice(idx, 1);
      break;
    }
  }
  if (!card) return;

  // Update column_id
  card.column_id = targetColumnId;

  // Insert into the target column
  const targetCol = boardState.find((c) => c.id === targetColumnId);
  if (!targetCol) return;

  if (afterId === null && beforeId === null) {
    // Drop at end (or empty column)
    targetCol.cards.push(card);
  } else if (afterId === null) {
    // Drop at beginning
    const beforeIdx = targetCol.cards.findIndex((c) => c.id === beforeId);
    if (beforeIdx >= 0) {
      targetCol.cards.splice(beforeIdx, 0, card);
    } else {
      targetCol.cards.push(card);
    }
  } else {
    // Drop after afterId
    const afterIdx = targetCol.cards.findIndex((c) => c.id === afterId);
    if (afterIdx >= 0) {
      targetCol.cards.splice(afterIdx + 1, 0, card);
    } else {
      targetCol.cards.push(card);
    }
  }

  // Assign temporary positions to keep things consistent
  for (let i = 0; i < targetCol.cards.length; i++) {
    targetCol.cards[i].position = (i + 1) * 1000;
  }

  renderBoard();
}

// ── SSE ──────────────────────────────────────────────────────────────────────

function connectSSE() {
  const evtSource = new EventSource(`${API_BASE}/stream`);

  evtSource.addEventListener('card:created', (e) => {
    const card = JSON.parse(e.data);
    handleCardCreated(card);
  });

  evtSource.addEventListener('card:moved', (e) => {
    const data = JSON.parse(e.data);
    handleCardMoved(data.card, data.sourceColumnId);
  });

  evtSource.addEventListener('card:deleted', (e) => {
    const data = JSON.parse(e.data);
    handleCardDeleted(data.id, data.column_id);
  });

  evtSource.addEventListener('column:renormalized', (e) => {
    const data = JSON.parse(e.data);
    handleColumnRenormalized(data.columnId, data.cards);
  });

  evtSource.onerror = () => {
    // EventSource will auto-reconnect; on reconnect we reload the full board
    console.warn('SSE connection error, will reconnect...');
    setTimeout(() => {
      loadBoard();
    }, 1000);
  };

  return evtSource;
}

function handleCardCreated(card) {
  const column = boardState.find((c) => c.id === card.column_id);
  if (!column) return;

  // Avoid duplicates
  const existing = column.cards.findIndex((c) => c.id === card.id);
  if (existing !== -1) {
    // Update with canonical data
    column.cards[existing] = card;
  } else {
    column.cards.push(card);
  }

  // Sort by position
  column.cards.sort((a, b) => a.position - b.position);
  renderBoard();
}

function handleCardMoved(card, sourceColumnId) {
  // Remove the card from any column it currently exists in (ensures no duplicates)
  for (const col of boardState) {
    const idx = col.cards.findIndex((c) => c.id === card.id);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
    }
  }

  // Add the card to its canonical column
  const targetCol = boardState.find((c) => c.id === card.column_id);
  if (!targetCol) return;

  targetCol.cards.push(card);
  targetCol.cards.sort((a, b) => a.position - b.position);

  renderBoard();
}

function handleCardDeleted(cardId, columnId) {
  for (const col of boardState) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
    }
  }
  renderBoard();
}

function handleColumnRenormalized(columnId, cards) {
  const column = boardState.find((c) => c.id === columnId);
  if (!column) return;

  // Update positions from renormalized data
  for (const update of cards) {
    const card = column.cards.find((c) => c.id === update.id);
    if (card) {
      card.position = update.position;
    }
  }
  column.cards.sort((a, b) => a.position - b.position);
  renderBoard();
}

// ── Init ─────────────────────────────────────────────────────────────────────

async function loadBoard() {
  try {
    boardState = await fetchBoard();
    renderBoard();
  } catch (err) {
    console.error('Failed to load board:', err);
    setTimeout(loadBoard, 2000);
  }
}

async function init() {
  await loadBoard();
  connectSSE();
}

init();
