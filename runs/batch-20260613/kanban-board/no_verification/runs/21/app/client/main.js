// ---------------------------------------------------------------------------
// Kanban Board – Vanilla JS Client
// ---------------------------------------------------------------------------

const API_BASE = "/api";
const boardEl = document.getElementById("board");
const statusEl = document.getElementById("connection-status");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let boardState = []; // Array of { id, title, position, cards: [...] }
let draggedCardId = null;
let draggedCardEl = null;

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
    body: JSON.stringify({ columnId, afterId: afterId || null, beforeId: beforeId || null }),
  });
  if (!res.ok) throw new Error("Failed to move card");
  return res.json();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  boardEl.innerHTML = "";
  for (const column of boardState) {
    boardEl.appendChild(renderColumn(column));
  }
}

function renderColumn(column) {
  const colEl = document.createElement("div");
  colEl.className = "column";
  colEl.dataset.columnId = column.id;

  // Header
  const header = document.createElement("div");
  header.className = "column-header";
  header.innerHTML = `
    <span>${escapeHtml(column.title)}</span>
    <span class="card-count">${column.cards.length}</span>
  `;
  colEl.appendChild(header);

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
  addArea.innerHTML = `
    <button class="add-card-btn" data-column-id="${column.id}">+ Add a card</button>
  `;
  addArea.querySelector(".add-card-btn").addEventListener("click", () => {
    showAddCardForm(colEl, column.id);
  });
  colEl.appendChild(addArea);

  return colEl;
}

function renderCard(card) {
  const el = document.createElement("div");
  el.className = "card";
  el.dataset.cardId = card.id;
  el.draggable = true;
  el.textContent = card.text;

  el.addEventListener("dragstart", handleDragStart);
  el.addEventListener("dragend", handleDragEnd);

  return el;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Add card form
// ---------------------------------------------------------------------------

function showAddCardForm(colEl, columnId) {
  // Remove any existing form in this column
  const existing = colEl.querySelector(".add-card-form");
  if (existing) existing.remove();

  // Hide the add button
  const btn = colEl.querySelector(".add-card-btn");
  if (btn) btn.style.display = "none";

  const form = document.createElement("div");
  form.className = "add-card-form";
  form.innerHTML = `
    <textarea placeholder="Enter a title for this card..." autofocus></textarea>
    <div class="form-actions">
      <button class="btn btn-primary">Add Card</button>
      <button class="btn btn-secondary cancel-btn">Cancel</button>
    </div>
  `;

  const textarea = form.querySelector("textarea");
  const addBtn = form.querySelector(".btn-primary");
  const cancelBtn = form.querySelector(".cancel-btn");

  const close = () => {
    form.remove();
    if (btn) btn.style.display = "";
  };

  addBtn.addEventListener("click", async () => {
    const text = textarea.value.trim();
    if (!text) return;
    addBtn.disabled = true;
    try {
      await createCard(columnId, text);
      close();
    } catch (err) {
      console.error(err);
      addBtn.disabled = false;
    }
  });

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      addBtn.click();
    }
    if (e.key === "Escape") {
      close();
    }
  });

  cancelBtn.addEventListener("click", close);

  // Insert before the add button's parent
  const listEl = colEl.querySelector(".card-list");
  colEl.insertBefore(form, listEl.nextSibling);

  textarea.focus();
}

// ---------------------------------------------------------------------------
// Drag and Drop
// ---------------------------------------------------------------------------

function handleDragStart(e) {
  draggedCardId = e.target.dataset.cardId;
  draggedCardEl = e.target;
  e.target.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", draggedCardId);
}

function handleDragEnd(e) {
  e.target.classList.remove("dragging");
  draggedCardEl = null;
  // Clean up all indicators
  document.querySelectorAll(".drop-indicator-before, .drop-indicator-after, .drag-over").forEach(
    (el) => {
      el.classList.remove("drop-indicator-before", "drop-indicator-after", "drag-over");
    }
  );
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";

  const listEl = e.currentTarget;
  listEl.classList.add("drag-over");

  // Clear previous indicators
  listEl.querySelectorAll(".drop-indicator-before, .drop-indicator-after").forEach((el) => {
    el.classList.remove("drop-indicator-before", "drop-indicator-after");
  });

  const target = getClosestCard(e, listEl);
  if (target && target.el && target.el.dataset.cardId !== draggedCardId) {
    if (target.position === "before") {
      target.el.classList.add("drop-indicator-before");
    } else {
      target.el.classList.add("drop-indicator-after");
    }
  }
}

function handleDragLeave(e) {
  const listEl = e.currentTarget;
  // Only remove if we actually left the list
  if (!listEl.contains(e.relatedTarget)) {
    listEl.classList.remove("drag-over");
    listEl.querySelectorAll(".drop-indicator-before, .drop-indicator-after").forEach((el) => {
      el.classList.remove("drop-indicator-before", "drop-indicator-after");
    });
  }
}

