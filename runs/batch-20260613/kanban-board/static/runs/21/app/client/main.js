// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * @typedef {{ id: string, column_id: string, text: string, position: number, created_at: string }} Card
 * @typedef {{ id: string, title: string, position: number, cards: Card[] }} Column
 */

/** @type {Column[]} */
let boardState = [];

/** Card currently being dragged */
/** @type {string|null} */
let draggedCardId = null;

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

const API = '/api';

async function fetchBoard() {
  const res = await fetch(`${API}/board`);
  if (!res.ok) throw new Error('Failed to fetch board');
  return /** @type {Column[]} */ (await res.json());
}

/**
 * @param {string} columnId
 * @param {string} text
 */
async function apiCreateCard(columnId, text) {
  const res = await fetch(`${API}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text }),
  });
  if (!res.ok) throw new Error('Failed to create card');
  return /** @type {Card} */ (await res.json());
}

/**
 * @param {string} cardId
 * @param {{ columnId: string, afterId?: string|null, beforeId?: string|null }} move
 */
async function apiMoveCard(cardId, move) {
  const res = await fetch(`${API}/cards/${cardId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(move),
  });
  if (!res.ok) throw new Error('Failed to move card');
  return /** @type {Card} */ (await res.json());
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function boardEl() {
  return /** @type {HTMLElement} */ (document.getElementById('board'));
}

/**
 * Full re-render of the board from `boardState`.
 */
function renderBoard() {
  const board = boardEl();
  board.innerHTML = '';
  for (const col of boardState) {
    board.appendChild(renderColumn(col));
  }
}

/**
 * @param {Column} col
 * @returns {HTMLElement}
 */
function renderColumn(col) {
  const el = document.createElement('div');
  el.className = 'column';
  el.dataset.columnId = col.id;

  // Header
  const header = document.createElement('div');
  header.className = 'column-header';
  header.textContent = col.title;
  el.appendChild(header);

  // Cards container
  const cardsContainer = document.createElement('div');
  cardsContainer.className = 'column-cards';
  cardsContainer.dataset.columnId = col.id;

  for (const card of col.cards) {
    cardsContainer.appendChild(renderCard(card));
  }

  // --- Drop zone event listeners ---
  cardsContainer.addEventListener('dragover', handleDragOver);
  cardsContainer.addEventListener('dragleave', handleDragLeave);
  cardsContainer.addEventListener('drop', handleDrop);

  el.appendChild(cardsContainer);

  // Add card button / form
  el.appendChild(renderAddCard(col.id));

  return el;
}

/**
 * @param {Card} card
 * @returns {HTMLElement}
 */
function renderCard(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.cardId = card.id;
  el.textContent = card.text;
  el.draggable = true;

  el.addEventListener('dragstart', (e) => {
    draggedCardId = card.id;
    el.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.id);
    }
  });

  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    draggedCardId = null;
    clearDropIndicators();
  });

  return el;
}

/**
 * @param {string} columnId
 * @returns {HTMLElement}
 */
function renderAddCard(columnId) {
  const wrapper = document.createElement('div');
  wrapper.className = 'add-card-btn';

  const btn = document.createElement('button');
  btn.textContent = '+ Add a card';
  btn.addEventListener('click', () => {
    // Replace button with form
    const form = createAddCardForm(columnId, wrapper);
    wrapper.replaceWith(form);
  });

  wrapper.appendChild(btn);
  return wrapper;
}

/**
 * @param {string} columnId
 * @param {HTMLElement} previousEl
 * @returns {HTMLElement}
 */
