const API_BASE = "";

// ─── State ──────────────────────────────────────────────────────────────────
let boardState = []; // Array of columns with cards
let dragState = null; // { cardId, sourceColumnId, cardEl }

// ─── DOM refs ───────────────────────────────────────────────────────────────
const boardEl = document.getElementById("board");
const statusEl = document.getElementById("connection-status");

// ─── Helpers ────────────────────────────────────────────────────────────────
function findColumn(columnId) {
  return boardState.find((c) => c.id === columnId);
}

function findCardInBoard(cardId) {
  for (const col of boardState) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) return { column: col, card: col.cards[idx], index: idx };
  }
  return null;
}

function removeCardFromBoard(cardId) {
  for (const col of boardState) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      return;
    }
  }
}

function insertCardIntoColumn(columnId, card, afterId, beforeId) {
  const col = findColumn(columnId);
  if (!col) return;

  // Remove from current location if exists
  removeCardFromBoard(card.id);

  // Set column_id
  card.column_id = columnId;

  if (afterId) {
    const afterIdx = col.cards.findIndex((c) => c.id === afterId);
    if (afterIdx !== -1) {
      col.cards.splice(afterIdx + 1, 0, card);
      return;
    }
  }

  if (beforeId) {
    const beforeIdx = col.cards.findIndex((c) => c.id === beforeId);
    if (beforeIdx !== -1) {
      col.cards.splice(beforeIdx, 0, card);
      return;
    }
  }

  // Fallback: push to end
  col.cards.push(card);
}

// ─── API ────────────────────────────────────────────────────────────────────
async function fetchBoard() {
  const res = await fetch(`${API_BASE}/api/board`);
  return res.json();
}

async function createCard(columnId, text) {
  const res = await fetch(`${API_BASE}/api/cards`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ columnId, text }),
  });
  return res.json();
}

async function moveCard(cardId, columnId, afterId, beforeId) {
  const res = await fetch(`${API_BASE}/api/cards/${cardId}/move`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ columnId, afterId: afterId || null, beforeId: beforeId || null }),
  });
  return res.json();
}

async function deleteCard(cardId) {
  await fetch(`${API_BASE}/api/cards/${cardId}`, { method: "DELETE" });
}

// ─── Rendering ──────────────────────────────────────────────────────────────
function render() {
  boardEl.innerHTML = "";
  for (const col of boardState) {
    boardEl.appendChild(renderColumn(col));
  }
}

function renderColumn(col) {
  const colEl = document.createElement("div");
  colEl.className = "column";
  colEl.dataset.columnId = col.id;

  // Header
  const header = document.createElement("div");
  header.className = "column-header";
  header.innerHTML = `
    <span>${escapeHtml(col.title)}</span>
    <span class="card-count">${col.cards.length}</span>
  `;
  colEl.appendChild(header);

  // Card list
  const listEl = document.createElement("div");
  listEl.className = "card-list";
  listEl.dataset.columnId = col.id;

  for (const card of col.cards) {
    listEl.appendChild(renderCard(card));
  }

  // Drag-and-drop events on the list
  listEl.addEventListener("dragover", handleDragOver);
  listEl.addEventListener("dragleave", handleDragLeave);
  listEl.addEventListener("drop", handleDrop);

  colEl.appendChild(listEl);

  // Add card form
  colEl.appendChild(renderAddCardForm(col.id));

  return colEl;
}

function renderCard(card) {
  const el = document.createElement("div");
  el.className = "card";
  el.dataset.cardId = card.id;
  el.draggable = true;
  el.textContent = card.text;

  // Delete button
  const delBtn = document.createElement("button");
  delBtn.className = "delete-btn";
  delBtn.textContent = "✕";
  delBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    handleDeleteCard(card.id);
  });
  el.appendChild(delBtn);

  // Drag events
  el.addEventListener("dragstart", (e) => {
    dragState = {
      cardId: card.id,
      sourceColumnId: card.column_id,
      cardEl: el,
    };
    el.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", card.id);
  });

  el.addEventListener("dragend", () => {
    el.classList.remove("dragging");
    clearDropIndicators();
    dragState = null;
  });

  return el;
}

