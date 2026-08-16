// ─── API helpers ─────────────────────────────────────────────────
const API_BASE = "/api";

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

// ─── State ───────────────────────────────────────────────────────
let boardState = { columns: [] };
let dragState = null;
let sseConnectedBefore = false;

// ─── DOM references ──────────────────────────────────────────────
const boardEl = document.getElementById("board");
const statusEl = document.getElementById("connection-status");

// ─── Rendering ───────────────────────────────────────────────────
function renderBoard() {
  boardEl.innerHTML = "";
  for (const column of boardState.columns) {
    boardEl.appendChild(renderColumn(column));
  }
}

function renderColumn(column) {
  const colEl = document.createElement("div");
  colEl.className = "column";
  colEl.dataset.columnId = column.id;

  // Header
  const headerEl = document.createElement("div");
  headerEl.className = "column-header";
  headerEl.textContent = `${column.title} (${column.cards.length})`;
  colEl.appendChild(headerEl);

  // Card list
  const listEl = document.createElement("div");
  listEl.className = "card-list";
  listEl.dataset.columnId = column.id;

  for (const card of column.cards) {
    listEl.appendChild(renderCard(card));
  }

  // Drop zone events
  listEl.addEventListener("dragover", handleDragOver);
  listEl.addEventListener("dragleave", handleDragLeave);
  listEl.addEventListener("drop", handleDrop);

  colEl.appendChild(listEl);

  // Add card button / form
  const addArea = document.createElement("div");
  addArea.innerHTML = `<button class="btn-open-form">+ Add a card</button>`;
  const openBtn = addArea.querySelector(".btn-open-form");
  openBtn.addEventListener("click", () => {
    openBtn.style.display = "none";
    const form = createAddCardForm(column.id, () => {
      openBtn.style.display = "block";
      form.remove();
    });
    addArea.appendChild(form);
    form.querySelector("textarea").focus();
  });
  colEl.appendChild(addArea);

  return colEl;
}

function renderCard(card) {
  const cardEl = document.createElement("div");
  cardEl.className = "card";
  cardEl.dataset.cardId = card.id;
  cardEl.dataset.columnId = card.column_id;
  cardEl.draggable = true;

  const textSpan = document.createElement("span");
  textSpan.textContent = card.text;
  cardEl.appendChild(textSpan);

  // Delete button
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "delete-btn";
  deleteBtn.textContent = "×";
  deleteBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    removeCardFromState(card.id);
    renderBoard();
    try {
      await deleteCard(card.id);
    } catch (err) {
      console.error("Delete failed, refetching:", err);
      await refetchBoard();
    }
  });
  cardEl.appendChild(deleteBtn);

  // Drag events
  cardEl.addEventListener("dragstart", handleDragStart);
  cardEl.addEventListener("dragend", handleDragEnd);

  return cardEl;
}

function createAddCardForm(columnId, onClose) {
  const form = document.createElement("div");
  form.className = "add-card-form";
  form.innerHTML = `
    <textarea placeholder="Enter card text…" rows="2"></textarea>
    <div class="form-actions">
      <button class="btn-add">Add Card</button>
      <button class="btn-cancel">Cancel</button>
    </div>
  `;

  const textarea = form.querySelector("textarea");
  const addBtn = form.querySelector(".btn-add");
  const cancelBtn = form.querySelector(".btn-cancel");

  async function submitCard() {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = "";
    try {
      await createCard(columnId, text);
    } catch (err) {
      console.error("Create card failed:", err);
    }
  }

  addBtn.addEventListener("click", submitCard);
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitCard();
    }
    if (e.key === "Escape") {
      onClose();
    }
  });
  cancelBtn.addEventListener("click", onClose);

  return form;
}

// ─── Drag and Drop ───────────────────────────────────────────────
function handleDragStart(e) {
  const cardEl = e.target.closest(".card");
  if (!cardEl) return;

  dragState = {
    cardId: cardEl.dataset.cardId,
    sourceColumnId: cardEl.dataset.columnId,
    cardEl,
  };

  cardEl.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", cardEl.dataset.cardId);
}

