import { fetchBoard, createCard, moveCard } from "./api.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * @typedef {{ id: string, column_id: string, text: string, position: number, created_at: string }} Card
 * @typedef {{ id: string, title: string, position: number, cards: Card[] }} Column
 */

/** @type {Column[]} */
let board = [];

/** The card id currently being dragged */
let draggedCardId = null;

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const boardEl = /** @type {HTMLElement} */ (document.getElementById("board"));

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  boardEl.innerHTML = "";
  for (const col of board) {
    boardEl.appendChild(renderColumn(col));
  }
}

/**
 * @param {Column} col
 * @returns {HTMLElement}
 */
function renderColumn(col) {
  const colEl = document.createElement("div");
  colEl.className = "column";
  colEl.dataset.columnId = col.id;

  // Header
  const header = document.createElement("div");
  header.className = "column-header";
  header.textContent = `${col.title} (${col.cards.length})`;
  colEl.appendChild(header);

  // Card list
  const listEl = document.createElement("div");
  listEl.className = "card-list";
  listEl.dataset.columnId = col.id;

  for (const card of col.cards) {
    listEl.appendChild(renderCard(card));
  }

  // Drop zone events
  listEl.addEventListener("dragover", handleDragOver);
  listEl.addEventListener("dragleave", handleDragLeave);
  listEl.addEventListener("drop", handleDrop);

  colEl.appendChild(listEl);

  // Add card form
  colEl.appendChild(renderAddCardForm(col.id));

  return colEl;
}

/**
 * @param {Card} card
 * @returns {HTMLElement}
 */
function renderCard(card) {
  const el = document.createElement("div");
  el.className = "card";
  el.draggable = true;
  el.dataset.cardId = card.id;
  el.dataset.columnId = card.column_id;
  el.textContent = card.text;

  el.addEventListener("dragstart", handleDragStart);
  el.addEventListener("dragend", handleDragEnd);

  return el;
}

/**
 * @param {string} columnId
 * @returns {HTMLElement}
 */
function renderAddCardForm(columnId) {
  const wrapper = document.createElement("div");
  wrapper.className = "add-card-form";

  const btn = document.createElement("button");
  btn.className = "add-card-btn";
  btn.textContent = "+ Add a card";

  const form = document.createElement("div");
  form.style.display = "none";

  const textarea = document.createElement("textarea");
  textarea.placeholder = "Enter a title for this card…";

  const actions = document.createElement("div");
  actions.className = "form-actions";

  const addBtn = document.createElement("button");
  addBtn.className = "btn-primary";
  addBtn.textContent = "Add Card";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn-cancel";
  cancelBtn.textContent = "Cancel";

  actions.appendChild(addBtn);
  actions.appendChild(cancelBtn);
  form.appendChild(textarea);
  form.appendChild(actions);
  wrapper.appendChild(btn);
  wrapper.appendChild(form);

  btn.addEventListener("click", () => {
    btn.style.display = "none";
    form.style.display = "block";
    textarea.focus();
  });

  cancelBtn.addEventListener("click", () => {
    form.style.display = "none";
    btn.style.display = "block";
    textarea.value = "";
  });

  const submitCard = async () => {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = "";
    form.style.display = "none";
    btn.style.display = "block";
    try {
      // We don't optimistically add here; the SSE event will add it
      await createCard(columnId, text);
    } catch (err) {
      console.error("Failed to create card:", err);
    }
  };

  addBtn.addEventListener("click", submitCard);
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitCard();
    }
    if (e.key === "Escape") {
      form.style.display = "none";
      btn.style.display = "block";
      textarea.value = "";
    }
  });

  return wrapper;
}

// ---------------------------------------------------------------------------
// Drag and Drop
// ---------------------------------------------------------------------------

/** @param {DragEvent} e */
function handleDragStart(e) {
  const target = /** @type {HTMLElement} */ (e.target);
  draggedCardId = target.dataset.cardId || null;
  target.classList.add("dragging");
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", draggedCardId || "");
  }
}

/** @param {DragEvent} e */
function handleDragEnd(e) {
  const target = /** @type {HTMLElement} */ (e.target);
  target.classList.remove("dragging");
  draggedCardId = null;
  clearDropIndicators();
}

