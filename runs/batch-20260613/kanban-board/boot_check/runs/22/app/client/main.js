const API_BASE = "/api";

// ─── State ─────────────────────────────────────────────────────────────────────
let boardState = []; // Array of { id, title, position, cards: [...] }
let dragState = null; // { cardId, sourceColumnId, cardEl }

// ─── API helpers ────────────────────────────────────────────────────────────────
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

// ─── Rendering ──────────────────────────────────────────────────────────────────
const boardEl = document.getElementById("board");

function renderBoard() {
  boardEl.innerHTML = "";
  for (const column of boardState) {
    boardEl.appendChild(createColumnEl(column));
  }
}

function createColumnEl(column) {
  const col = document.createElement("div");
  col.className = "column";
  col.dataset.columnId = column.id;

  const header = document.createElement("div");
  header.className = "column-header";
  header.textContent = `${column.title} (${column.cards.length})`;
  col.appendChild(header);

  const cardList = document.createElement("div");
  cardList.className = "card-list";
  cardList.dataset.columnId = column.id;

  for (const card of column.cards) {
    cardList.appendChild(createCardEl(card));
  }

  // Drop zone events
  cardList.addEventListener("dragover", handleDragOver);
  cardList.addEventListener("dragleave", handleDragLeave);
  cardList.addEventListener("drop", handleDrop);

  col.appendChild(cardList);

  // Add card form
  col.appendChild(createAddCardForm(column.id));

  return col;
}

function createCardEl(card) {
  const el = document.createElement("div");
  el.className = "card";
  el.draggable = true;
  el.dataset.cardId = card.id;
  el.dataset.position = card.position;
  el.textContent = card.text;

  // Delete button
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "delete-btn";
  deleteBtn.textContent = "×";
  deleteBtn.title = "Delete card";
  deleteBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await deleteCard(card.id);
    } catch (err) {
      console.error("Delete error:", err);
    }
  });
  el.appendChild(deleteBtn);

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

function createAddCardForm(columnId) {
  const wrapper = document.createElement("div");
  wrapper.className = "add-card-form";

  const btn = document.createElement("button");
  btn.className = "add-card-btn";
  btn.innerHTML = "+ Add a card";

  const inputArea = document.createElement("div");
  inputArea.className = "add-card-input-area";

  const textarea = document.createElement("textarea");
  textarea.placeholder = "Enter card text...";

  const formActions = document.createElement("div");
  formActions.className = "form-actions";

  const submitBtn = document.createElement("button");
  submitBtn.className = "submit-btn";
  submitBtn.textContent = "Add Card";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "cancel-btn";
  cancelBtn.textContent = "×";

  formActions.appendChild(submitBtn);
  formActions.appendChild(cancelBtn);
  inputArea.appendChild(textarea);
  inputArea.appendChild(formActions);

  btn.addEventListener("click", () => {
    btn.style.display = "none";
    inputArea.classList.add("active");
    textarea.focus();
  });

  cancelBtn.addEventListener("click", () => {
    btn.style.display = "";
    inputArea.classList.remove("active");
    textarea.value = "";
  });

  const doSubmit = async () => {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = "";
    try {
      await createCard(columnId, text);
    } catch (err) {
      console.error("Create card error:", err);
    }
  };

  submitBtn.addEventListener("click", doSubmit);
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSubmit();
    }
    if (e.key === "Escape") {
      cancelBtn.click();
    }
  });

  wrapper.appendChild(btn);
  wrapper.appendChild(inputArea);
  return wrapper;
}

// ─── Drag & Drop ────────────────────────────────────────────────────────────────
function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";

  const cardList = e.currentTarget;
  cardList.classList.add("drag-over");

  // Find insertion position
  clearDropIndicators();
  const afterEl = getDropTarget(cardList, e.clientY);

  let indicator = document.createElement("div");
  indicator.className = "drop-indicator";

  if (afterEl) {
    cardList.insertBefore(indicator, afterEl);
  } else {
    cardList.appendChild(indicator);
  }
}

function handleDragLeave(e) {
  const cardList = e.currentTarget;
  if (!cardList.contains(e.relatedTarget)) {
    cardList.classList.remove("drag-over");
    clearDropIndicators();
  }
}

function handleDrop(e) {
  e.preventDefault();
  const cardList = e.currentTarget;
  cardList.classList.remove("drag-over");
  clearDropIndicators();

  if (!dragState) return;

  const targetColumnId = cardList.dataset.columnId;
  const { cardId, cardEl } = dragState;

  // Determine position references
  const afterEl = getDropTarget(cardList, e.clientY);

  // Get the cards currently in the list (excluding the dragged card and drop indicators)
  const existingCards = Array.from(cardList.querySelectorAll(".card")).filter(
    (c) => c.dataset.cardId !== cardId
  );

  let afterId = null;
  let beforeId = null;

  if (afterEl && afterEl.classList.contains("card")) {
    // Inserting before afterEl
    beforeId = afterEl.dataset.cardId;
    const idx = existingCards.indexOf(afterEl);
    if (idx > 0) {
      afterId = existingCards[idx - 1].dataset.cardId;
    }
  } else {
    // Appending at end
    if (existingCards.length > 0) {
      afterId = existingCards[existingCards.length - 1].dataset.cardId;
    }
  }

  // Optimistic update: move card in DOM immediately
  if (cardEl.parentNode) {
    cardEl.parentNode.removeChild(cardEl);
  }
  if (afterEl) {
    cardList.insertBefore(cardEl, afterEl);
  } else {
    cardList.appendChild(cardEl);
  }

  // Update internal state optimistically
  optimisticMove(cardId, targetColumnId, afterId, beforeId);

  // Update column header counts
  updateColumnHeaders();

  // Send the move to the server
  moveCard(cardId, targetColumnId, afterId, beforeId).catch((err) => {
    console.error("Move error:", err);
    // On error, refresh from server
    loadBoard();
  });
}

