import { fetchBoard, createCard, moveCard, deleteCard } from './api.js';

// ─── State ───────────────────────────────────────────────────

let boardState = []; // Array of { id, title, position, cards: [...] }
let dragState = null; // { cardId, sourceColumnId, cardEl }

// ─── DOM Refs ────────────────────────────────────────────────

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('connection-status');

// ─── Rendering ───────────────────────────────────────────────

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

  const header = document.createElement('div');
  header.className = 'column-header';
  header.textContent = `${column.title} (${column.cards.length})`;
  colEl.appendChild(header);

  const cardList = document.createElement('div');
  cardList.className = 'card-list';
  cardList.dataset.columnId = column.id;

  for (const card of column.cards) {
    cardList.appendChild(renderCard(card));
  }

  // Drag-and-drop event listeners on the card list
  cardList.addEventListener('dragover', handleDragOver);
  cardList.addEventListener('dragleave', handleDragLeave);
  cardList.addEventListener('drop', handleDrop);

  colEl.appendChild(cardList);

  // Add card button / form
  const addBtn = document.createElement('button');
  addBtn.className = 'add-card-btn';
  addBtn.textContent = '+ Add a card';
  addBtn.addEventListener('click', () => showAddCardForm(colEl, column.id));
  colEl.appendChild(addBtn);

  return colEl;
}

function renderCard(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.dataset.cardId = card.id;
  cardEl.draggable = true;

  // Card text
  const textSpan = document.createElement('span');
  textSpan.textContent = card.text;
  cardEl.appendChild(textSpan);

  // Delete button
  const delBtn = document.createElement('button');
  delBtn.className = 'card-delete-btn';
  delBtn.textContent = '✕';
  delBtn.title = 'Delete card';
  delBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await deleteCard(card.id);
    } catch (err) {
      console.error('Delete failed', err);
    }
  });
  cardEl.appendChild(delBtn);

  cardEl.addEventListener('dragstart', (e) => handleDragStart(e, card));
  cardEl.addEventListener('dragend', handleDragEnd);

  return cardEl;
}

// ─── Add Card Form ───────────────────────────────────────────

function showAddCardForm(colEl, columnId) {
  // Remove existing form if any
  const existingForm = colEl.querySelector('.add-card-form');
  if (existingForm) return;

  const addBtn = colEl.querySelector('.add-card-btn');
  addBtn.style.display = 'none';

  const form = document.createElement('div');
  form.className = 'add-card-form';

  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Enter a title for this card...';

  const actions = document.createElement('div');
  actions.className = 'form-actions';

  const submitBtn = document.createElement('button');
  submitBtn.className = 'btn-add';
  submitBtn.textContent = 'Add Card';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-cancel';
  cancelBtn.textContent = 'Cancel';

  actions.appendChild(submitBtn);
  actions.appendChild(cancelBtn);
  form.appendChild(textarea);
  form.appendChild(actions);

  colEl.appendChild(form);
  textarea.focus();

  const close = () => {
    form.remove();
    addBtn.style.display = '';
  };

  submitBtn.addEventListener('click', async () => {
    const text = textarea.value.trim();
    if (!text) return;
    submitBtn.disabled = true;
    try {
      await createCard(columnId, text);
      close();
    } catch (err) {
      console.error('Failed to create card:', err);
      submitBtn.disabled = false;
    }
  });

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitBtn.click();
    }
    if (e.key === 'Escape') close();
  });

  cancelBtn.addEventListener('click', close);
}

// ─── Drag and Drop ───────────────────────────────────────────

