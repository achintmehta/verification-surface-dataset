/**
 * Kanban Board - Vanilla JS Frontend
 * 
 * Features:
 * - Load board state from server
 * - Drag-and-drop cards within and across columns
 * - Optimistic updates with server reconciliation
 * - Real-time sync via SSE
 */

const API_BASE = '/api';

// ─── State ──────────────────────────────────────────────────────────────────────
// columns: [{ id, title, position, cards: [{ id, column_id, text, position, created_at }] }]
let boardState = [];
let dragState = null; // { cardId, sourceColumnId, cardEl }

// ─── API helpers ────────────────────────────────────────────────────────────────

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

// ─── Rendering ──────────────────────────────────────────────────────────────────

const boardEl = document.getElementById('board');

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

  // Header
  const header = document.createElement('div');
  header.className = 'column-header';
  header.textContent = column.title;
  colEl.appendChild(header);

  // Card list
  const listEl = document.createElement('div');
  listEl.className = 'card-list';
  listEl.dataset.columnId = column.id;

  for (const card of column.cards) {
    listEl.appendChild(renderCard(card));
  }

  // Drop zone events
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
  cardEl.dataset.cardId = card.id;
  cardEl.dataset.position = card.position;
  cardEl.draggable = true;
  cardEl.textContent = card.text;

  cardEl.addEventListener('dragstart', handleDragStart);
  cardEl.addEventListener('dragend', handleDragEnd);

  return cardEl;
}

function renderAddCardForm(columnId) {
  const form = document.createElement('div');
  form.className = 'add-card-form';

  const btn = document.createElement('button');
  btn.className = 'add-card-btn';
  btn.textContent = '+ Add a card';
  btn.addEventListener('click', () => showAddCardInput(form, columnId));

  form.appendChild(btn);
  return form;
}

function showAddCardInput(formEl, columnId) {
  formEl.innerHTML = '';

  const textarea = document.createElement('textarea');
  textarea.className = 'add-card-input';
  textarea.placeholder = 'Enter a title for this card...';
  textarea.rows = 2;

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

  formEl.appendChild(textarea);
  formEl.appendChild(actions);

  textarea.focus();

  async function submit() {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.disabled = true;
    submitBtn.disabled = true;
    try {
      await createCard(columnId, text);
      // SSE will handle adding the card to the DOM
    } catch (err) {
      console.error('Failed to create card:', err);
    }
    // Reset form
    resetForm();
  }

  function resetForm() {
    formEl.innerHTML = '';
    const btn = document.createElement('button');
    btn.className = 'add-card-btn';
    btn.textContent = '+ Add a card';
    btn.addEventListener('click', () => showAddCardInput(formEl, columnId));
    formEl.appendChild(btn);
  }

  submitBtn.addEventListener('click', submit);
  cancelBtn.addEventListener('click', resetForm);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'Escape') {
      resetForm();
    }
  });
}

// ─── Drag & Drop ────────────────────────────────────────────────────────────────

function handleDragStart(e) {
  const cardEl = e.target.closest('.card');
  if (!cardEl) return;

  dragState = {
    cardId: cardEl.dataset.cardId,
    sourceColumnId: cardEl.closest('.card-list').dataset.columnId,
    cardEl,
  };

  cardEl.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', cardEl.dataset.cardId);
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
  clearDropIndicators();

  const afterEl = getDragAfterElement(listEl, e.clientY);
  const indicator = document.createElement('div');
  indicator.className = 'drop-indicator';

  if (afterEl) {
    listEl.insertBefore(indicator, afterEl);
  } else {
    listEl.appendChild(indicator);
  }
}

function handleDragLeave(e) {
  // Only clear if we're leaving the list itself
  const listEl = e.currentTarget;
  const relatedTarget = e.relatedTarget;
  if (relatedTarget && listEl.contains(relatedTarget)) return;
  clearDropIndicators();
}