function getDropTarget(cardList, y) {
  const cards = Array.from(cardList.querySelectorAll(".card")).filter(
    (c) => !c.classList.contains("dragging")
  );

  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (y < midY) {
      return card;
    }
  }
  return null; // after all cards
}

function clearDropIndicators() {
  document.querySelectorAll(".drop-indicator").forEach((el) => el.remove());
  document.querySelectorAll(".card-list.drag-over").forEach((el) => el.classList.remove("drag-over"));
}

function optimisticMove(cardId, targetColumnId, afterId, beforeId) {
  // Remove card from current location in state
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

  // Insert into target column at correct position
  const targetCol = boardState.find((c) => c.id === targetColumnId);
  if (!targetCol) return;

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
}

function updateColumnHeaders() {
  for (const col of boardState) {
    const colEl = document.querySelector(`.column[data-column-id="${col.id}"]`);
    if (colEl) {
      const header = colEl.querySelector(".column-header");
      if (header) {
        header.textContent = `${col.title} (${col.cards.length})`;
      }
    }
  }
}

// ─── SSE ────────────────────────────────────────────────────────────────────────
function connectSSE() {
  const statusEl = document.getElementById("connection-status");
  const es = new EventSource(`${API_BASE}/stream`);

  es.addEventListener("connected", () => {
    statusEl.textContent = "Connected";
    statusEl.className = "status connected";
  });

  es.addEventListener("card-created", (e) => {
    const { card } = JSON.parse(e.data);
    handleCardCreated(card);
  });

  es.addEventListener("card-moved", (e) => {
    const { card, oldColumnId } = JSON.parse(e.data);
    handleCardMoved(card, oldColumnId);
  });

  es.addEventListener("card-deleted", (e) => {
    const { cardId, columnId } = JSON.parse(e.data);
    handleCardDeleted(cardId, columnId);
  });

  es.addEventListener("column-sync", (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    handleColumnSync(columnId, cards);
  });

  es.onerror = () => {
    statusEl.textContent = "Disconnected";
    statusEl.className = "status disconnected";
  };

  es.onopen = () => {
    statusEl.textContent = "Connected";
    statusEl.className = "status connected";
  };

  return es;
}

function handleCardCreated(card) {
  const col = boardState.find((c) => c.id === card.column_id);
  if (!col) return;

  // Check if card already exists (optimistic create)
  const existing = col.cards.find((c) => c.id === card.id);
  if (existing) {
    Object.assign(existing, card);
  } else {
    // Insert in position order
    insertCardInOrder(col, card);
  }

  renderColumnCards(col);
  updateColumnHeaders();
}

function handleCardMoved(card, oldColumnId) {
  // Remove card from ALL columns (ensure no duplicates)
  for (const col of boardState) {
    const idx = col.cards.findIndex((c) => c.id === card.id);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      renderColumnCards(col);
    }
  }

  // Add to target column in correct position
  const targetCol = boardState.find((c) => c.id === card.column_id);
  if (targetCol) {
    insertCardInOrder(targetCol, card);
    renderColumnCards(targetCol);
  }

  updateColumnHeaders();
}

function handleCardDeleted(cardId, columnId) {
  // Remove from all columns
  for (const col of boardState) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      renderColumnCards(col);
    }
  }
  updateColumnHeaders();
}

function handleColumnSync(columnId, cards) {
  const col = boardState.find((c) => c.id === columnId);
  if (!col) return;
  col.cards = cards;
  renderColumnCards(col);
  updateColumnHeaders();
}

function insertCardInOrder(col, card) {
  const pos = parseFloat(card.position);
  let inserted = false;
  for (let i = 0; i < col.cards.length; i++) {
    if (parseFloat(col.cards[i].position) > pos) {
      col.cards.splice(i, 0, card);
      inserted = true;
      break;
    }
  }
  if (!inserted) {
    col.cards.push(card);
  }
}

function renderColumnCards(col) {
  const cardListEl = document.querySelector(
    `.card-list[data-column-id="${col.id}"]`
  );
  if (!cardListEl) return;

  // Preserve any active add-card forms - card list doesn't contain them
  cardListEl.innerHTML = "";
  for (const card of col.cards) {
    cardListEl.appendChild(createCardEl(card));
  }
}

// ─── Init ───────────────────────────────────────────────────────────────────────
async function loadBoard() {
  try {
    boardState = await fetchBoard();
    renderBoard();
  } catch (err) {
    console.error("Failed to load board:", err);
  }
}

async function init() {
  await loadBoard();
  connectSSE();
}

init();
