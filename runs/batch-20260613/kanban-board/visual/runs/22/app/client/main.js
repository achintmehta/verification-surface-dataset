import { fetchBoard, createCard, moveCard, deleteCard } from './board-api.js';
import { store } from './store.js';
import { connectSSE } from './sse.js';

// ──────── State ────────
let dragState = null; // { cardId, sourceColumnId, element }

// ──────── Initialization ────────
async function init() {
  // Subscribe to state changes BEFORE loading data so initial render triggers
  store.subscribe(render);

  try {
    const data = await fetchBoard();
    store.setBoard(data.columns);
  } catch (err) {
    console.error('Failed to load board:', err);
  }

  // Connect SSE for real-time updates
  if (!new URLSearchParams(window.location.search).has('nosse')) {
    connectSSE({
      onCardCreated: handleSSECardCreated,
      onCardMoved: handleSSECardMoved,
      onCardDeleted: handleSSECardDeleted,
    });
  }
}

// ──────── SSE Handlers ────────
function handleSSECardCreated({ card }) {
  // Ensure card is not duplicated (might already exist from optimistic update)
  const existing = store.getCard(card.id);
  if (existing) {
    // Update position to canonical
    existing.card.position = card.position;
    existing.card.column_id = card.column_id;
    store.moveCard(card, existing.column.id, card.column_id);
  } else {
    store.addCard(card);
  }
}

function handleSSECardMoved({ card, sourceColumnId, targetColumnId, renormalizedCards }) {
  // Authoritative: move the card to the server's canonical position
  store.moveCard(card, sourceColumnId, targetColumnId);

  if (renormalizedCards) {
    store.applyRenormalization(targetColumnId, renormalizedCards);
  }
}

function handleSSECardDeleted({ cardId }) {
  store.deleteCard(cardId);
}

// ──────── Render ────────
function render(columns) {
  const board = document.getElementById('board');
  
  // Preserve existing column elements where possible for smooth DnD
  const existingColumns = new Map();
  for (const el of board.querySelectorAll('.column')) {
    existingColumns.set(el.dataset.columnId, el);
  }

  const fragment = document.createDocumentFragment();

  for (const col of columns) {
    let colEl = existingColumns.get(col.id);
    if (colEl) {
      // Update existing column
      updateColumn(colEl, col);
      existingColumns.delete(col.id);
    } else {
      colEl = createColumnElement(col);
    }
    fragment.appendChild(colEl);
  }

  // Remove stale columns
  for (const stale of existingColumns.values()) {
    stale.remove();
  }

  board.innerHTML = '';
  board.appendChild(fragment);
}

function createColumnElement(col) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = col.id;

  colEl.innerHTML = `
    <div class="column-header">
      <h2>${escapeHtml(col.title)}</h2>
      <span class="card-count">${col.cards.length}</span>
    </div>
    <div class="card-list" data-column-id="${col.id}"></div>
    <div class="add-card-form">
      <button class="add-card-btn">+ Add a card</button>
    </div>
  `;

  const cardList = colEl.querySelector('.card-list');
  renderCardList(cardList, col.cards);

  // Add card button
  setupAddCardForm(colEl, col.id);

  // Drop zone events
  setupDropZone(cardList, col.id);

  return colEl;
}

function updateColumn(colEl, col) {
  // Update count
  const countEl = colEl.querySelector('.card-count');
  if (countEl) countEl.textContent = col.cards.length;

  // Update card list
  const cardList = colEl.querySelector('.card-list');
  renderCardList(cardList, col.cards);
}

function renderCardList(cardList, cards) {
  // Remove drop indicators
  cardList.querySelectorAll('.drop-indicator').forEach(el => el.remove());
  
  const existingCards = new Map();
  for (const el of cardList.querySelectorAll('.card')) {
    existingCards.set(el.dataset.cardId, el);
  }

  // Build new order
  const fragment = document.createDocumentFragment();

  if (cards.length === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.className = 'card-list-empty-msg';
    emptyMsg.textContent = 'No cards yet';
    fragment.appendChild(emptyMsg);
  } else {
    for (const card of cards) {
      let cardEl = existingCards.get(card.id);
      if (cardEl) {
        updateCardElement(cardEl, card);
        existingCards.delete(card.id);
      } else {
        cardEl = createCardElement(card);
      }
      fragment.appendChild(cardEl);
    }
  }

  // Remove stale cards
  for (const stale of existingCards.values()) {
    stale.remove();
  }

  cardList.innerHTML = '';
  cardList.appendChild(fragment);
}

function createCardElement(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.cardId = card.id;
  el.draggable = true;

  const time = card.created_at ? formatTime(card.created_at) : '';

  el.innerHTML = `
    <div class="card-text">${escapeHtml(card.text)}</div>
    <div class="card-meta">
      <span class="card-time">${time}</span>
      <button class="card-delete" title="Delete card">✕</button>
    </div>
  `;

  // Drag events
  el.addEventListener('dragstart', (e) => {
    dragState = {
      cardId: card.id,
      sourceColumnId: card.column_id,
      element: el,
    };
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.id);
  });

  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    clearAllDropIndicators();
    dragState = null;
  });

  // Delete
  el.querySelector('.card-delete').addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      store.deleteCard(card.id);
      await deleteCard(card.id);
    } catch (err) {
      console.error('Delete failed:', err);
      // Refetch
      const data = await fetchBoard();
      store.setBoard(data.columns);
    }
  });

  return el;
}

function updateCardElement(el, card) {
  const textEl = el.querySelector('.card-text');
  if (textEl && textEl.textContent !== card.text) {
    textEl.textContent = card.text;
  }
}