function renderAddCardForm(columnId) {
  const wrapper = document.createElement("div");
  wrapper.className = "add-card-form";

  const btn = document.createElement("button");
  btn.className = "add-card-btn";
  btn.textContent = "+ Add a card";

  btn.addEventListener("click", () => {
    wrapper.innerHTML = "";
    const inputWrapper = document.createElement("div");
    inputWrapper.className = "add-card-input-wrapper";

    const textarea = document.createElement("textarea");
    textarea.placeholder = "Enter a title for this card…";

    const actions = document.createElement("div");
    actions.className = "add-card-actions";

    const addBtn = document.createElement("button");
    addBtn.className = "btn-primary";
    addBtn.textContent = "Add Card";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn-cancel";
    cancelBtn.textContent = "Cancel";

    addBtn.addEventListener("click", async () => {
      const text = textarea.value.trim();
      if (!text) return;
      textarea.disabled = true;
      addBtn.disabled = true;
      await createCard(columnId, text);
      // SSE will trigger re-render
    });

    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        addBtn.click();
      }
      if (e.key === "Escape") {
        cancelBtn.click();
      }
    });

    cancelBtn.addEventListener("click", () => {
      wrapper.innerHTML = "";
      wrapper.appendChild(btn);
    });

    actions.appendChild(addBtn);
    actions.appendChild(cancelBtn);
    inputWrapper.appendChild(textarea);
    inputWrapper.appendChild(actions);
    wrapper.appendChild(inputWrapper);
    textarea.focus();
  });

  wrapper.appendChild(btn);
  return wrapper;
}

// ─── Drag and Drop ──────────────────────────────────────────────────────────
function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";

  const listEl = e.currentTarget;
  listEl.classList.add("drag-over");

  // Clear existing indicators
  clearDropIndicators();

  // Determine position
  const cardEls = [...listEl.querySelectorAll(".card:not(.dragging)")];
  const mouseY = e.clientY;

  let insertBefore = null;
  for (const cardEl of cardEls) {
    const rect = cardEl.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (mouseY < midY) {
      insertBefore = cardEl;
      break;
    }
  }

  // Show drop indicator
  const indicator = document.createElement("div");
  indicator.className = "drop-indicator";

  if (insertBefore) {
    listEl.insertBefore(indicator, insertBefore);
  } else {
    listEl.appendChild(indicator);
  }
}

function handleDragLeave(e) {
  const listEl = e.currentTarget;
  // Only remove if actually leaving the list
  if (!listEl.contains(e.relatedTarget)) {
    listEl.classList.remove("drag-over");
    clearDropIndicators();
  }
}

function handleDrop(e) {
  e.preventDefault();
  const listEl = e.currentTarget;
  listEl.classList.remove("drag-over");
  clearDropIndicators();

  if (!dragState) return;

  const targetColumnId = listEl.dataset.columnId;
  const cardEls = [...listEl.querySelectorAll(".card:not(.dragging)")];
  const mouseY = e.clientY;

  let insertBeforeIdx = cardEls.length;
  for (let i = 0; i < cardEls.length; i++) {
    const rect = cardEls[i].getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (mouseY < midY) {
      insertBeforeIdx = i;
      break;
    }
  }

  // Find afterId and beforeId based on visible card order in the target column
  const col = findColumn(targetColumnId);
  if (!col) return;

  // Cards in this column excluding the dragged card
  const otherCards = col.cards.filter((c) => c.id !== dragState.cardId);

  const beforeId = insertBeforeIdx < otherCards.length ? otherCards[insertBeforeIdx].id : null;
  const afterId = insertBeforeIdx > 0 ? otherCards[insertBeforeIdx - 1].id : null;

  // Find the card data
  const found = findCardInBoard(dragState.cardId);
  if (!found) return;

  // Optimistic update
  const card = { ...found.card };
  insertCardIntoColumn(targetColumnId, card, afterId, beforeId);
  render();

  // Send to server
  moveCard(dragState.cardId, targetColumnId, afterId, beforeId).catch((err) => {
    console.error("Move failed:", err);
    // On failure, re-fetch board
    fetchBoard().then((data) => {
      boardState = data;
      render();
    });
  });

  dragState = null;
}

