// @ts-nocheck
// ---------------------------------------------------------------------------
// Kanban Board – Client Application
// ---------------------------------------------------------------------------

const API_BASE = '/api';

/**
 * @typedef {{ id: string; columnId: string; text: string; position: number; createdAt: string }} Card
 * @typedef {{ id: string; title: string; position: number; cards: Card[] }} Column
 */

/** @type {Column[]} */
let boardState = [];

/** Currently dragged card id */
let dragCardId = null;

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchBoard() {
  const res = await fetch(`${API_BASE}/board`);
  if (!res.ok) throw new Error('Failed to fetch board');
  return /** @type {Column[]} */ (await res.json());
}

async function createCard(columnId, text) {
  const res = await fetch(`${API_BASE}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, text }),
  });
  if (!res.ok) throw new Error('Failed to create card');
  return /** @type {Card} */ (await res.json());
}

async function moveCard(cardId, columnId, afterId, beforeId) {
  const res = await fetch(`${API_BASE}/cards/${cardId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, afterId: afterId || null, beforeId: beforeId || null }),
  });
  if (!res.ok) throw new Error('Failed to move card');
  return /** @type {Card} */ (await res.json());
}

async function deleteCard(cardId) {
  const res = await fetch(`${API_BASE}/cards/${cardId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete card');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderBoard() {
  const board = document.getElementById('board');
  if (!board) return;
  board.innerHTML = '';

  for (const column of boardState) {
    const colEl = document.createElement('div');
    colEl.className = 'column';
    colEl.dataset.columnId = column.id;

    // Header
    const headerEl = document.createElement('div');
    headerEl.className = 'column-header';
    headerEl.textContent = column.title;
    colEl.appendChild(headerEl);

    // Card list
    const listEl = document.createElement('div');
    listEl.className = 'card-list';
    listEl.dataset.columnId = column.id;

    // Sort cards by position
    const sortedCards = [...column.cards].sort((a, b) => a.position - b.position);

    for (const card of sortedCards) {
      const cardEl = createCardElement(card);
      listEl.appendChild(cardEl);
    }

    setupDropZone(listEl);
    colEl.appendChild(listEl);

    // Add card section
    const addForm = createAddCardForm(column.id);
    colEl.appendChild(addForm);

    board.appendChild(colEl);
  }
}

/**
 * @param {Card} card
 * @returns {HTMLElement}
 */
function createCardElement(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.cardId = card.id;
  el.dataset.position = String(card.position);
  el.draggable = true;

  const textSpan = document.createElement('span');
  textSpan.textContent = card.text;
  el.appendChild(textSpan);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'delete-btn';
  deleteBtn.textContent = '✕';
  deleteBtn.title = 'Delete card';
  deleteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    // Optimistic removal
    removeCardFromState(card.id);
    renderBoard();
    try {
      await deleteCard(card.id);
    } catch {
      // Re-fetch to recover
      await refreshBoard();
    }
  });
  el.appendChild(deleteBtn);

  // Drag events
  el.addEventListener('dragstart', (e) => {
    dragCardId = card.id;
    el.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.id);
    }
  });

  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    dragCardId = null;
    clearDropIndicators();
  });

  return el;
}

/**
 * @param {string} columnId
 * @returns {HTMLElement}
 */
function createAddCardForm(columnId) {
  const wrapper = document.createElement('div');
  wrapper.className = 'add-card-form';

  // Initially show a button
  const btn = document.createElement('button');
  btn.className = 'add-card-btn';
  btn.textContent = '+ Add a card';

  const formArea = document.createElement('div');
  formArea.style.display = 'none';

  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Enter card text...';

  const actions = document.createElement('div');
  actions.className = 'add-card-actions';

  const submitBtn = document.createElement('button');
  submitBtn.className = 'add-card-submit';
  submitBtn.textContent = 'Add Card';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'add-card-cancel';
  cancelBtn.textContent = 'Cancel';

  actions.appendChild(submitBtn);
  actions.appendChild(cancelBtn);

  formArea.appendChild(textarea);
  formArea.appendChild(actions);

  btn.addEventListener('click', () => {
    btn.style.display = 'none';
    formArea.style.display = 'block';
    textarea.focus();
  });

  cancelBtn.addEventListener('click', () => {
    textarea.value = '';
    formArea.style.display = 'none';
    btn.style.display = 'block';
  });

  const submitCard = async () => {
    const text = textarea.value.trim();
    if (!text) return;

    textarea.value = '';

    try {
      await createCard(columnId, text);
      // SSE will handle adding it to state and rendering
    } catch {
      // Fallback: re-fetch
      await refreshBoard();
    }
  };

  submitBtn.addEventListener('click', submitCard);

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitCard();
    }
    if (e.key === 'Escape') {
      textarea.value = '';
      formArea.style.display = 'none';
      btn.style.display = 'block';
    }
  });

  wrapper.appendChild(btn);
  wrapper.appendChild(formArea);
  return wrapper;
}

// ---------------------------------------------------------------------------
// Drag & Drop
// ---------------------------------------------------------------------------

/**
 * @param {HTMLElement} listEl
 */
function setupDropZone(listEl) {
  listEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

    listEl.classList.add('drag-over');
    updateDropIndicator(listEl, e.clientY);
  });

  listEl.addEventListener('dragleave', (e) => {
    // Only remove if actually leaving the list
    if (!listEl.contains(/** @type {Node} */ (e.relatedTarget))) {
      listEl.classList.remove('drag-over');
      clearDropIndicators();
    }
  });

  listEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    listEl.classList.remove('drag-over');
    clearDropIndicators();

    if (!dragCardId) return;

    const columnId = listEl.dataset.columnId;
    if (!columnId) return;

    const { afterId, beforeId } = getDropNeighbours(listEl, e.clientY);

    // Optimistic update
    const card = findCardInState(dragCardId);
    if (card) {
      removeCardFromState(dragCardId);

      // Compute an approximate position for optimistic ordering
      const targetCol = boardState.find((c) => c.id === columnId);
      if (targetCol) {
        const sorted = [...targetCol.cards].sort((a, b) => a.position - b.position);
        const afterCard = afterId ? sorted.find((c) => c.id === afterId) : null;
        const beforeCard = beforeId ? sorted.find((c) => c.id === beforeId) : null;

        let optimisticPos;
        if (afterCard && beforeCard) {
          optimisticPos = (afterCard.position + beforeCard.position) / 2;
        } else if (afterCard) {
          optimisticPos = afterCard.position + 500;
        } else if (beforeCard) {
          optimisticPos = beforeCard.position / 2;
        } else {
          optimisticPos = 1000;
        }

        card.columnId = columnId;
        card.position = optimisticPos;
        targetCol.cards.push(card);
      }

      renderBoard();
    }

    // Send to server
    try {
      await moveCard(dragCardId, columnId, afterId, beforeId);
    } catch {
      await refreshBoard();
    }
  });
}

/**
 * Get the IDs of the cards above and below the drop point.
 * @param {HTMLElement} listEl
 * @param {number} y
 * @returns {{ afterId: string | null; beforeId: string | null }}
 */
function getDropNeighbours(listEl, y) {
  const cards = /** @type {HTMLElement[]} */ (
    [...listEl.querySelectorAll('.card:not(.dragging)')]
  );

  let afterId = null;
  let beforeId = null;

  for (let i = 0; i < cards.length; i++) {
    const rect = cards[i].getBoundingClientRect();
    const midY = rect.top + rect.height / 2;

    if (y < midY) {
      beforeId = cards[i].dataset.cardId || null;
      afterId = i > 0 ? (cards[i - 1].dataset.cardId || null) : null;
      return { afterId, beforeId };
    }
  }

  // Below all cards
  if (cards.length > 0) {
    afterId = cards[cards.length - 1].dataset.cardId || null;
  }
  return { afterId, beforeId: null };
}

/**
 * Show a visual drop indicator between cards.
 * @param {HTMLElement} listEl
 * @param {number} y
 */
function updateDropIndicator(listEl, y) {
  clearDropIndicators();

  const cards = /** @type {HTMLElement[]} */ (
    [...listEl.querySelectorAll('.card:not(.dragging)')]
  );

  const indicator = document.createElement('div');
  indicator.className = 'drop-indicator';

  for (let i = 0; i < cards.length; i++) {
    const rect = cards[i].getBoundingClientRect();
    const midY = rect.top + rect.height / 2;

    if (y < midY) {
      listEl.insertBefore(indicator, cards[i]);
      return;
    }
  }

  // After all cards
  listEl.appendChild(indicator);
}

function clearDropIndicators() {
  document.querySelectorAll('.drop-indicator').forEach((el) => el.remove());
  document.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

/**
 * @param {string} cardId
 * @returns {Card | null}
 */
function findCardInState(cardId) {
  for (const col of boardState) {
    const card = col.cards.find((c) => c.id === cardId);
    if (card) return card;
  }
  return null;
}

/**
 * @param {string} cardId
 */
function removeCardFromState(cardId) {
  for (const col of boardState) {
    col.cards = col.cards.filter((c) => c.id !== cardId);
  }
}

async function refreshBoard() {
  boardState = await fetchBoard();
  renderBoard();
}

// ---------------------------------------------------------------------------
// SSE connection
// ---------------------------------------------------------------------------

function connectSSE() {
  const evtSource = new EventSource(`${API_BASE}/stream`);

  evtSource.addEventListener('card_created', (e) => {
    const card = /** @type {Card} */ (JSON.parse(e.data));
    const col = boardState.find((c) => c.id === card.columnId);
    if (!col) return;

    // Avoid duplicates
    if (col.cards.some((c) => c.id === card.id)) return;

    col.cards.push(card);
    renderBoard();
  });

  evtSource.addEventListener('card_moved', (e) => {
    const card = /** @type {Card} */ (JSON.parse(e.data));

    // Remove the card from its old location (might be same or different column)
    removeCardFromState(card.id);

    // Add to the target column with canonical position
    const col = boardState.find((c) => c.id === card.columnId);
    if (col) {
      col.cards.push(card);
    }

    renderBoard();
  });

  evtSource.addEventListener('card_deleted', (e) => {
    const { id } = JSON.parse(e.data);
    removeCardFromState(id);
    renderBoard();
  });

  evtSource.addEventListener('column_reorder', (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    const col = boardState.find((c) => c.id === columnId);
    if (!col) return;

    // Replace all cards in this column with the renormalized ones
    col.cards = cards;
    renderBoard();
  });

  // Reconnect on error
  evtSource.onerror = () => {
    evtSource.close();
    setTimeout(connectSSE, 2000);
  };
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

async function init() {
  try {
    boardState = await fetchBoard();
    renderBoard();
    connectSSE();
  } catch (err) {
    console.error('Failed to initialise board:', err);
    const board = document.getElementById('board');
    if (board) {
      board.innerHTML = '<p style="color:#fff;padding:24px;">Failed to load board. Is the server running?</p>';
    }
  }
}

init();
