// ============================================================================
// Kanban Board — Client
// ============================================================================

const API_BASE = "/api";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let board = []; // Array of { id, title, position, cards: [...] }
let dragState = null; // { cardId, sourceColumnId, cardEl }

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchBoard() {
  const res = await fetch(`${API_BASE}/board`);
  if (!res.ok) throw new Error("Failed to fetch board");
  return res.json();
}

async function createCard(columnId, text) {
  const res = await fetch(`${API_BASE}/cards`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ columnId, text }),
  });
  if (!res.ok) throw new Error("Failed to create card");
  return res.json();
}

async function moveCard(cardId, columnId, afterId, beforeId) {
  const res = await fetch(`${API_BASE}/cards/${cardId}/move`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ columnId, afterId, beforeId }),
  });
  if (!res.ok) throw new Error("Failed to move card");
  return res.json();
}

async function deleteCard(cardId) {
  const res = await fetch(`${API_BASE}/cards/${cardId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete card");
  return res.json();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderBoard() {
  const boardEl = document.getElementById("board");
  boardEl.innerHTML = "";

  for (const column of board) {
    const colEl = createColumnElement(column);
    boardEl.appendChild(colEl);
  }
}

function createColumnElement(column) {
  const colEl = document.createElement("div");
  colEl.className = "column";
  colEl.dataset.columnId = column.id;

  // Header
  const header = document.createElement("div");
  header.className = "column-header";
  header.textContent = `${column.title} (${column.cards.length})`;
  colEl.appendChild(header);

  // Card list
  const cardList = document.createElement("div");
  cardList.className = "card-list";
  cardList.dataset.columnId = column.id;

  for (const card of column.cards) {
    const cardEl = createCardElement(card);
    cardList.appendChild(cardEl);
  }

  // Drag-and-drop event listeners on the card list (drop zone)
  cardList.addEventListener("dragover", handleDragOver);
  cardList.addEventListener("dragenter", handleDragEnter);
  cardList.addEventListener("dragleave", handleDragLeave);
  cardList.addEventListener("drop", handleDrop);

  colEl.appendChild(cardList);

  // Add card section
  const addSection = createAddCardSection(column.id);
  colEl.appendChild(addSection);

  return colEl;
}

function createCardElement(card) {
  const cardEl = document.createElement("div");
  cardEl.className = "card";
  cardEl.draggable = true;
  cardEl.dataset.cardId = card.id;
  cardEl.dataset.position = card.position;
  cardEl.textContent = card.text;

  // Delete button
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "delete-btn";
  deleteBtn.textContent = "×";
  deleteBtn.title = "Delete card";
  deleteBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    // Optimistically remove
    removeCardFromBoard(card.id);
    renderBoard();
    try {
      await deleteCard(card.id);
    } catch (err) {
      console.error("Failed to delete card:", err);
      // Board will reconcile on next SSE event or refresh
    }
  });
  cardEl.appendChild(deleteBtn);

  // Drag events
  cardEl.addEventListener("dragstart", handleDragStart);
  cardEl.addEventListener("dragend", handleDragEnd);

  return cardEl;
}

function createAddCardSection(columnId) {
  const wrapper = document.createElement("div");

  // Button to show the form
  const showBtn = document.createElement("button");
  showBtn.className = "btn-show-add";
  showBtn.textContent = "+ Add a card";

  // Form
  const form = document.createElement("div");
  form.className = "add-card-form";
  form.style.display = "none";

  const textarea = document.createElement("textarea");
  textarea.placeholder = "Enter a title for this card…";
  textarea.rows = 2;

  const actions = document.createElement("div");
  actions.className = "add-card-actions";

  const addBtn = document.createElement("button");
  addBtn.className = "btn-add";
  addBtn.textContent = "Add Card";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn-cancel";
  cancelBtn.textContent = "×";

  actions.appendChild(addBtn);
  actions.appendChild(cancelBtn);
  form.appendChild(textarea);
  form.appendChild(actions);

  showBtn.addEventListener("click", () => {
    showBtn.style.display = "none";
    form.style.display = "block";
    textarea.focus();
  });

  cancelBtn.addEventListener("click", () => {
    textarea.value = "";
    form.style.display = "none";
    showBtn.style.display = "block";
  });

  const submitCard = async () => {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = "";
    try {
      await createCard(columnId, text);
      // The SSE event will update the board; no optimistic insertion needed for create
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
      cancelBtn.click();
    }
  });

  wrapper.appendChild(showBtn);
  wrapper.appendChild(form);

  return wrapper;
}

// ---------------------------------------------------------------------------
// Drag and Drop
// ---------------------------------------------------------------------------

function handleDragStart(e) {
  const cardEl = e.target.closest(".card");
  if (!cardEl) return;

  const cardId = cardEl.dataset.cardId;
  const columnId = cardEl.closest(".card-list").dataset.columnId;

  dragState = { cardId, sourceColumnId: columnId, cardEl };
  cardEl.classList.add("dragging");

  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", cardId);
}

function handleDragEnd(e) {
  const cardEl = e.target.closest(".card");
  if (cardEl) cardEl.classList.remove("dragging");

  // Remove any lingering placeholders
  document.querySelectorAll(".drop-placeholder").forEach((el) => el.remove());
  document.querySelectorAll(".card-list.drag-over").forEach((el) => el.classList.remove("drag-over"));

  dragState = null;
}

function handleDragEnter(e) {
  e.preventDefault();
  const cardList = e.target.closest(".card-list");
  if (cardList) cardList.classList.add("drag-over");
}

function handleDragLeave(e) {
  const cardList = e.target.closest(".card-list");
  if (!cardList) return;
  // Only remove class if we truly left the card-list
  const related = e.relatedTarget;
  if (!cardList.contains(related)) {
    cardList.classList.remove("drag-over");
    // Remove placeholder from this list
    cardList.querySelectorAll(".drop-placeholder").forEach((el) => el.remove());
  }
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";

  const cardList = e.target.closest(".card-list");
  if (!cardList) return;

  // Remove existing placeholders from all columns
  document.querySelectorAll(".drop-placeholder").forEach((el) => el.remove());

  const placeholder = document.createElement("div");
  placeholder.className = "drop-placeholder";

  // Find the card we're hovering over
  const cards = [...cardList.querySelectorAll(".card:not(.dragging)")];
  const afterCard = getClosestCardAfterCursor(cards, e.clientY);

  if (afterCard) {
    cardList.insertBefore(placeholder, afterCard);
  } else {
    cardList.appendChild(placeholder);
  }
}

function getClosestCardAfterCursor(cards, y) {
  let closest = null;
  let closestOffset = Number.POSITIVE_INFINITY;

  for (const card of cards) {
    const box = card.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    // We want the card whose midpoint is just below the cursor (offset < 0)
    if (offset < 0 && Math.abs(offset) < closestOffset) {
      closestOffset = Math.abs(offset);
      closest = card;
    }
  }

  return closest;
}

function handleDrop(e) {
  e.preventDefault();

  const cardList = e.target.closest(".card-list");
  if (!cardList || !dragState) return;

  cardList.classList.remove("drag-over");
  document.querySelectorAll(".drop-placeholder").forEach((el) => el.remove());

  const targetColumnId = cardList.dataset.columnId;
  const { cardId, sourceColumnId, cardEl } = dragState;

  // Find where to insert based on cursor position
  const cards = [...cardList.querySelectorAll(".card:not(.dragging)")];
  const afterCard = getClosestCardAfterCursor(cards, e.clientY);

  let afterId = null; // card after which we insert (above us)
  let beforeId = null; // card before which we insert (below us)

  if (afterCard) {
    // We're inserting before `afterCard`
    beforeId = afterCard.dataset.cardId;
    // Find the card just before the afterCard
    const idx = cards.indexOf(afterCard);
    if (idx > 0) {
      afterId = cards[idx - 1].dataset.cardId;
    }
  } else {
    // Inserting at the end
    if (cards.length > 0) {
      afterId = cards[cards.length - 1].dataset.cardId;
    }
  }

  // Optimistic update: move card in our state
  optimisticMoveCard(cardId, sourceColumnId, targetColumnId, afterId, beforeId);
  renderBoard();

  // Send to server
  moveCard(cardId, targetColumnId, afterId, beforeId).catch((err) => {
    console.error("Failed to move card:", err);
    // Will reconcile on next SSE or reload
  });
}

// ---------------------------------------------------------------------------
// Board state manipulation
// ---------------------------------------------------------------------------

function findCardInBoard(cardId) {
  for (const col of board) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) return { column: col, index: idx, card: col.cards[idx] };
  }
  return null;
}

function removeCardFromBoard(cardId) {
  for (const col of board) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      return;
    }
  }
}

function getColumnById(columnId) {
  return board.find((c) => c.id === columnId);
}

function optimisticMoveCard(cardId, sourceColumnId, targetColumnId, afterId, beforeId) {
  const found = findCardInBoard(cardId);
  if (!found) return;

  const card = { ...found.card };

  // Remove from source
  removeCardFromBoard(cardId);

  // Find target column
  const targetCol = getColumnById(targetColumnId);
  if (!targetCol) return;

  // Find insertion index
  let insertIdx = targetCol.cards.length; // default: append

  if (beforeId) {
    const beforeIdx = targetCol.cards.findIndex((c) => c.id === beforeId);
    if (beforeIdx !== -1) insertIdx = beforeIdx;
  } else if (afterId) {
    const afterIdx = targetCol.cards.findIndex((c) => c.id === afterId);
    if (afterIdx !== -1) insertIdx = afterIdx + 1;
  }

  // Update card's column
  card.column_id = targetColumnId;

  targetCol.cards.splice(insertIdx, 0, card);
}

function applyServerCard(card) {
  // Remove from any column it might be in
  removeCardFromBoard(card.id);

  // Insert into the correct column at the correct position
  const col = getColumnById(card.column_id);
  if (!col) return;

  // Find insertion index based on position
  let insertIdx = col.cards.length;
  for (let i = 0; i < col.cards.length; i++) {
    if (col.cards[i].position > card.position) {
      insertIdx = i;
      break;
    }
  }

  col.cards.splice(insertIdx, 0, card);
}

// ---------------------------------------------------------------------------
// SSE (Server-Sent Events)
// ---------------------------------------------------------------------------

function connectSSE() {
  const statusEl = document.getElementById("connection-status");
  const evtSource = new EventSource(`${API_BASE}/stream`);

  evtSource.onopen = () => {
    statusEl.textContent = "Connected";
    statusEl.className = "status connected";
  };

  evtSource.onerror = () => {
    statusEl.textContent = "Disconnected";
    statusEl.className = "status disconnected";
    // EventSource will auto-reconnect
  };

  evtSource.addEventListener("card:created", (e) => {
    const { card } = JSON.parse(e.data);
    // Ensure card isn't already in the board (could be our own optimistic add)
    const existing = findCardInBoard(card.id);
    if (existing) {
      // Update in place to canonical state
      removeCardFromBoard(card.id);
    }
    applyServerCard(card);
    renderBoard();
  });

  evtSource.addEventListener("card:moved", (e) => {
    const { card } = JSON.parse(e.data);
    // Reconcile: remove from wherever it is, place canonically
    applyServerCard(card);
    renderBoard();
  });

  evtSource.addEventListener("card:deleted", (e) => {
    const { cardId } = JSON.parse(e.data);
    removeCardFromBoard(cardId);
    renderBoard();
  });

  evtSource.addEventListener("board:refresh", (e) => {
    const { board: newBoard } = JSON.parse(e.data);
    board = newBoard;
    renderBoard();
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  try {
    board = await fetchBoard();
    renderBoard();
    connectSSE();
  } catch (err) {
    console.error("Failed to initialize:", err);
    document.getElementById("board").innerHTML =
      '<p style="color:#fff;padding:24px;">Failed to load board. Is the server running?</p>';
  }
}

init();