function handleDragEnd(_e) {
  // Clean up any drop indicators and drag state
  document.querySelectorAll(".drop-indicator").forEach((el) => el.remove());
  document
    .querySelectorAll(".card-list.drag-over")
    .forEach((el) => el.classList.remove("drag-over"));
  document
    .querySelectorAll(".card.dragging")
    .forEach((el) => el.classList.remove("dragging"));
  dragState = null;
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";

  const listEl = e.currentTarget;
  listEl.classList.add("drag-over");

  // Remove existing drop indicators in this list
  listEl.querySelectorAll(".drop-indicator").forEach((el) => el.remove());

  // Find the card we're hovering over
  const target = getDropTarget(listEl, e.clientY);

  // Show indicator
  const indicator = document.createElement("div");
  indicator.className = "drop-indicator";

  if (target) {
    listEl.insertBefore(indicator, target);
  } else {
    listEl.appendChild(indicator);
  }
}

function handleDragLeave(e) {
  const listEl = e.currentTarget;
  if (!listEl.contains(e.relatedTarget)) {
    listEl.classList.remove("drag-over");
    listEl.querySelectorAll(".drop-indicator").forEach((el) => el.remove());
  }
}

function handleDrop(e) {
  e.preventDefault();
  const listEl = e.currentTarget;
  listEl.classList.remove("drag-over");
  document.querySelectorAll(".drop-indicator").forEach((el) => el.remove());

  if (!dragState) return;

  const targetColumnId = listEl.dataset.columnId;
  const targetCard = getDropTarget(listEl, e.clientY);

  // Get the non-dragging cards in order in this list
  const visibleCards = [
    ...listEl.querySelectorAll(".card:not(.dragging)"),
  ];

  let afterId = null;
  let beforeId = null;

  if (targetCard) {
    // Dropping before targetCard
    beforeId = targetCard.dataset.cardId;
    // afterId is the card before targetCard (excluding the dragged card)
    const idx = visibleCards.indexOf(targetCard);
    if (idx > 0) {
      afterId = visibleCards[idx - 1].dataset.cardId;
    }
  } else {
    // Dropping at the end
    if (visibleCards.length > 0) {
      afterId = visibleCards[visibleCards.length - 1].dataset.cardId;
    }
  }

  // Skip self-referencing
  if (afterId === dragState.cardId) afterId = null;
  if (beforeId === dragState.cardId) beforeId = null;

  // Check if this is a no-op (same position in same column)
  const sourceCol = boardState.columns.find(
    (c) => c.id === dragState.sourceColumnId
  );
  if (sourceCol && targetColumnId === dragState.sourceColumnId) {
    const cardIndex = sourceCol.cards.findIndex(
      (c) => c.id === dragState.cardId
    );
    if (cardIndex >= 0) {
      const prevCard = cardIndex > 0 ? sourceCol.cards[cardIndex - 1] : null;
      const nextCard =
        cardIndex < sourceCol.cards.length - 1
          ? sourceCol.cards[cardIndex + 1]
          : null;
      const prevId = prevCard ? prevCard.id : null;
      const nextId = nextCard ? nextCard.id : null;

      if (afterId === prevId && beforeId === nextId) {
        // No actual movement needed
        return;
      }
    }
  }

  const cardId = dragState.cardId;
  const sourceColumnId = dragState.sourceColumnId;

  // Optimistic update
  optimisticMove(cardId, sourceColumnId, targetColumnId, afterId, beforeId);

  // Send to server
  moveCard(cardId, targetColumnId, afterId || null, beforeId || null).catch(
    async (err) => {
      console.error("Move failed, refetching:", err);
      await refetchBoard();
    }
  );
}

function getDropTarget(listEl, y) {
  const cards = [...listEl.querySelectorAll(".card:not(.dragging)")];
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (y < midY) {
      return card;
    }
  }
  return null;
}

