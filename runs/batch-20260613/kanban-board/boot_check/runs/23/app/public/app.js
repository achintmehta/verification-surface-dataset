// ─── State ──────────────────────────────────────────────────────────────────
const API_BASE = window.location.origin;
let boardState = []; // Array of { id, title, position, cards: [] }
let dragState = null; // { cardId, sourceColumnId, cardEl }

// ─── DOM References ─────────────────────────────────────────────────────────
const boardEl = document.getElementById("board");
const statusEl = document.getElementById("connection-status");

// ─── API Functions ──────────────────────────────────────────────────────────

async function fetchBoard() {
  const res = await fetch(`${API_BASE}/api/board`);
  if (!res.ok) throw new Error("Failed to fetch board");
  return res.json();
}

async function createCard(columnId, text) {
  const res = await fetch(`${API_BASE}/api/cards`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ columnId, text }),
  });
  if (!res.ok) throw new Error("Failed to create card");
  return res.json();
}

async function moveCard(cardId, columnId, afterId, beforeId) {
  const res = await fetch(`${API_BASE}/api/cards/${cardId}/move`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ columnId, afterId: afterId || null, beforeId: beforeId || null }),
  });
  if (!res.ok) throw new Error("Failed to move card");
  return res.json();
}

async function deleteCard(cardId) {
  const res = await fetch(`${API_BASE}/api/cards/${cardId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete card");
  return res.json();
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function renderBoard() {
  boardEl.innerHTML = "";
  for (const column of boardState) {
    boardEl.appendChild(renderColumn(column));
  }
}

function renderColumn(column) {
  const colEl = document.createElement("div");
  colEl.className = "column";
  colEl.dataset.columnId = column.id;

  const headerEl = document.createElement("div");
  headerEl.className = "column-header";
  headerEl.textContent = column.title;
  colEl.appendChild(headerEl);

  const listEl = document.createElement("div");
  listEl.className = "cards-list";
  listEl.dataset.columnId = column.id;

  for (const card of column.cards) {
    listEl.appendChild(renderCard(card));
  }

  // Drag-and-drop events on the list
  listEl.addEventListener("dragover", handleDragOver);
  listEl.addEventListener("dragleave", handleDragLeave);
  listEl.addEventListener("drop", handleDrop);

  colEl.appendChild(listEl);

  // Add card area
  const addArea = document.createElement("div");
  addArea.className = "add-card-area";

  const addBtn = document.createElement("button");
  addBtn.className = "add-card-btn";
  addBtn.textContent = "+ Add a card";

  const form = document.createElement("div");
  form.className = "add-card-form";
  form.innerHTML = `
    <textarea placeholder="Enter a title for this card..." rows="2"></textarea>
    <div class="form-actions">
      <button class="btn-primary">Add Card</button>
      <button class="btn-cancel">Cancel</button>
    </div>
  `;

  addBtn.addEventListener("click", () => {
    form.classList.add("active");
    addBtn.style.display = "none";
    const textarea = form.querySelector("textarea");
    textarea.value = "";
    textarea.focus();
  });

  const cancelBtn = form.querySelector(".btn-cancel");
  cancelBtn.addEventListener("click", () => {
    form.classList.remove("active");
    addBtn.style.display = "";
  });

  const submitBtn = form.querySelector(".btn-primary");
  const textarea = form.querySelector("textarea");

  submitBtn.addEventListener("click", async () => {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = "";
    try {
      await createCard(column.id, text);
    } catch (e) {
      console.error("Error creating card:", e);
    }
  });

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitBtn.click();
    }
    if (e.key === "Escape") {
      cancelBtn.click();
    }
  });

  addArea.appendChild(addBtn);
  addArea.appendChild(form);
  colEl.appendChild(addArea);

  return colEl;
}

function renderCard(card) {
  const cardEl = document.createElement("div");
  cardEl.className = "card";
  cardEl.dataset.cardId = card.id;
  cardEl.draggable = true;
  cardEl.textContent = card.text;

  // Delete button
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "delete-btn";
  deleteBtn.textContent = "×";
  deleteBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await deleteCard(card.id);
    } catch (err) {
      console.error("Error deleting card:", err);
    }
  });
  cardEl.appendChild(deleteBtn);

  // Drag start
  cardEl.addEventListener("dragstart", (e) => {
    dragState = {
      cardId: card.id,
      sourceColumnId: card.column_id,
      cardEl,
    };
    cardEl.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", card.id);
  });

  cardEl.addEventListener("dragend", () => {
    cardEl.classList.remove("dragging");
    clearDropIndicators();
    dragState = null;
  });

  return cardEl;
}

// ─── Drag-and-Drop Handling ─────────────────────────────────────────────────

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";

  const listEl = e.currentTarget;
  clearDropIndicators();

  const afterElement = getDragAfterElement(listEl, e.clientY);
  const indicator = document.createElement("div");
  indicator.className = "drop-indicator";

  if (afterElement) {
    listEl.insertBefore(indicator, afterElement);
  } else {
    listEl.appendChild(indicator);
  }
}

function handleDragLeave(e) {
  // Only clear if we actually left the list
  const listEl = e.currentTarget;
  const relatedTarget = e.relatedTarget;
  if (!listEl.contains(relatedTarget)) {
    clearDropIndicators();
  }
}

function handleDrop(e) {
  e.preventDefault();
  clearDropIndicators();

  if (!dragState) return;

  const listEl = e.currentTarget;
  const targetColumnId = listEl.dataset.columnId;
  const afterElement = getDragAfterElement(listEl, e.clientY);

  // Determine afterId (card above) and beforeId (card below)
  let afterId = null;
  let beforeId = null;

  if (afterElement) {
    beforeId = afterElement.dataset.cardId;
    // afterId is the sibling before `afterElement` (excluding the dragging card)
    const prev = getPreviousCardSibling(afterElement);
    if (prev && prev.dataset.cardId !== dragState.cardId) {
      afterId = prev.dataset.cardId;
    }
  } else {
    // Dropped at the end
    const lastCard = getLastCardInList(listEl);
    if (lastCard && lastCard.dataset.cardId !== dragState.cardId) {
      afterId = lastCard.dataset.cardId;
    }
  }

  // If beforeId is the dragged card, skip it and take the next
  if (beforeId === dragState.cardId) {
    const nextSib = getNextCardSibling(afterElement);
    beforeId = nextSib ? nextSib.dataset.cardId : null;
  }

  // Optimistic UI: move card in DOM immediately
  const cardEl = dragState.cardEl;
  cardEl.classList.remove("dragging");
  cardEl.classList.add("optimistic");

  if (afterElement) {
    listEl.insertBefore(cardEl, afterElement);
  } else {
    listEl.appendChild(cardEl);
  }

  const { cardId } = dragState;
  dragState = null;

  // Send move to server
  moveCard(cardId, targetColumnId, afterId, beforeId)
    .then(() => {
      cardEl.classList.remove("optimistic");
    })
    .catch((err) => {
      console.error("Move failed, reloading board:", err);
      cardEl.classList.remove("optimistic");
      loadBoard();
    });
}

function getDragAfterElement(list, y) {
  const cards = [...list.querySelectorAll(".card:not(.dragging)")];
  let closest = null;
  let closestOffset = Number.POSITIVE_INFINITY;

  for (const card of cards) {
    const box = card.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > -closestOffset) {
      // We want the first card whose midpoint is below the cursor
    }
    if (offset < 0 && Math.abs(offset) < closestOffset) {
      closestOffset = Math.abs(offset);
      closest = card;
    }
  }

  return closest;
}

function getPreviousCardSibling(el) {
  let prev = el.previousElementSibling;
  while (prev) {
    if (prev.classList.contains("card") && !prev.classList.contains("dragging")) return prev;
    prev = prev.previousElementSibling;
  }
  return null;
}

function getNextCardSibling(el) {
  let next = el.nextElementSibling;
  while (next) {
    if (next.classList.contains("card") && !next.classList.contains("dragging")) return next;
    next = next.nextElementSibling;
  }
  return null;
}

function getLastCardInList(listEl) {
  const cards = listEl.querySelectorAll(".card:not(.dragging)");
  return cards.length > 0 ? cards[cards.length - 1] : null;
}

function clearDropIndicators() {
  document.querySelectorAll(".drop-indicator").forEach((el) => el.remove());
}

// ─── State Management ───────────────────────────────────────────────────────

function findColumn(columnId) {
  return boardState.find((c) => c.id === columnId);
}

function removeCardFromState(cardId) {
  for (const col of boardState) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      return;
    }
  }
}

function addCardToColumnState(card) {
  const col = findColumn(card.column_id);
  if (!col) return;

  // Remove if already present elsewhere
  removeCardFromState(card.id);

  // Insert in correct position order
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

// ─── SSE Event Handling ─────────────────────────────────────────────────────

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

  es.addEventListener("card_created", (e) => {
    const card = JSON.parse(e.data);
    addCardToColumnState(card);
    renderBoard();
  });

  es.addEventListener("card_moved", (e) => {
    const { card, oldColumnId } = JSON.parse(e.data);
    // Remove from old location
    removeCardFromState(card.id);
    // Add to new position
    addCardToColumnState(card);
    renderBoard();
  });

  es.addEventListener("card_deleted", (e) => {
    const { id } = JSON.parse(e.data);
    removeCardFromState(id);
    renderBoard();
  });

  es.addEventListener("renormalize", (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    const col = findColumn(columnId);
    if (col) {
      // Remove all cards of this column from state, replace with server's
      col.cards = cards;
      renderBoard();
    }
  });

  return es;
}

// ─── Initialization ─────────────────────────────────────────────────────────

async function loadBoard() {
  try {
    boardState = await fetchBoard();
    renderBoard();
  } catch (err) {
    console.error("Failed to load board:", err);
    boardEl.innerHTML = '<p style="color:white;padding:20px;">Failed to load board. Is the server running?</p>';
  }
}

async function init() {
  await loadBoard();
  connectSSE();
}

init();