/** @param {DragEvent} e */
function handleDragOver(e) {
  e.preventDefault();
  if (!e.dataTransfer) return;
  e.dataTransfer.dropEffect = "move";

  const listEl = /** @type {HTMLElement} */ (e.currentTarget);
  listEl.classList.add("drag-over");

  // Find the card we're hovering over
  clearDropIndicators();

  const cardEls = /** @type {HTMLElement[]} */ (
    [...listEl.querySelectorAll(".card:not(.dragging)")]
  );

  let closestCard = null;
  let closestOffset = Number.POSITIVE_INFINITY;
  let insertBefore = true;

  for (const cardEl of cardEls) {
    const rect = cardEl.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const offset = e.clientY - midY;

    if (Math.abs(offset) < Math.abs(closestOffset)) {
      closestOffset = offset;
      closestCard = cardEl;
      insertBefore = offset < 0;
    }
  }

  if (closestCard) {
    if (insertBefore) {
      closestCard.classList.add("drop-above");
    } else {
      closestCard.classList.add("drop-below");
    }
  }
}

/** @param {DragEvent} e */
function handleDragLeave(e) {
  const listEl = /** @type {HTMLElement} */ (e.currentTarget);
  // Only remove if we've actually left the list element
  const related = /** @type {Node | null} */ (e.relatedTarget);
  if (!related || !listEl.contains(related)) {
    listEl.classList.remove("drag-over");
    clearDropIndicators();
  }
}

/** @param {DragEvent} e */
function handleDrop(e) {
  e.preventDefault();
  const listEl = /** @type {HTMLElement} */ (e.currentTarget);
  listEl.classList.remove("drag-over");

  const cardId = draggedCardId;
  if (!cardId) return;

  const targetColumnId = listEl.dataset.columnId;
  if (!targetColumnId) return;

  // Determine insertion point
  const cardEls = /** @type {HTMLElement[]} */ (
    [...listEl.querySelectorAll(".card:not(.dragging)")]
  );

  let afterId = null;
  let beforeId = null;

  // Find the closest card and determine position
  let closestCard = null;
  let closestOffset = Number.POSITIVE_INFINITY;
  let insertBefore = true;

  for (const cardEl of cardEls) {
    const rect = cardEl.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const offset = e.clientY - midY;

    if (Math.abs(offset) < Math.abs(closestOffset)) {
      closestOffset = offset;
      closestCard = cardEl;
      insertBefore = offset < 0;
    }
  }

  if (closestCard) {
    const closestCardId = closestCard.dataset.cardId;
    if (insertBefore) {
      // Insert before closestCard
      beforeId = closestCardId || null;
      // afterId is the card before closestCard (if any)
      const idx = cardEls.indexOf(closestCard);
      if (idx > 0) {
        afterId = cardEls[idx - 1].dataset.cardId || null;
      }
    } else {
      // Insert after closestCard
      afterId = closestCardId || null;
      // beforeId is the card after closestCard (if any)
      const idx = cardEls.indexOf(closestCard);
      if (idx < cardEls.length - 1) {
        afterId = closestCardId || null;
        beforeId = cardEls[idx + 1].dataset.cardId || null;
      }
    }
  }

  // Don't move to the same position
  if (afterId === cardId || beforeId === cardId) {
    clearDropIndicators();
    return;
  }

  clearDropIndicators();

  // Optimistic update
  applyOptimisticMove(cardId, targetColumnId, afterId, beforeId);

  // Send to server
  moveCard(cardId, targetColumnId, afterId, beforeId)
    .catch((err) => {
      console.error("Move failed:", err);
      // On failure, reload the board to get canonical state
      loadBoard();
    });
}

function clearDropIndicators() {
  document.querySelectorAll(".drop-above, .drop-below").forEach((el) => {
    el.classList.remove("drop-above", "drop-below");
  });
  currentDropTarget = null;
}

// ---------------------------------------------------------------------------
// Optimistic updates
// ---------------------------------------------------------------------------