// ──────── Drop Zone Setup ────────
function setupDropZone(cardList, columnId) {
  cardList.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    if (!dragState) return;

    const afterElement = getDragAfterElement(cardList, e.clientY);
    showDropIndicator(cardList, afterElement);
  });

  cardList.addEventListener('dragenter', (e) => {
    e.preventDefault();
    cardList.classList.add('drag-over');
  });

  cardList.addEventListener('dragleave', (e) => {
    // Only remove if leaving the card-list itself
    if (!cardList.contains(e.relatedTarget)) {
      cardList.classList.remove('drag-over');
      clearDropIndicators(cardList);
    }
  });

  cardList.addEventListener('drop', async (e) => {
    e.preventDefault();
    cardList.classList.remove('drag-over');
    clearAllDropIndicators();

    if (!dragState) return;

    const { cardId, sourceColumnId } = dragState;
    const afterElement = getDragAfterElement(cardList, e.clientY);

    // Determine afterId and beforeId
    const cardElements = [...cardList.querySelectorAll('.card:not(.dragging)')];
    let afterId = null;
    let beforeId = null;

    if (afterElement) {
      // Inserting before afterElement
      const afterIdx = cardElements.indexOf(afterElement);
      beforeId = afterElement.dataset.cardId;
      if (afterIdx > 0) {
        afterId = cardElements[afterIdx - 1].dataset.cardId;
      }
    } else {
      // Inserting at end
      if (cardElements.length > 0) {
        afterId = cardElements[cardElements.length - 1].dataset.cardId;
      }
    }

    // Optimistic update: move card in store
    const existing = store.getCard(cardId);
    if (existing) {
      // Compute an optimistic position
      const targetCol = store.getColumn(columnId);
      if (targetCol) {
        const cardsInTarget = targetCol.cards.filter(c => c.id !== cardId);
        let optimisticPos;

        if (afterId && beforeId) {
          const aft = cardsInTarget.find(c => c.id === afterId);
          const bef = cardsInTarget.find(c => c.id === beforeId);
          optimisticPos = aft && bef ? (aft.position + bef.position) / 2 : Date.now();
        } else if (afterId) {
          const aft = cardsInTarget.find(c => c.id === afterId);
          optimisticPos = aft ? aft.position + 500 : Date.now();
        } else if (beforeId) {
          const bef = cardsInTarget.find(c => c.id === beforeId);
          optimisticPos = bef ? bef.position - 500 : Date.now();
        } else {
          optimisticPos = 1000;
        }

        const movedCard = { ...existing.card, column_id: columnId, position: optimisticPos };
        store.moveCard(movedCard, sourceColumnId, columnId);
      }
    }

    // Send to server
    try {
      await moveCard(cardId, columnId, afterId, beforeId);
    } catch (err) {
      console.error('Move failed:', err);
      // Refetch to reconcile
      const data = await fetchBoard();
      store.setBoard(data.columns);
    }

    dragState = null;
  });
}

function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('.card:not(.dragging)')];

  let closest = null;
  let closestOffset = Number.NEGATIVE_INFINITY;

  for (const child of draggableElements) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;

    if (offset < 0 && offset > closestOffset) {
      closestOffset = offset;
      closest = child;
    }
  }

  return closest;
}

function showDropIndicator(cardList, beforeElement) {
  clearDropIndicators(cardList);

  const indicator = document.createElement('div');
  indicator.className = 'drop-indicator';

  if (beforeElement) {
    cardList.insertBefore(indicator, beforeElement);
  } else {
    cardList.appendChild(indicator);
  }
}

function clearDropIndicators(container) {
  container.querySelectorAll('.drop-indicator').forEach(el => el.remove());
}

function clearAllDropIndicators() {
  document.querySelectorAll('.drop-indicator').forEach(el => el.remove());
  document.querySelectorAll('.card-list.drag-over').forEach(el => el.classList.remove('drag-over'));
}

// ──────── Add Card Form ────────
function setupAddCardForm(colEl, columnId) {
  const formContainer = colEl.querySelector('.add-card-form');
  const addBtn = formContainer.querySelector('.add-card-btn');

  addBtn.addEventListener('click', () => {
    formContainer.innerHTML = `
      <div class="add-card-input-wrapper">
        <textarea placeholder="Enter card text..." autofocus></textarea>
        <div class="add-card-actions">
          <button class="btn-submit">Add Card</button>
          <button class="btn-cancel">Cancel</button>
        </div>
      </div>
    `;

    const textarea = formContainer.querySelector('textarea');
    const submitBtn = formContainer.querySelector('.btn-submit');
    const cancelBtn = formContainer.querySelector('.btn-cancel');

    textarea.focus();

    const submitCard = async () => {
      const text = textarea.value.trim();
      if (!text) return;

      // Close form
      resetAddCardForm(formContainer, columnId);

      try {
        await createCard(columnId, text);
      } catch (err) {
        console.error('Create card failed:', err);
      }
    };

    submitBtn.addEventListener('click', submitCard);

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitCard();
      }
      if (e.key === 'Escape') {
        resetAddCardForm(formContainer, columnId);
      }
    });

    cancelBtn.addEventListener('click', () => {
      resetAddCardForm(formContainer, columnId);
    });
  });
}

function resetAddCardForm(formContainer, columnId) {
  formContainer.innerHTML = `<button class="add-card-btn">+ Add a card</button>`;
  // Re-attach event
  const colEl = formContainer.closest('.column');
  setupAddCardForm(colEl, columnId);
}

// ──────── Utilities ────────
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatTime(dateStr) {
  try {
    const d = new Date(dateStr);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

// ──────── Start ────────
init();