function handleDrop(e) {
  e.preventDefault();
  clearDropIndicators();

  if (!dragState) return;

  const listEl = e.currentTarget;
  const targetColumnId = listEl.dataset.columnId;
  const afterEl = getDragAfterElement(listEl, e.clientY);

  const { cardId, sourceColumnId, cardEl } = dragState;

  // Determine afterId and beforeId
  let afterId = null;
  let beforeId = null;

  if (afterEl) {
    // Card will be inserted before afterEl
    beforeId = afterEl.dataset.cardId;
    const prevEl = afterEl.previousElementSibling;
    if (prevEl && prevEl.classList.contains('card') && prevEl.dataset.cardId !== cardId) {
      afterId = prevEl.dataset.cardId;
    }
  } else {
    // Card goes at the end
    const allCards = [...listEl.querySelectorAll('.card')].filter(
      (c) => c.dataset.cardId !== cardId
    );
    if (allCards.length > 0) {
      afterId = allCards[allCards.length - 1].dataset.cardId;
    }
  }

  // Optimistic DOM update: move the card element
  if (cardEl.parentNode) {
    cardEl.parentNode.removeChild(cardEl);
  }
  cardEl.classList.remove('dragging');

  if (afterEl) {
    listEl.insertBefore(cardEl, afterEl);
  } else {
    listEl.appendChild(cardEl);
  }

  // Update internal state optimistically
  optimisticMove(cardId, sourceColumnId, targetColumnId, afterId, beforeId);

  // Send to server
  moveCard(cardId, targetColumnId, afterId, beforeId).catch((err) => {
    console.error('Move failed, will reconcile on next SSE event:', err);
  });

  dragState = null;
}

function getDragAfterElement(listEl, y) {
  const cards = [...listEl.querySelectorAll('.card:not(.dragging)')];

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

function clearDropIndicators() {
  document.querySelectorAll('.drop-indicator').forEach((el) => el.remove());
}

// ─── Optimistic State Update ────────────────────────────────────────────────────

function optimisticMove(cardId, sourceColumnId, targetColumnId, afterId, beforeId) {
  // Remove card from source column in state
  let movedCard = null;
  for (const col of boardState) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) {
      movedCard = col.cards.splice(idx, 1)[0];
      break;
    }
  }
  if (!movedCard) return;

  movedCard.column_id = targetColumnId;

  // Insert into target column
  const targetCol = boardState.find((c) => c.id === targetColumnId);
  if (!targetCol) return;

  if (beforeId) {
    const beforeIdx = targetCol.cards.findIndex((c) => c.id === beforeId);
    if (beforeIdx !== -1) {
      targetCol.cards.splice(beforeIdx, 0, movedCard);
    } else {
      targetCol.cards.push(movedCard);
    }
  } else if (afterId) {
    const afterIdx = targetCol.cards.findIndex((c) => c.id === afterId);
    if (afterIdx !== -1) {
      targetCol.cards.splice(afterIdx + 1, 0, movedCard);
    } else {
      targetCol.cards.push(movedCard);
    }
  } else {
    targetCol.cards.push(movedCard);
  }
}

// ─── SSE ────────────────────────────────────────────────────────────────────────

function connectSSE() {
  const statusEl = document.getElementById('connection-status');
  let wasConnected = false;
  const es = new EventSource(`${API_BASE}/stream`);

  es.onopen = async () => {
    statusEl.textContent = 'Connected';
    statusEl.className = 'status connected';

    // If reconnecting, re-fetch full board state to catch up on missed events
    if (wasConnected) {
      try {
        boardState = await fetchBoard();
        renderBoard();
      } catch (err) {
        console.error('Failed to re-fetch board on reconnect:', err);
      }
    }
    wasConnected = true;
  };

  es.onerror = () => {
    statusEl.textContent = 'Disconnected';
    statusEl.className = 'status disconnected';
  };

  es.addEventListener('card:created', (e) => {
    const { card } = JSON.parse(e.data);
    handleCardCreated(card);
  });

  es.addEventListener('card:moved', (e) => {
    const { card } = JSON.parse(e.data);
    handleCardMoved(card);
  });

  es.addEventListener('column:renormalized', (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    handleColumnRenormalized(columnId, cards);
  });

  es.addEventListener('card:deleted', (e) => {
    const { cardId, columnId } = JSON.parse(e.data);
    handleCardDeleted(cardId);
  });

  return es;
}