/**
 * Apply an optimistic move to the in-memory board state and re-render.
 * @param {string} cardId
 * @param {string} targetColumnId
 * @param {string | null} afterId
 * @param {string | null} beforeId
 */
function applyOptimisticMove(cardId, targetColumnId, afterId, beforeId) {
  // Find and remove card from its current column
  /** @type {Card | null} */
  let card = null;
  for (const col of board) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) {
      card = col.cards.splice(idx, 1)[0];
      break;
    }
  }
  if (!card) return;

  // Update column_id
  card.column_id = targetColumnId;

  // Find target column
  const targetCol = board.find((c) => c.id === targetColumnId);
  if (!targetCol) return;

  // Determine insertion index
  let insertIdx = targetCol.cards.length; // default: end

  if (afterId && beforeId) {
    const afterIdx = targetCol.cards.findIndex((c) => c.id === afterId);
    if (afterIdx !== -1) {
      insertIdx = afterIdx + 1;
    }
  } else if (beforeId) {
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
  render();
}

// ---------------------------------------------------------------------------
// SSE – Real-time updates
// ---------------------------------------------------------------------------

let sseWasConnected = false;

function connectSSE() {
  const source = new EventSource("/api/stream");

  source.addEventListener("card-created", (e) => {
    const card = JSON.parse(e.data);
    applyServerCardCreated(card);
  });

  source.addEventListener("card-moved", (e) => {
    const { card, sourceColumnId } = JSON.parse(e.data);
    applyServerCardMoved(card, sourceColumnId);
  });

  source.addEventListener("column-renormalized", (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    applyColumnRenormalized(columnId, cards);
  });

  source.addEventListener("card-deleted", (e) => {
    const data = JSON.parse(e.data);
    applyServerCardDeleted(data.id, data.column_id);
  });

  source.onopen = () => {
    // If we're reconnecting after a disconnect, reload the full board
    // to reconcile any events we missed
    if (sseWasConnected) {
      loadBoard();
    }
    sseWasConnected = true;
  };

  source.onerror = () => {
    console.warn("SSE connection lost, will auto-reconnect…");
  };
}

/**
 * @param {Card} card
 */
function applyServerCardCreated(card) {
  const col = board.find((c) => c.id === card.column_id);
  if (!col) return;

  // Check if card already exists (e.g., if we added it optimistically)
  if (col.cards.some((c) => c.id === card.id)) return;

  // Insert in correct position order
  let inserted = false;
  for (let i = 0; i < col.cards.length; i++) {
    if (col.cards[i].position > card.position) {
      col.cards.splice(i, 0, card);
      inserted = true;
      break;
    }
  }
  if (!inserted) col.cards.push(card);

  render();
}

/**
 * @param {Card} card
 * @param {string} _sourceColumnId
 */
function applyServerCardMoved(card, _sourceColumnId) {
  // Remove card from ALL columns (ensures no duplicates)
  for (const col of board) {
    const idx = col.cards.findIndex((c) => c.id === card.id);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
    }
  }

  // Insert into target column at correct position
  const targetCol = board.find((c) => c.id === card.column_id);
  if (!targetCol) return;

  let inserted = false;
  for (let i = 0; i < targetCol.cards.length; i++) {
    if (targetCol.cards[i].position > card.position) {
      targetCol.cards.splice(i, 0, card);
      inserted = true;
      break;
    }
  }
  if (!inserted) targetCol.cards.push(card);

  render();
}

/**
 * @param {string} columnId
 * @param {Card[]} cards
 */
function applyColumnRenormalized(columnId, cards) {
  const col = board.find((c) => c.id === columnId);
  if (!col) return;
  col.cards = cards;
  render();
}

/**
 * @param {string} cardId
 * @param {string} _columnId
 */
function applyServerCardDeleted(cardId, _columnId) {
  for (const col of board) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
    }
  }
  render();
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function loadBoard() {
  try {
    board = await fetchBoard();
    render();
  } catch (err) {
    console.error("Failed to load board:", err);
    boardEl.innerHTML = '<p style="padding:24px;color:red;">Failed to load board. Is the server running?</p>';
  }
}

async function init() {
  await loadBoard();
  connectSSE();
}

init();
