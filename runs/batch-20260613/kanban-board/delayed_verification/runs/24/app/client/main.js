// ─── State ──────────────────────────────────────────────────────────────────
// board: array of { id, title, position, cards: [{ id, column_id, text, position }] }
let board = [];

// Track in-flight optimistic moves so we can reconcile
// Map<cardId, { columnId }>
const pendingMoves = new Map();

const API = '/api';
const boardEl = document.getElementById('board');

// ─── API Helpers ────────────────────────────────────────────────────────────

async function fetchBoard() {
  const res = await fetch(`${API}/board`);
  if (!res.ok) throw new Error('Failed to fetch board');
  return res.json();
}

async function createCard(columnId, text) {
  const res = await fetch(`${API}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text }),
  });
  if (!res.ok) throw new Error('Failed to create card');
  return res.json();
}

async function moveCard(cardId, columnId, afterId, beforeId) {
  const res = await fetch(`${API}/cards/${cardId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, afterId: afterId || null, beforeId: beforeId || null }),
  });
  if (!res.ok) throw new Error('Failed to move card');
  return res.json();
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function render() {
  boardEl.innerHTML = '';
  for (const column of board) {
    const colEl = createColumnEl(column);
    boardEl.appendChild(colEl);
  }
}

function createColumnEl(column) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = column.id;

  // Header
  const headerEl = document.createElement('div');
  headerEl.className = 'column-header';

  const titleSpan = document.createElement('span');
  titleSpan.textContent = column.title;
  headerEl.appendChild(titleSpan);

  const countSpan = document.createElement('span');
  countSpan.className = 'card-count';
  countSpan.textContent = column.cards.length;
  headerEl.appendChild(countSpan);

  colEl.appendChild(headerEl);

  // Cards container
  const cardsEl = document.createElement('div');
  cardsEl.className = 'column-cards';
  cardsEl.dataset.columnId = column.id;

  // Sort cards by position
  const sortedCards = [...column.cards].sort((a, b) => a.position - b.position);
  for (const card of sortedCards) {
    cardsEl.appendChild(createCardEl(card));
  }

  // Drop zone events
  cardsEl.addEventListener('dragover', handleDragOver);
  cardsEl.addEventListener('dragleave', handleDragLeave);
  cardsEl.addEventListener('drop', handleDrop);

  colEl.appendChild(cardsEl);

  // Add card form
  const formEl = document.createElement('div');
  formEl.className = 'add-card-form';

  const textarea = document.createElement('textarea');
  textarea.rows = 2;
  textarea.placeholder = 'Add a card…';
  formEl.appendChild(textarea);

  const addBtn = document.createElement('button');
  addBtn.className = 'add-card-btn';
  addBtn.type = 'button';
  addBtn.textContent = '+ Add Card';
  formEl.appendChild(addBtn);

  const submitCard = async () => {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = '';
    try {
      await createCard(column.id, text);
    } catch (err) {
      console.error('Failed to create card:', err);
    }
  };

  addBtn.addEventListener('click', submitCard);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitCard();
    }
  });

  colEl.appendChild(formEl);

  return colEl;
}

function createCardEl(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.dataset.cardId = card.id;
  el.textContent = card.text;

  if (pendingMoves.has(card.id)) {
    el.classList.add('optimistic');
  }

  el.addEventListener('dragstart', handleDragStart);
  el.addEventListener('dragend', handleDragEnd);

  return el;
}

// ─── Drag and Drop ──────────────────────────────────────────────────────────

let draggedCardId = null;

function handleDragStart(e) {
  draggedCardId = e.target.dataset.cardId;
  e.target.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', draggedCardId);
}

function handleDragEnd(e) {
  e.target.classList.remove('dragging');
  draggedCardId = null;
  // Remove all drop indicators
  document.querySelectorAll('.drop-indicator').forEach((el) => el.remove());
  document.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  const cardsContainer = e.currentTarget;
  cardsContainer.classList.add('drag-over');

  // Remove existing indicators
  document.querySelectorAll('.drop-indicator').forEach((el) => el.remove());

  // Find the element we're hovering over to show insertion point
  const afterElement = getDragAfterElement(cardsContainer, e.clientY);

  const indicator = document.createElement('div');
  indicator.className = 'drop-indicator';

  if (afterElement) {
    cardsContainer.insertBefore(indicator, afterElement);
  } else {
    cardsContainer.appendChild(indicator);
  }
}