function createAddCardForm(columnId, _previousEl) {
  const form = document.createElement('div');
  form.className = 'add-card-form';

  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Enter card text…';
  form.appendChild(textarea);

  const actions = document.createElement('div');
  actions.className = 'form-actions';

  const addBtn = document.createElement('button');
  addBtn.className = 'btn-add';
  addBtn.textContent = 'Add';
  addBtn.addEventListener('click', async () => {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = '';
    try {
      await apiCreateCard(columnId, text);
      // SSE will handle rendering – but we don't close the form so user can add more
    } catch (err) {
      console.error(err);
    }
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => {
    form.replaceWith(renderAddCard(columnId));
  });

  actions.appendChild(addBtn);
  actions.appendChild(cancelBtn);
  form.appendChild(actions);

  // Focus textarea asynchronously
  requestAnimationFrame(() => textarea.focus());

  return form;
}

// ---------------------------------------------------------------------------
// Drag & Drop helpers
// ---------------------------------------------------------------------------

/**
 * Remove all drop indicators from the DOM.
 */
function clearDropIndicators() {
  document.querySelectorAll('.drop-placeholder').forEach((el) => el.remove());
  document.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
}

/**
 * Find the card element that is closest below the cursor's Y position.
 * @param {HTMLElement} container
 * @param {number} y
 * @returns {{ element: HTMLElement|null, before: boolean }}
 */
function getDropTarget(container, y) {
  /** @type {HTMLElement[]} */
  const cardEls = /** @type {HTMLElement[]} */ (
    [...container.querySelectorAll('.card:not(.dragging)')]
  );

  for (const cardEl of cardEls) {
    const rect = cardEl.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (y < midY) {
      return { element: cardEl, before: true };
    }
  }

  // After last card (or empty column)
  return { element: null, before: false };
}

/**
 * @param {DragEvent} e
 */
function handleDragOver(e) {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

  const container = /** @type {HTMLElement} */ (e.currentTarget);
  clearDropIndicators();
  container.classList.add('drag-over');

  const { element } = getDropTarget(container, e.clientY);

  // Insert placeholder
  const placeholder = document.createElement('div');
  placeholder.className = 'drop-placeholder';
  if (element) {
    container.insertBefore(placeholder, element);
  } else {
    container.appendChild(placeholder);
  }
}

/**
 * @param {DragEvent} e
 */
function handleDragLeave(e) {
  // Only handle leave if we actually left the container
  const container = /** @type {HTMLElement} */ (e.currentTarget);
  const related = /** @type {Node|null} */ (e.relatedTarget);
  if (related && container.contains(related)) return;
  clearDropIndicators();
}

/**
 * @param {DragEvent} e
 */
function handleDrop(e) {
  e.preventDefault();
  clearDropIndicators();

  if (!draggedCardId) return;

  const container = /** @type {HTMLElement} */ (e.currentTarget);
  const columnId = container.dataset.columnId;
  if (!columnId) return;

  const { element: targetEl } = getDropTarget(container, e.clientY);

  // Determine afterId / beforeId for the server
  /** @type {string|null} */
  let afterId = null;
  /** @type {string|null} */
  let beforeId = null;

  if (targetEl) {
    // Dropping before targetEl
    beforeId = targetEl.dataset.cardId || null;
    // afterId is the card right before targetEl (if any), excluding the dragged card
    const prevEl = targetEl.previousElementSibling;
    if (prevEl && prevEl.classList.contains('card') && prevEl.dataset.cardId !== draggedCardId) {
      afterId = prevEl.dataset.cardId || null;
    }
  } else {
    // Dropping at the end – afterId is the last card in the column (excluding dragged)
    const allCards = /** @type {HTMLElement[]} */ (
      [...container.querySelectorAll('.card:not(.dragging)')]
    );
    if (allCards.length > 0) {
      const last = allCards[allCards.length - 1];
      if (last.dataset.cardId !== draggedCardId) {
        afterId = last.dataset.cardId || null;
      }
    }
  }

  const cardId = draggedCardId;

  // Optimistic update: move card in state and re-render
  applyOptimisticMove(cardId, columnId, afterId, beforeId);

  // Send mutation to server
  apiMoveCard(cardId, { columnId, afterId, beforeId }).catch((err) => {
    console.error('Move failed, re-fetching board:', err);
    // On error, re-fetch the full board as fallback
    fetchBoard().then((board) => {
      boardState = board;
      renderBoard();
    });
  });
}

/**
 * Optimistically move a card in the local boardState and re-render.
 * @param {string} cardId
 * @param {string} targetColumnId
 * @param {string|null} afterId
 * @param {string|null} beforeId
 */
function applyOptimisticMove(cardId, targetColumnId, afterId, beforeId) {
  // 1. Find and remove the card from its current column
  /** @type {Card|undefined} */
  let card;
  for (const col of boardState) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) {
      card = col.cards.splice(idx, 1)[0];
      break;
    }
  }
  if (!card) return;

  // 2. Find target column
  const targetCol = boardState.find((c) => c.id === targetColumnId);
  if (!targetCol) return;

  card.column_id = targetColumnId;

  // 3. Insert at the right position
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

