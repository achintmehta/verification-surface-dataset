import { fetchBoard, createCard, moveCard, deleteCard } from "./api.js";

// ── State ──────────────────────────────────────────────────────────
// boardState: Array of { id, title, position, cards: [{ id, column_id, text, position }] }
let boardState = [];

// Currently dragged card info
let dragState = null;

// ── DOM references ─────────────────────────────────────────────────
const boardEl = document.getElementById("board");
const statusEl = document.getElementById("connection-status");

// ── Rendering ──────────────────────────────────────────────────────

function render() {
  boardEl.innerHTML = "";
  for (const column of boardState) {
    boardEl.appendChild(createColumnEl(column));
  }
}

function createColumnEl(column) {
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
    listEl.appendChild(createCardEl(card));
  }

  // Drop zone events
  listEl.addEventListener("dragover", handleDragOver);
  listEl.addEventListener("dragenter", handleDragEnter);
  listEl.addEventListener("dragleave", handleDragLeave);
  listEl.addEventListener("drop", handleDrop);

  colEl.appendChild(listEl);

  // Add card button/form
  const addBtn = document.createElement("button");
  addBtn.className = "add-card-btn";
  addBtn.textContent = "+ Add a card";
  addBtn.addEventListener("click", () => showAddForm(colEl, column.id));
  colEl.appendChild(addBtn);

  return colEl;
}

function createCardEl(card) {
  const el = document.createElement("div");
  el.className = "card";
  el.draggable = true;
  el.dataset.cardId = card.id;
  el.dataset.columnId = card.column_id;

  el.innerHTML = `
    <span class="card-text">${escapeHtml(card.text)}</span>
    <button class="delete-btn" title="Delete card">&times;</button>
  `;

  // Delete
  el.querySelector(".delete-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    // Optimistic removal
    removeCardFromState(card.id);
    render();
    try {
      await deleteCard(card.id);
    } catch (err) {
      console.error("Delete failed, reloading board:", err);
      await loadBoard();
    }
  });

  // Drag events
  el.addEventListener("dragstart", (e) => {
    dragState = {
      cardId: card.id,
      sourceColumnId: card.column_id,
    };
    el.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    // Required for Firefox
    e.dataTransfer.setData("text/plain", card.id);
  });

  el.addEventListener("dragend", () => {
    el.classList.remove("dragging");
    clearPlaceholders();
    dragState = null;
  });

  return el;
}

function showAddForm(colEl, columnId) {
  // Remove existing form if any
  const existing = colEl.querySelector(".add-card-form");
  if (existing) return;

  const addBtn = colEl.querySelector(".add-card-btn");
  addBtn.style.display = "none";

  const form = document.createElement("div");
  form.className = "add-card-form";
  form.innerHTML = `
    <textarea placeholder="Enter a title for this card..." rows="2"></textarea>
    <div class="form-actions">
      <button class="btn-add">Add Card</button>
      <button class="btn-cancel">Cancel</button>
    </div>
  `;

  const textarea = form.querySelector("textarea");
  const btnAdd = form.querySelector(".btn-add");
  const btnCancel = form.querySelector(".btn-cancel");

  const close = () => {
    form.remove();
    addBtn.style.display = "";
  };

  btnCancel.addEventListener("click", close);

  const submit = async () => {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = "";
    try {
      await createCard(columnId, text);
      // SSE will handle updating the board; but we can optimistically add too
    } catch (err) {
      console.error("Failed to create card:", err);
    }
  };

  btnAdd.addEventListener("click", submit);
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
    if (e.key === "Escape") {
      close();
    }
  });

  colEl.appendChild(form);
  textarea.focus();
}

// ── Drag & Drop ────────────────────────────────────────────────────

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";

  const listEl = e.currentTarget;

  // Remove old placeholder
  clearPlaceholders();

  // Determine position in list
  const cardEls = [...listEl.querySelectorAll(".card:not(.dragging)")];
  const placeholder = document.createElement("div");
  placeholder.className = "drop-placeholder";

  let insertBefore = null;
  for (const cardEl of cardEls) {
    const rect = cardEl.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY < midY) {
      insertBefore = cardEl;
      break;
    }
  }

  if (insertBefore) {
    listEl.insertBefore(placeholder, insertBefore);
  } else {
    listEl.appendChild(placeholder);
  }
}

function handleDragEnter(e) {
  e.preventDefault();
  e.currentTarget.classList.add("drag-over");
}

function handleDragLeave(e) {
  // Only remove if actually leaving the list
  const listEl = e.currentTarget;
  if (!listEl.contains(e.relatedTarget)) {
    listEl.classList.remove("drag-over");
    clearPlaceholders();
  }
}