function handleDragLeave(e) {
  // Only remove if we're actually leaving the container
  const cardsContainer = e.currentTarget;
  const relatedTarget = e.relatedTarget;
  if (relatedTarget && cardsContainer.contains(relatedTarget)) return;
  cardsContainer.classList.remove('drag-over');
  document.querySelectorAll('.drop-indicator').forEach((el) => el.remove());
}

function handleDrop(e) {
  e.preventDefault();
  const cardsContainer = e.currentTarget;
  cardsContainer.classList.remove('drag-over');
  document.querySelectorAll('.drop-indicator').forEach((el) => el.remove());

  const cardId = e.dataTransfer.getData('text/plain');
  if (!cardId) return;

  const targetColumnId = cardsContainer.dataset.columnId;
  const afterElement = getDragAfterElement(cardsContainer, e.clientY);

  // Determine the afterId and beforeId for the server
  // afterId = the card directly ABOVE the drop position (lower position value)
  // beforeId = the card directly BELOW the drop position (higher position value)
  let afterId = null;
  let beforeId = null;

  if (afterElement) {
    // afterElement is the card that will be below the dropped card
    beforeId = afterElement.dataset.cardId;
    if (beforeId === cardId) {
      // The "before" card is the dragged card itself, skip to next
      const nextEl = afterElement.nextElementSibling;
      if (nextEl && nextEl.classList.contains('card')) {
        beforeId = nextEl.dataset.cardId;
      } else {
        beforeId = null;
      }
    }

    // The card above is the previous sibling that is a .card, excluding the dragged card
    let prevEl = afterElement.previousElementSibling;
    while (prevEl && (!prevEl.classList.contains('card') || prevEl.dataset.cardId === cardId)) {
      prevEl = prevEl.previousElementSibling;
    }
    if (prevEl && prevEl.dataset.cardId !== cardId) {
      afterId = prevEl.dataset.cardId;
    }
  } else {
    // Dropped at the end of the column
    const allCards = cardsContainer.querySelectorAll('.card');
    // Find the last card that isn't the dragged card
    for (let i = allCards.length - 1; i >= 0; i--) {
      if (allCards[i].dataset.cardId !== cardId) {
        afterId = allCards[i].dataset.cardId;
        break;
      }
    }
  }

  // Check if card is actually being moved to a different position
  const card = findCard(cardId);
  if (card) {
    const sourceColumn = findCardColumn(cardId);
    if (sourceColumn && sourceColumn.id === targetColumnId) {
      const sortedCards = [...sourceColumn.cards].sort((a, b) => a.position - b.position);
      const currentIndex = sortedCards.findIndex((c) => c.id === cardId);

      // Determine the target index
      let targetIndex;
      if (afterId) {
        targetIndex = sortedCards.findIndex((c) => c.id === afterId) + 1;
      } else if (beforeId) {
        targetIndex = sortedCards.findIndex((c) => c.id === beforeId);
      } else {
        targetIndex = sortedCards.length; // end
      }

      // Adjust for the card being removed from its current position
      if (currentIndex < targetIndex) targetIndex--;

      if (currentIndex === targetIndex) {
        // No actual move needed
        return;
      }
    }
  }

  // Optimistic update
  applyOptimisticMove(cardId, targetColumnId, afterId, beforeId);

  // Mark as pending
  pendingMoves.set(cardId, { columnId: targetColumnId });

  // Re-render
  render();

  // Send to server
  moveCard(cardId, targetColumnId, afterId, beforeId)
    .then(() => {
      // Server confirmed; SSE will deliver canonical state
    })
    .catch((err) => {
      console.error('Move failed, reloading board:', err);
      pendingMoves.delete(cardId);
      loadBoard();
    });
}

function getDragAfterElement(container, y) {
  const cards = [...container.querySelectorAll('.card:not(.dragging)')];

  let closest = null;
  let closestOffset = Number.POSITIVE_INFINITY;

  for (const child of cards) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;

    if (offset < 0 && Math.abs(offset) < closestOffset) {
      closestOffset = Math.abs(offset);
      closest = child;
    }
  }

  return closest;
}

// ─── State Manipulation ─────────────────────────────────────────────────────

function findCard(cardId) {
  for (const col of board) {
    const card = col.cards.find((c) => c.id === cardId);
    if (card) return card;
  }
  return null;
}

