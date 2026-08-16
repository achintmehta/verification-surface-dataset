// ─── State ────────────────────────────────────────────────────────────────────

let boardState = { columns: [] }; // authoritative local mirror
let dragState = null; // { cardId, sourceColumnId }
let pendingMoves = new Set(); // card IDs with in-flight move requests

const API_BASE = "/api";

// ─── DOM References ───────────────────────────────────────────────────────────

const boardEl = document.getElementById("board");
const statusEl = document.getElementById("connection-status");

// ─── API Helpers ──────────────────────────────────────────────────────────────

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

async function moveCardApi(cardId, columnId, afterId, beforeId) {
  const res = await fetch(`${API_BASE}/cards/${cardId}/move`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      columnId,
      afterId: afterId || null,
      beforeId: beforeId || null,
    }),
  });
  if (!res.ok) throw new Error("Failed to move card");
  return res.json();
}

async function deleteCardApi(cardId) {
  const res = await fetch(`${API_BASE}/cards/${cardId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete card");
  return res.json();
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderBoard() {
  // Preserve open add-card forms
  const openForms = new Set();
  for (const el of boardEl.querySelectorAll(".add-card-input-container.active")) {
    const col = el.closest(".column");
    if (col) openForms.add(col.dataset.columnId);
  }

  boardEl.innerHTML = "";
  for (const col of boardState.columns) {
    boardEl.appendChild(renderColumn(col, openForms.has(col.id)));
  }
}

function renderColumn(col, formOpen = false) {
  const colEl = document.createElement("div");
  colEl.className = "column";
  colEl.dataset.columnId = col.id;

  const headerEl = document.createElement("div");
  headerEl.className = "column-header";
  headerEl.textContent = `${col.title} (${col.cards.length})`;
  colEl.appendChild(headerEl);

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
  colEl.appendChild(renderAddCardForm(col.id, formOpen));

  return colEl;
}

function renderCard(card) {
  const cardEl = document.createElement("div");
  cardEl.className = "card";
  if (pendingMoves.has(card.id)) {
    cardEl.classList.add("optimistic");
  }
  cardEl.dataset.cardId = card.id;
  cardEl.draggable = true;

  const textSpan = document.createElement("span");
  textSpan.textContent = card.text;
  cardEl.appendChild(textSpan);

  // Delete button
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "card-delete";
  deleteBtn.textContent = "✕";
  deleteBtn.title = "Delete card";
  deleteBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      await deleteCardApi(card.id);
    } catch (err) {
      console.error("Delete failed:", err);
    }
  });
  cardEl.appendChild(deleteBtn);

  // Drag events
  cardEl.addEventListener("dragstart", (e) => {
    dragState = {
      cardId: card.id,
      sourceColumnId: card.column_id,
    };
    cardEl.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", card.id);
  });

  cardEl.addEventListener("dragend", () => {
    cardEl.classList.remove("dragging");
    clearAllDropIndicators();
    dragState = null;
  });

  return cardEl;
}

function renderAddCardForm(columnId, startOpen = false) {
  const formWrapper = document.createElement("div");
  formWrapper.className = "add-card-form";

  const addBtn = document.createElement("button");
  addBtn.className = "add-card-btn";
  addBtn.textContent = "+ Add a card";

  const inputContainer = document.createElement("div");
  inputContainer.className = "add-card-input-container";

  const textarea = document.createElement("textarea");
  textarea.placeholder = "Enter card text...";

  const actions = document.createElement("div");
  actions.className = "add-card-actions";

  const submitBtn = document.createElement("button");
  submitBtn.className = "add-card-submit";
  submitBtn.textContent = "Add Card";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "add-card-cancel";
  cancelBtn.textContent = "✕";

  actions.appendChild(submitBtn);
  actions.appendChild(cancelBtn);
  inputContainer.appendChild(textarea);
  inputContainer.appendChild(actions);

  const openForm = () => {
    addBtn.style.display = "none";
    inputContainer.classList.add("active");
    textarea.focus();
  };

  const closeForm = () => {
    addBtn.style.display = "";
    inputContainer.classList.remove("active");
    textarea.value = "";
  };

  addBtn.addEventListener("click", openForm);
  cancelBtn.addEventListener("click", closeForm);

  const submitCard = async () => {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = "";
    try {
      await createCard(columnId, text);
    } catch (err) {
      console.error("Create card failed:", err);
    }
  };

  submitBtn.addEventListener("click", submitCard);
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitCard();
    }
    if (e.key === "Escape") {
      closeForm();
    }
  });

  formWrapper.appendChild(addBtn);
  formWrapper.appendChild(inputContainer);

  if (startOpen) {
    // Defer so the DOM is inserted first
    requestAnimationFrame(openForm);
  }

  return formWrapper;
}

// ─── Drag and Drop ────────────────────────────────────────────────────────────

function handleDragOver(e) {
  if (!dragState) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";

  const listEl = e.currentTarget;
  listEl.classList.add("drag-over");

  // Determine drop position and show indicator
  clearAllDropIndicators();

  const afterElement = getDragAfterElement(listEl, e.clientY);
  const indicator = getOrCreateDropIndicator();

  if (afterElement) {
    listEl.insertBefore(indicator, afterElement);
  } else {
    listEl.appendChild(indicator);
  }
}

function handleDragLeave(e) {
  const listEl = e.currentTarget;
  // Only remove if actually leaving the list
  if (!listEl.contains(e.relatedTarget)) {
    listEl.classList.remove("drag-over");
    clearAllDropIndicators();
  }
}

function handleDrop(e) {
  e.preventDefault();

  const listEl = e.currentTarget;
  listEl.classList.remove("drag-over");
  clearAllDropIndicators();

  if (!dragState) return;

  const targetColumnId = listEl.dataset.columnId;
  const { cardId, sourceColumnId } = dragState;
  const afterElement = getDragAfterElement(listEl, e.clientY);

  // Get all non-dragging cards in this list
  const cardEls = Array.from(
    listEl.querySelectorAll(".card:not(.dragging)")
  );

  let afterId = null;
  let beforeId = null;

  if (afterElement) {
    // We're inserting before `afterElement`
    beforeId = afterElement.dataset.cardId;
    const idx = cardEls.indexOf(afterElement);
    if (idx > 0) {
      afterId = cardEls[idx - 1].dataset.cardId;
    }
  } else {
    // Inserting at the end
    if (cardEls.length > 0) {
      afterId = cardEls[cardEls.length - 1].dataset.cardId;
    }
  }

  // Check if position actually changed
  if (targetColumnId === sourceColumnId) {
    const col = boardState.columns.find((c) => c.id === sourceColumnId);
    if (col) {
      const cards = col.cards;
      const currentIdx = cards.findIndex((c) => c.id === cardId);

      // Determine target index
      let targetIdx;
      if (beforeId) {
        targetIdx = cards.findIndex((c) => c.id === beforeId);
        // If current card is before the target, account for removal
        if (currentIdx < targetIdx) targetIdx--;
      } else if (afterId) {
        targetIdx = cards.findIndex((c) => c.id === afterId);
        if (currentIdx <= targetIdx) {
          // After removing current card, afterId shifts down
        } else {
          targetIdx++;
        }
      } else {
        targetIdx = 0;
      }

      if (currentIdx === targetIdx) {
        return; // No change
      }
    }
  }

  // Optimistic update: move card in local state and re-render
  optimisticMoveCard(cardId, sourceColumnId, targetColumnId, afterId, beforeId);

  // Mark as pending
  pendingMoves.add(cardId);

  // Send to server
  moveCardApi(cardId, targetColumnId, afterId, beforeId)
    .then(() => {
      pendingMoves.delete(cardId);
    })
    .catch((err) => {
      console.error("Move failed, refetching board:", err);
      pendingMoves.delete(cardId);
      loadBoard(); // fallback: reload board on error
    });
}

function getDragAfterElement(listEl, y) {
  const cards = Array.from(
    listEl.querySelectorAll(".card:not(.dragging)")
  );

  let closest = null;
  let closestOffset = Number.POSITIVE_INFINITY;

  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    const offset = y - rect.top - rect.height / 2;
    if (offset < 0 && Math.abs(offset) < closestOffset) {
      closest = card;
      closestOffset = Math.abs(offset);
    }
  }

  return closest;
}

let dropIndicator = null;

function getOrCreateDropIndicator() {
  if (!dropIndicator) {
    dropIndicator = document.createElement("div");
    dropIndicator.className = "drop-indicator";
  }
  return dropIndicator;
}

function clearAllDropIndicators() {
  if (dropIndicator && dropIndicator.parentNode) {
    dropIndicator.parentNode.removeChild(dropIndicator);
  }
}

// ─── Optimistic Updates ───────────────────────────────────────────────────────

function optimisticMoveCard(
  cardId,
  sourceColumnId,
  targetColumnId,
  afterId,
  beforeId
) {
  // Find and remove card from source
  const sourceCol = boardState.columns.find((c) => c.id === sourceColumnId);
  const targetCol = boardState.columns.find((c) => c.id === targetColumnId);
  if (!sourceCol || !targetCol) return;

  const cardIdx = sourceCol.cards.findIndex((c) => c.id === cardId);
  if (cardIdx === -1) return;

  const [card] = sourceCol.cards.splice(cardIdx, 1);
  card.column_id = targetColumnId;

  // Find insertion index in target column
  let insertIdx = targetCol.cards.length; // default: end

  if (beforeId) {
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

  renderBoard();
}

// ─── SSE Connection ───────────────────────────────────────────────────────────

let eventSource = null;

function connectSSE() {
  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.onopen = () => {
    statusEl.textContent = "Connected";
    statusEl.className = "status connected";
  };

  eventSource.onerror = () => {
    statusEl.textContent = "Disconnected";
    statusEl.className = "status disconnected";
    // EventSource will auto-reconnect
  };

  eventSource.addEventListener("card:created", (e) => {
    const { card } = JSON.parse(e.data);
    handleCardCreated(card);
  });

  eventSource.addEventListener("card:moved", (e) => {
    const { card } = JSON.parse(e.data);
    handleCardMoved(card);
  });

  eventSource.addEventListener("card:deleted", (e) => {
    const { id, columnId } = JSON.parse(e.data);
    handleCardDeleted(id);
  });

  eventSource.addEventListener("column:renormalized", (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    handleColumnRenormalized(columnId, cards);
  });
}

// ─── SSE Event Handlers ──────────────────────────────────────────────────────

function handleCardCreated(card) {
  const col = boardState.columns.find((c) => c.id === card.column_id);
  if (!col) return;

  // Check if card already exists (in case of duplicate events or optimistic add)
  const existingIdx = col.cards.findIndex((c) => c.id === card.id);
  if (existingIdx !== -1) {
    // Update existing with canonical data
    col.cards[existingIdx] = card;
  } else {
    // Also check other columns (shouldn't happen for create, but be safe)
    for (const otherCol of boardState.columns) {
      const idx = otherCol.cards.findIndex((c) => c.id === card.id);
      if (idx !== -1) {
        otherCol.cards.splice(idx, 1);
      }
    }
    col.cards.push(card);
  }

  // Sort by position
  col.cards.sort((a, b) => parseFloat(a.position) - parseFloat(b.position));

  renderBoard();
}

function handleCardMoved(card) {
  // Remove pending state
  pendingMoves.delete(card.id);

  // Remove card from ALL columns
  for (const col of boardState.columns) {
    const idx = col.cards.findIndex((c) => c.id === card.id);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
    }
  }

  // Add to target column with canonical data
  const targetCol = boardState.columns.find((c) => c.id === card.column_id);
  if (!targetCol) return;

  targetCol.cards.push(card);
  targetCol.cards.sort(
    (a, b) => parseFloat(a.position) - parseFloat(b.position)
  );

  renderBoard();
}

function handleCardDeleted(cardId) {
  // Remove from all columns
  for (const col of boardState.columns) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
    }
  }
  renderBoard();
}

function handleColumnRenormalized(columnId, cards) {
  const col = boardState.columns.find((c) => c.id === columnId);
  if (!col) return;

  // Replace all cards in this column with the server's canonical order
  col.cards = cards;
  col.cards.sort(
    (a, b) => parseFloat(a.position) - parseFloat(b.position)
  );

  renderBoard();
}

// ─── Initial Load ─────────────────────────────────────────────────────────────

async function loadBoard() {
  try {
    const data = await fetchBoard();
    boardState = data;
    renderBoard();
  } catch (err) {
    console.error("Failed to load board:", err);
    boardEl.innerHTML =
      '<div style="padding:20px;color:red;">Failed to load board. Is the server running?</div>';
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function init() {
  await loadBoard();
  connectSSE();
}

init();