function handleDrop(e) {
  e.preventDefault();
  const listEl = e.currentTarget;
  listEl.classList.remove("drag-over");
  listEl.querySelectorAll(".drop-indicator-before, .drop-indicator-after").forEach((el) => {
    el.classList.remove("drop-indicator-before", "drop-indicator-after");
  });

  const cardId = e.dataTransfer.getData("text/plain");
  if (!cardId) return;

  const columnId = listEl.dataset.columnId;
  const cardEls = Array.from(listEl.querySelectorAll(".card")).filter(
    (el) => el.dataset.cardId !== cardId
  );

  const target = getClosestCard(e, listEl);

  let insertIndex;
  if (!target || cardEls.length === 0) {
    insertIndex = cardEls.length; // append to end
  } else {
    const targetIndex = cardEls.indexOf(target.el);
    if (target.position === "before") {
      insertIndex = targetIndex;
    } else {
      insertIndex = targetIndex + 1;
    }
  }

  // Determine afterId and beforeId
  const afterId = insertIndex > 0 ? cardEls[insertIndex - 1]?.dataset.cardId : null;
  const beforeId = insertIndex < cardEls.length ? cardEls[insertIndex]?.dataset.cardId : null;

  // Optimistic update: move card in state and re-render
  optimisticMove(cardId, columnId, insertIndex);

  // Send to server
  moveCard(cardId, columnId, afterId, beforeId).catch((err) => {
    console.error("Move failed, refetching board:", err);
    refetchBoard();
  });
}

function getClosestCard(e, listEl) {
  const cards = Array.from(listEl.querySelectorAll(".card")).filter(
    (el) => el.dataset.cardId !== draggedCardId
  );

  if (cards.length === 0) return null;

  let closest = null;
  let closestDist = Infinity;
  let closestPosition = "after";

  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const dist = Math.abs(e.clientY - midY);

    if (dist < closestDist) {
      closestDist = dist;
      closest = card;
      closestPosition = e.clientY < midY ? "before" : "after";
    }
  }

  return { el: closest, position: closestPosition };
}

// ---------------------------------------------------------------------------
// Optimistic Updates
// ---------------------------------------------------------------------------

function optimisticMove(cardId, targetColumnId, insertIndex) {
  // Find and remove card from current column
  let card = null;
  for (const col of boardState) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) {
      card = col.cards.splice(idx, 1)[0];
      break;
    }
  }
  if (!card) return;

  // Insert into target column at the given index
  const targetCol = boardState.find((c) => c.id === targetColumnId);
  if (!targetCol) return;

  card.column_id = targetColumnId;
  targetCol.cards.splice(insertIndex, 0, card);

  render();
}

// ---------------------------------------------------------------------------
// SSE – Real-time updates
// ---------------------------------------------------------------------------

function connectSSE() {
  const source = new EventSource(`${API_BASE}/stream`);
  let wasConnected = false;

  source.onopen = () => {
    statusEl.textContent = "Connected";
    statusEl.className = "status connected";
    // If this is a reconnection, refetch to catch any missed events
    if (wasConnected) {
      refetchBoard();
    }
    wasConnected = true;
  };

  source.onerror = () => {
    statusEl.textContent = "Disconnected";
    statusEl.className = "status disconnected";
    // EventSource will auto-reconnect
  };

  source.addEventListener("card:created", (e) => {
    const { card } = JSON.parse(e.data);
    handleCardCreated(card);
  });

  source.addEventListener("card:moved", (e) => {
    const { card, sourceColumnId } = JSON.parse(e.data);
    handleCardMoved(card, sourceColumnId);
  });

  source.addEventListener("column:renormalized", (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    handleColumnRenormalized(columnId, cards);
  });
}

function handleCardCreated(card) {
  const col = boardState.find((c) => c.id === card.column_id);
  if (!col) return;

  // Avoid duplicate
  const existingIdx = col.cards.findIndex((c) => c.id === card.id);
  if (existingIdx !== -1) {
    // Update in place
    col.cards[existingIdx] = card;
  } else {
    col.cards.push(card);
  }

  // Sort by position
  col.cards.sort((a, b) => a.position - b.position);
  render();
}

function handleCardMoved(card, sourceColumnId) {
  // Remove card from ALL columns (ensures no duplication)
  for (const col of boardState) {
    col.cards = col.cards.filter((c) => c.id !== card.id);
  }

  // Add to target column
  const targetCol = boardState.find((c) => c.id === card.column_id);
  if (targetCol) {
    targetCol.cards.push(card);
    targetCol.cards.sort((a, b) => a.position - b.position);
  }

  render();
}

function handleColumnRenormalized(columnId, cards) {
  const col = boardState.find((c) => c.id === columnId);
  if (!col) return;

  // Update positions
  for (const update of cards) {
    const card = col.cards.find((c) => c.id === update.id);
    if (card) {
      card.position = update.position;
    }
  }

  col.cards.sort((a, b) => a.position - b.position);
  render();
}

// ---------------------------------------------------------------------------
// Full board refetch (fallback)
// ---------------------------------------------------------------------------

async function refetchBoard() {
  try {
    boardState = await fetchBoard();
    render();
  } catch (err) {
    console.error("Failed to refetch board:", err);
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  try {
    boardState = await fetchBoard();
    render();
    connectSSE();
  } catch (err) {
    console.error("Failed to initialize:", err);
    boardEl.innerHTML = `<p style="padding:24px;color:#eb5a46;">Failed to load board. Is the server running?</p>`;
  }
}

init();