function handleDragStart(e, card) {
  dragState = {
    cardId: card.id,
    sourceColumnId: card.column_id,
  };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', card.id);
  // Delay to allow the drag image to be captured before adding the class
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-card-id="${card.id}"]`);
    if (el) el.classList.add('dragging');
  });
}

function handleDragEnd() {
  // Clean up all drag classes
  document.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
  document.querySelectorAll('.drop-above').forEach((el) => el.classList.remove('drop-above'));
  document.querySelectorAll('.drop-below').forEach((el) => el.classList.remove('drop-below'));
  document.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
  dragState = null;
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  const cardList = e.currentTarget;

  // Clear previous indicators in all lists
  document.querySelectorAll('.drop-above').forEach((el) => el.classList.remove('drop-above'));
  document.querySelectorAll('.drop-below').forEach((el) => el.classList.remove('drop-below'));
  document.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));

  const cards = [...cardList.querySelectorAll('.card:not(.dragging)')];
  if (cards.length === 0) {
    cardList.classList.add('drag-over');
    return;
  }

  // Find the card we're hovering over
  const target = getDropTarget(e, cards);
  if (target) {
    const rect = target.el.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY < midY) {
      target.el.classList.add('drop-above');
    } else {
      target.el.classList.add('drop-below');
    }
  } else {
    // Below all cards
    const lastCard = cards[cards.length - 1];
    if (lastCard) lastCard.classList.add('drop-below');
  }
}

function handleDragLeave(e) {
  const cardList = e.currentTarget;
  if (!cardList.contains(e.relatedTarget)) {
    cardList.classList.remove('drag-over');
    cardList.querySelectorAll('.drop-above, .drop-below').forEach((el) => {
      el.classList.remove('drop-above', 'drop-below');
    });
  }
}

function getDropTarget(e, cards) {
  for (const el of cards) {
    const rect = el.getBoundingClientRect();
    if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
      return { el };
    }
  }
  return null;
}

function handleDrop(e) {
  e.preventDefault();
  if (!dragState) return;

  const cardList = e.currentTarget;
  const targetColumnId = cardList.dataset.columnId;
  const cards = [...cardList.querySelectorAll('.card:not(.dragging)')];

  // Determine insert position
  let afterId = null;
  let beforeId = null;

  if (cards.length === 0) {
    // Empty column, no ref cards needed
  } else {
    const target = getDropTarget(e, cards);
    if (target) {
      const rect = target.el.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const targetCardId = target.el.dataset.cardId;
      const idx = cards.indexOf(target.el);

      if (e.clientY < midY) {
        // Insert before this card
        beforeId = targetCardId;
        if (idx > 0) {
          afterId = cards[idx - 1].dataset.cardId;
        }
      } else {
        // Insert after this card
        afterId = targetCardId;
        if (idx < cards.length - 1) {
          beforeId = cards[idx + 1].dataset.cardId;
        }
      }
    } else {
      // Below all cards
      afterId = cards[cards.length - 1]?.dataset.cardId || null;
    }
  }

  // Don't move to the same position
  if (afterId === dragState.cardId) afterId = null;
  if (beforeId === dragState.cardId) beforeId = null;

  const cardId = dragState.cardId;
  const sourceColumnId = dragState.sourceColumnId;

  // Optimistic update
  optimisticMove(cardId, sourceColumnId, targetColumnId, afterId, beforeId);

  // Send to server
  moveCard(cardId, targetColumnId, afterId, beforeId)
    .then(() => {
      // Server will broadcast the canonical state
    })
    .catch((err) => {
      console.error('Move failed, refetching board:', err);
      loadBoard();
    });

  // Clean up
  handleDragEnd();
}

function optimisticMove(cardId, sourceColumnId, targetColumnId, afterId, beforeId) {
  // Find the card in state
  let card = null;
  for (const col of boardState) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) {
      card = col.cards.splice(idx, 1)[0];
      break;
    }
  }
  if (!card) return;

  card.column_id = targetColumnId;

  const targetCol = boardState.find((c) => c.id === targetColumnId);
  if (!targetCol) return;

  if (afterId == null && beforeId == null) {
    // Place at end
    targetCol.cards.push(card);
  } else if (afterId) {
    const afterIdx = targetCol.cards.findIndex((c) => c.id === afterId);
    if (afterIdx !== -1) {
      targetCol.cards.splice(afterIdx + 1, 0, card);
    } else {
      targetCol.cards.push(card);
    }
  } else if (beforeId) {
    const beforeIdx = targetCol.cards.findIndex((c) => c.id === beforeId);
    if (beforeIdx !== -1) {
      targetCol.cards.splice(beforeIdx, 0, card);
    } else {
      targetCol.cards.push(card);
    }
  }

  render();
}

// ─── SSE Connection ──────────────────────────────────────────

function connectSSE() {
  const es = new EventSource('/api/stream');

  es.onopen = () => {
    statusEl.textContent = '● Connected';
    statusEl.className = 'status connected';
  };

  es.onerror = () => {
    statusEl.textContent = '● Disconnected';
    statusEl.className = 'status disconnected';
  };

  es.addEventListener('card_created', (e) => {
    const card = JSON.parse(e.data);
    applyCardCreated(card);
  });

  es.addEventListener('card_moved', (e) => {
    const card = JSON.parse(e.data);
    applyCardMoved(card);
  });

  es.addEventListener('card_deleted', (e) => {
    const data = JSON.parse(e.data);
    applyCardDeleted(data.id);
  });

  es.addEventListener('column_renormalized', (e) => {
    const data = JSON.parse(e.data);
    applyColumnRenormalized(data.columnId, data.cards);
  });
}

function applyCardCreated(card) {
  // Remove from any existing column (dedup safeguard)
  for (const col of boardState) {
    col.cards = col.cards.filter((c) => c.id !== card.id);
  }

  const col = boardState.find((c) => c.id === card.column_id);
  if (!col) return;

  col.cards.push(card);
  col.cards.sort((a, b) => a.position - b.position);
  render();
}

function applyCardMoved(card) {
  // Remove card from any column
  for (const col of boardState) {
    col.cards = col.cards.filter((c) => c.id !== card.id);
  }

  // Add to correct column
  const col = boardState.find((c) => c.id === card.column_id);
  if (!col) return;

  col.cards.push(card);
  col.cards.sort((a, b) => a.position - b.position);
  render();
}

function applyCardDeleted(cardId) {
  for (const col of boardState) {
    col.cards = col.cards.filter((c) => c.id !== cardId);
  }
  render();
}

function applyColumnRenormalized(columnId, cards) {
  const col = boardState.find((c) => c.id === columnId);
  if (!col) return;

  // Remove from all columns any card that appears in the renormalized set
  const renormedIds = new Set(cards.map((c) => c.id));
  for (const c of boardState) {
    c.cards = c.cards.filter((card) => !renormedIds.has(card.id));
  }

  col.cards = cards.sort((a, b) => a.position - b.position);
  render();
}

// ─── Init ────────────────────────────────────────────────────

async function loadBoard() {
  try {
    boardState = await fetchBoard();
    render();
  } catch (err) {
    console.error('Failed to load board:', err);
  }
}

async function init() {
  await loadBoard();
  connectSSE();
}

init();