function findCardColumn(cardId) {
  for (const col of board) {
    if (col.cards.some((c) => c.id === cardId)) return col;
  }
  return null;
}

function removeCardFromBoard(cardId) {
  for (const col of board) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) {
      return col.cards.splice(idx, 1)[0];
    }
  }
  return null;
}

function getColumn(columnId) {
  return board.find((c) => c.id === columnId);
}

function applyOptimisticMove(cardId, targetColumnId, afterId, beforeId) {
  const card = removeCardFromBoard(cardId);
  if (!card) return;

  const targetCol = getColumn(targetColumnId);
  if (!targetCol) return;

  card.column_id = targetColumnId;

  // Sort target column cards
  targetCol.cards.sort((a, b) => a.position - b.position);

  // Compute an optimistic position
  let afterPos = null;
  let beforePos = null;

  if (afterId) {
    const ac = targetCol.cards.find((c) => c.id === afterId);
    if (ac) afterPos = ac.position;
  }
  if (beforeId) {
    const bc = targetCol.cards.find((c) => c.id === beforeId);
    if (bc) beforePos = bc.position;
  }

  if (afterPos == null && beforePos == null) {
    // End of column
    const last = targetCol.cards[targetCol.cards.length - 1];
    card.position = last ? last.position + 1000 : 1000;
  } else if (afterPos == null) {
    card.position = beforePos / 2;
  } else if (beforePos == null) {
    card.position = afterPos + 1000;
  } else {
    card.position = (afterPos + beforePos) / 2;
  }

  targetCol.cards.push(card);
  targetCol.cards.sort((a, b) => a.position - b.position);
}

// ─── SSE ────────────────────────────────────────────────────────────────────

function connectSSE() {
  const evtSource = new EventSource(`${API}/stream`);
  let isFirstOpen = true;

  evtSource.addEventListener('card_created', (e) => {
    const { card } = JSON.parse(e.data);
    handleCardCreated(card);
  });

  evtSource.addEventListener('card_moved', (e) => {
    const data = JSON.parse(e.data);
    handleCardMoved(data);
  });

  evtSource.onerror = () => {
    console.warn('SSE connection error, will auto-reconnect…');
    // EventSource will auto-reconnect.
  };

  evtSource.onopen = () => {
    console.log('SSE connected');
    if (isFirstOpen) {
      isFirstOpen = false;
    } else {
      // On reconnect, reload board state to catch up on missed events
      loadBoard();
    }
  };

  return evtSource;
}

function handleCardCreated(card) {
  // Ensure card doesn't already exist (idempotency)
  const existing = findCard(card.id);
  if (existing) return;

  const col = getColumn(card.column_id);
  if (!col) return;

  col.cards.push(card);
  col.cards.sort((a, b) => a.position - b.position);
  render();
}

function handleCardMoved(data) {
  const { card, oldColumnId, renormalized } = data;

  // Clear pending state for this card
  pendingMoves.delete(card.id);

  // Remove the card from wherever it currently is in our local state
  // This ensures a card never appears in two columns
  removeCardFromBoard(card.id);

  // If renormalization data was sent, apply it first
  if (renormalized) {
    for (const [colId, colCards] of Object.entries(renormalized)) {
      const col = getColumn(colId);
      if (col) {
        // Replace all cards in that column with the renormalized set
        // but preserve any cards that aren't in the renormalized data
        // (shouldn't happen, but defensive)
        col.cards = colCards;
      }
    }
    // After renormalization, ensure the moved card isn't duplicated
    // (it was already removed above; it might be in the renormalized data)
    // Check if the card is already in the renormalized column
    const targetCol = getColumn(card.column_id);
    if (targetCol) {
      const alreadyThere = targetCol.cards.some((c) => c.id === card.id);
      if (!alreadyThere) {
        targetCol.cards.push(card);
      } else {
        // Update its position/data with canonical values
        const idx = targetCol.cards.findIndex((c) => c.id === card.id);
        if (idx !== -1) {
          targetCol.cards[idx] = card;
        }
      }
    }
  } else {
    // Place it in the canonical column at the canonical position
    const targetCol = getColumn(card.column_id);
    if (targetCol) {
      targetCol.cards.push(card);
    }
  }

  // Sort all columns
  for (const col of board) {
    col.cards.sort((a, b) => a.position - b.position);
  }

  render();
}

// ─── Init ───────────────────────────────────────────────────────────────────

async function loadBoard() {
  try {
    board = await fetchBoard();
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