// ─── Optimistic updates ──────────────────────────────────────────
function optimisticMove(
  cardId,
  sourceColumnId,
  targetColumnId,
  afterId,
  beforeId
) {
  const card = removeCardFromState(cardId);
  if (!card) return;

  card.column_id = targetColumnId;

  const targetColumn = boardState.columns.find(
    (c) => c.id === targetColumnId
  );
  if (!targetColumn) return;

  // Find insertion index
  let insertIndex = targetColumn.cards.length;
  if (beforeId) {
    const idx = targetColumn.cards.findIndex((c) => c.id === beforeId);
    if (idx >= 0) insertIndex = idx;
  } else if (afterId) {
    const idx = targetColumn.cards.findIndex((c) => c.id === afterId);
    if (idx >= 0) insertIndex = idx + 1;
  }

  targetColumn.cards.splice(insertIndex, 0, card);
  renderBoard();
}

function removeCardFromState(cardId) {
  for (const col of boardState.columns) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx >= 0) {
      return col.cards.splice(idx, 1)[0];
    }
  }
  return null;
}

function findCardInState(cardId) {
  for (const col of boardState.columns) {
    const card = col.cards.find((c) => c.id === cardId);
    if (card) return card;
  }
  return null;
}

// ─── SSE connection ──────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource(`${API_BASE}/stream`);

  es.onopen = () => {
    statusEl.textContent = "Connected";
    statusEl.className = "status connected";
    // If this is a reconnection, refetch the full board to catch missed events
    if (sseConnectedBefore) {
      refetchBoard();
    }
    sseConnectedBefore = true;
  };

  es.onerror = () => {
    statusEl.textContent = "Disconnected";
    statusEl.className = "status disconnected";
    // EventSource will auto-reconnect
  };

  es.addEventListener("card-created", (e) => {
    const { card } = JSON.parse(e.data);
    handleCardCreated(card);
  });

  es.addEventListener("card-moved", (e) => {
    const { card, oldColumnId } = JSON.parse(e.data);
    handleCardMoved(card, oldColumnId);
  });

  es.addEventListener("card-deleted", (e) => {
    const { cardId } = JSON.parse(e.data);
    removeCardFromState(cardId);
    renderBoard();
  });

  es.addEventListener("column-renormalized", (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    handleColumnRenormalized(columnId, cards);
  });

  return es;
}

function handleCardCreated(card) {
  // Check if we already have this card
  const existing = findCardInState(card.id);
  if (existing) {
    // Update in place with canonical data
    Object.assign(existing, card);
    // May need to re-sort
    const col = boardState.columns.find((c) => c.id === card.column_id);
    if (col) col.cards.sort((a, b) => a.position - b.position);
  } else {
    const col = boardState.columns.find((c) => c.id === card.column_id);
    if (col) {
      col.cards.push(card);
      col.cards.sort((a, b) => a.position - b.position);
    }
  }
  renderBoard();
}

function handleCardMoved(card, _oldColumnId) {
  // Remove from wherever it currently is
  removeCardFromState(card.id);

  // Add to its canonical column
  const col = boardState.columns.find((c) => c.id === card.column_id);
  if (col) {
    col.cards.push(card);
    col.cards.sort((a, b) => a.position - b.position);
  }
  renderBoard();
}

function handleColumnRenormalized(columnId, cards) {
  const col = boardState.columns.find((c) => c.id === columnId);
  if (!col) return;

  for (const update of cards) {
    const card = col.cards.find((c) => c.id === update.id);
    if (card) {
      card.position = update.position;
    }
  }
  col.cards.sort((a, b) => a.position - b.position);
  renderBoard();
}

// ─── Full refetch ────────────────────────────────────────────────
async function refetchBoard() {
  try {
    const data = await fetchBoard();
    boardState = data;
    renderBoard();
  } catch (err) {
    console.error("Refetch failed:", err);
  }
}

// ─── Init ────────────────────────────────────────────────────────
async function init() {
  try {
    const data = await fetchBoard();
    boardState = data;
    renderBoard();
    connectSSE();
  } catch (err) {
    console.error("Initial load failed:", err);
    boardEl.innerHTML =
      '<div style="color:#fff;padding:40px;text-align:center;">Failed to load board. Make sure the backend is running.</div>';
    setTimeout(init, 3000);
  }
}

init();