// ---------------------------------------------------------------------------
// SSE – Real-time updates
// ---------------------------------------------------------------------------

function connectSSE() {
  const evtSource = new EventSource(`${API}/stream`);

  evtSource.addEventListener('card:created', (e) => {
    /** @type {Card} */
    const card = JSON.parse(e.data);
    applyCardCreated(card);
  });

  evtSource.addEventListener('card:moved', (e) => {
    /** @type {Card} */
    const card = JSON.parse(e.data);
    applyCardMoved(card);
  });

  evtSource.addEventListener('column:renormalized', (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    applyColumnRenormalized(columnId, cards);
  });

  evtSource.onerror = () => {
    // EventSource will automatically reconnect
    console.warn('SSE connection error – will retry');
  };
}

/**
 * Apply a card:created event to local state.
 * @param {Card} card
 */
function applyCardCreated(card) {
  const col = boardState.find((c) => c.id === card.column_id);
  if (!col) return;

  // Don't add duplicates
  if (col.cards.some((c) => c.id === card.id)) return;

  // Insert in position order
  insertCardSorted(col, card);
  renderBoard();
}

/**
 * Apply a card:moved event – canonical state from server.
 * @param {Card} card
 */
function applyCardMoved(card) {
  // Remove from any column
  for (const col of boardState) {
    const idx = col.cards.findIndex((c) => c.id === card.id);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
    }
  }

  // Insert into the correct column at the correct position
  const targetCol = boardState.find((c) => c.id === card.column_id);
  if (!targetCol) return;

  insertCardSorted(targetCol, card);
  renderBoard();
}

/**
 * Apply a column:renormalized event.
 * @param {string} columnId
 * @param {Card[]} cards
 */
function applyColumnRenormalized(columnId, cards) {
  // First remove all these cards from any column (important: they might be duplicated optimistically)
  const cardIds = new Set(cards.map((c) => c.id));
  for (const col of boardState) {
    col.cards = col.cards.filter((c) => !cardIds.has(c.id));
  }

  // Set the target column's cards
  const targetCol = boardState.find((c) => c.id === columnId);
  if (!targetCol) return;

  targetCol.cards = cards.slice().sort((a, b) => a.position - b.position);
  renderBoard();
}

/**
 * Insert a card into a column's card array, maintaining position order.
 * @param {Column} col
 * @param {Card} card
 */
function insertCardSorted(col, card) {
  let inserted = false;
  for (let i = 0; i < col.cards.length; i++) {
    if (card.position < col.cards[i].position) {
      col.cards.splice(i, 0, card);
      inserted = true;
      break;
    }
  }
  if (!inserted) {
    col.cards.push(card);
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function init() {
  try {
    boardState = await fetchBoard();
    renderBoard();
    connectSSE();
  } catch (err) {
    console.error('Failed to initialize board:', err);
    const board = boardEl();
    board.innerHTML = '<p style="padding:24px;color:red;">Failed to load board. Is the server running?</p>';
  }
}

init();