// ─── SSE Event Handlers ─────────────────────────────────────────────────────────

function handleCardCreated(card) {
  // Add to state
  const col = boardState.find((c) => c.id === card.column_id);
  if (!col) return;

  // Avoid duplicate
  const existing = col.cards.findIndex((c) => c.id === card.id);
  if (existing !== -1) {
    col.cards[existing] = card;
  } else {
    col.cards.push(card);
  }

  // Sort by position
  col.cards.sort((a, b) => a.position - b.position);

  // Update DOM
  reconcileColumnDOM(col);
}

function handleCardMoved(card) {
  // Remove card from all columns in state
  for (const col of boardState) {
    const idx = col.cards.findIndex((c) => c.id === card.id);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      // Only reconcile the source column DOM if it's different from target
      if (col.id !== card.column_id) {
        reconcileColumnDOM(col);
      }
    }
  }

  // Add to target column
  const targetCol = boardState.find((c) => c.id === card.column_id);
  if (!targetCol) return;

  targetCol.cards.push(card);
  targetCol.cards.sort((a, b) => a.position - b.position);

  reconcileColumnDOM(targetCol);
}

function handleColumnRenormalized(columnId, cards) {
  // First, remove any of these cards from other columns (cross-column move case)
  const cardIds = new Set(cards.map((c) => c.id));
  for (const col of boardState) {
    if (col.id === columnId) continue;
    const before = col.cards.length;
    col.cards = col.cards.filter((c) => !cardIds.has(c.id));
    if (col.cards.length !== before) {
      reconcileColumnDOM(col);
    }
  }

  const col = boardState.find((c) => c.id === columnId);
  if (!col) return;

  // Replace all cards in this column with the canonical list
  col.cards = cards.sort((a, b) => a.position - b.position);
  reconcileColumnDOM(col);
}

function handleCardDeleted(cardId) {
  for (const col of boardState) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      reconcileColumnDOM(col);
      break;
    }
  }
}

// ─── DOM Reconciliation ─────────────────────────────────────────────────────────

function reconcileColumnDOM(column) {
  const listEl = document.querySelector(`.card-list[data-column-id="${column.id}"]`);
  if (!listEl) return;

  const existingCards = new Map();
  for (const el of listEl.querySelectorAll('.card')) {
    existingCards.set(el.dataset.cardId, el);
  }

  // Remove cards no longer in the column
  for (const [id, el] of existingCards) {
    if (!column.cards.find((c) => c.id === id)) {
      el.remove();
      existingCards.delete(id);
    }
  }

  // Insert/reorder cards
  let prevEl = null;
  for (const card of column.cards) {
    let cardEl = existingCards.get(card.id);
    if (!cardEl) {
      // Check if card element exists elsewhere in the DOM (moved from another column)
      cardEl = document.querySelector(`.card[data-card-id="${card.id}"]`);
      if (cardEl) {
        cardEl.remove();
      }
      cardEl = renderCard(card);
    } else {
      // Update data
      cardEl.dataset.position = card.position;
      cardEl.textContent = card.text;
    }

    // Check if in correct position
    if (prevEl) {
      if (prevEl.nextElementSibling !== cardEl) {
        prevEl.after(cardEl);
      }
    } else {
      if (listEl.firstChild !== cardEl) {
        listEl.insertBefore(cardEl, listEl.firstChild);
      }
    }

    prevEl = cardEl;
  }
}

// ─── Initialize ─────────────────────────────────────────────────────────────────

async function init() {
  try {
    boardState = await fetchBoard();
    renderBoard();
    connectSSE();
  } catch (err) {
    console.error('Failed to initialize board:', err);
    boardEl.innerHTML = '<p style="color: white; padding: 20px;">Failed to load board. Is the server running?</p>';
  }
}

init();