function handleDrop(e) {
  e.preventDefault();
  const listEl = e.currentTarget;
  listEl.classList.remove("drag-over");
  clearPlaceholders();

  if (!dragState) return;

  const targetColumnId = listEl.dataset.columnId;
  const cardEls = [...listEl.querySelectorAll(".card:not(.dragging)")];

  // Determine after/before based on drop position
  let afterId = null;
  let beforeId = null;

  let insertIndex = cardEls.length; // default: end
  for (let i = 0; i < cardEls.length; i++) {
    const rect = cardEls[i].getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY < midY) {
      insertIndex = i;
      break;
    }
  }

  if (insertIndex > 0) {
    afterId = cardEls[insertIndex - 1].dataset.cardId;
  }
  if (insertIndex < cardEls.length) {
    beforeId = cardEls[insertIndex].dataset.cardId;
  }

  const { cardId } = dragState;

  // Optimistic update in state
  optimisticMove(cardId, targetColumnId, afterId, beforeId);
  render();

  // Send to server
  moveCard(cardId, targetColumnId, afterId, beforeId).catch(async (err) => {
    console.error("Move failed, reloading board:", err);
    await loadBoard();
  });
}

function clearPlaceholders() {
  document.querySelectorAll(".drop-placeholder").forEach((el) => el.remove());
}

// ── Optimistic state updates ───────────────────────────────────────

function optimisticMove(cardId, targetColumnId, afterId, beforeId) {
  // Remove card from its current column
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

  // Find the target column
  const targetCol = boardState.find((c) => c.id === targetColumnId);
  if (!targetCol) return;

  // Insert at the right position
  if (afterId || beforeId) {
    let insertIdx = targetCol.cards.length;
    if (beforeId) {
      const beforeIdx = targetCol.cards.findIndex((c) => c.id === beforeId);
      if (beforeIdx !== -1) insertIdx = beforeIdx;
    } else if (afterId) {
      const afterIdx = targetCol.cards.findIndex((c) => c.id === afterId);
      if (afterIdx !== -1) insertIdx = afterIdx + 1;
    }
    targetCol.cards.splice(insertIdx, 0, card);
  } else {
    targetCol.cards.push(card);
  }
}

function removeCardFromState(cardId) {
  for (const col of boardState) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      break;
    }
  }
}

// ── SSE (Server-Sent Events) ──────────────────────────────────────

function connectSSE() {
  const evtSource = new EventSource("/api/stream");

  evtSource.onopen = () => {
    statusEl.textContent = "Connected";
    statusEl.className = "status connected";
  };

  evtSource.onerror = () => {
    statusEl.textContent = "Disconnected";
    statusEl.className = "status disconnected";
    // EventSource auto-reconnects
  };

  evtSource.addEventListener("card:created", (e) => {
    const { card } = JSON.parse(e.data);
    handleCardCreated(card);
  });

  evtSource.addEventListener("card:moved", (e) => {
    const { card, oldColumnId } = JSON.parse(e.data);
    handleCardMoved(card, oldColumnId);
  });

  evtSource.addEventListener("card:deleted", (e) => {
    const { cardId } = JSON.parse(e.data);
    removeCardFromState(cardId);
    render();
  });

  evtSource.addEventListener("board:sync", (e) => {
    const { board } = JSON.parse(e.data);
    boardState = board;
    render();
  });
}

function handleCardCreated(card) {
  const col = boardState.find((c) => c.id === card.column_id);
  if (!col) return;

  // Avoid duplicate
  const existing = col.cards.findIndex((c) => c.id === card.id);
  if (existing !== -1) {
    // Update position
    col.cards[existing] = card;
  } else {
    col.cards.push(card);
  }

  // Sort by position
  col.cards.sort((a, b) => a.position - b.position);
  render();
}

function handleCardMoved(card, oldColumnId) {
  // Remove card from ALL columns (ensure no duplicates)
  for (const col of boardState) {
    col.cards = col.cards.filter((c) => c.id !== card.id);
  }

  // Add to the target column
  const targetCol = boardState.find((c) => c.id === card.column_id);
  if (targetCol) {
    targetCol.cards.push(card);
    targetCol.cards.sort((a, b) => a.position - b.position);
  }

  render();
}

// ── Initial load ───────────────────────────────────────────────────

async function loadBoard() {
  try {
    boardState = await fetchBoard();
    render();
  } catch (err) {
    console.error("Failed to load board:", err);
    boardEl.innerHTML = '<p style="padding:24px;color:#c00;">Failed to load board. Is the server running?</p>';
  }
}

// ── Utilities ──────────────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── Bootstrap ──────────────────────────────────────────────────────

async function init() {
  await loadBoard();
  connectSSE();
}

init();