function clearDropIndicators() {
  document.querySelectorAll(".drop-indicator").forEach((el) => el.remove());
  document.querySelectorAll(".card-list.drag-over").forEach((el) => {
    // Don't remove drag-over here during drag
  });
}

// ─── Delete Card ────────────────────────────────────────────────────────────
async function handleDeleteCard(cardId) {
  removeCardFromBoard(cardId);
  render();
  await deleteCard(cardId);
}

// ─── SSE ────────────────────────────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource(`${API_BASE}/api/stream`);

  es.onopen = () => {
    statusEl.textContent = "Connected";
    statusEl.className = "status connected";
  };

  es.onerror = () => {
    statusEl.textContent = "Disconnected";
    statusEl.className = "status disconnected";
  };

  es.addEventListener("card-created", (e) => {
    const { card } = JSON.parse(e.data);
    handleSSECardCreated(card);
  });

  es.addEventListener("card-moved", (e) => {
    const { card, oldColumnId } = JSON.parse(e.data);
    handleSSECardMoved(card, oldColumnId);
  });

  es.addEventListener("card-deleted", (e) => {
    const { id } = JSON.parse(e.data);
    handleSSECardDeleted(id);
  });

  es.addEventListener("column-refreshed", (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    handleSSEColumnRefreshed(columnId, cards);
  });

  return es;
}

function handleSSECardCreated(card) {
  // Add to the correct column if not already present
  const existing = findCardInBoard(card.id);
  if (existing) return; // Already have it

  const col = findColumn(card.column_id);
  if (!col) return;

  // Insert in position-sorted order
  let inserted = false;
  for (let i = 0; i < col.cards.length; i++) {
    if (card.position < col.cards[i].position) {
      col.cards.splice(i, 0, card);
      inserted = true;
      break;
    }
  }
  if (!inserted) col.cards.push(card);

  render();
}

function handleSSECardMoved(card, oldColumnId) {
  // Remove card from anywhere it currently is
  removeCardFromBoard(card.id);

  // Insert into the target column at the correct position
  const col = findColumn(card.column_id);
  if (!col) return;

  let inserted = false;
  for (let i = 0; i < col.cards.length; i++) {
    if (card.position < col.cards[i].position) {
      col.cards.splice(i, 0, card);
      inserted = true;
      break;
    }
  }
  if (!inserted) col.cards.push(card);

  render();
}

function handleSSECardDeleted(cardId) {
  removeCardFromBoard(cardId);
  render();
}

function handleSSEColumnRefreshed(columnId, cards) {
  const col = findColumn(columnId);
  if (!col) return;

  // Remove any of these cards from other columns first
  for (const card of cards) {
    for (const otherCol of boardState) {
      if (otherCol.id !== columnId) {
        const idx = otherCol.cards.findIndex((c) => c.id === card.id);
        if (idx !== -1) otherCol.cards.splice(idx, 1);
      }
    }
  }

  col.cards = cards;
  render();
}

// ─── Utility ────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ─── Init ───────────────────────────────────────────────────────────────────
async function init() {
  try {
    boardState = await fetchBoard();
    render();
    // Defer SSE connection slightly so page renders first (helps with networkidle detection)
    setTimeout(() => connectSSE(), 100);
  } catch (err) {
    console.error("Failed to initialize:", err);
    boardEl.innerHTML = `<p style="padding:24px;color:#f85149;">Failed to connect to server. Make sure the backend is running on ${API_BASE}</p>`;
  }
}

init();
