// ─────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────
let boardState = { columns: [] }; // authoritative local mirror of server state
let dragState = null; // { cardId, sourceColumnId, cardEl }

const API_BASE = "/api";

// ─────────────────────────────────────────────────
// API helpers
// ─────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────
const boardEl = document.getElementById("board");

function renderBoard() {
  boardEl.innerHTML = "";
  for (const col of boardState.columns) {
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
  const titleSpan = document.createElement("span");
  titleSpan.textContent = col.title;
  const countSpan = document.createElement("span");
  countSpan.className = "card-count";
  countSpan.textContent = col.cards.length;
  header.appendChild(titleSpan);
  header.appendChild(countSpan);
  colEl.appendChild(header);

  // Card list (drop zone)
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

function renderCard(card) {
  const el = document.createElement("div");
  el.className = "card";
  el.dataset.cardId = card.id;
  el.dataset.position = card.position;
  el.draggable = true;
  el.textContent = card.text;

  el.addEventListener("dragstart", handleDragStart);
  el.addEventListener("dragend", handleDragEnd);

  return el;
}

function renderAddCardForm(columnId) {
  const wrapper = document.createElement("div");
  wrapper.className = "add-card-form";

  const btn = document.createElement("button");
  btn.className = "add-card-btn";
  btn.textContent = "+ Add a card";

  const inputWrapper = document.createElement("div");
  inputWrapper.className = "add-card-input-wrapper";
  inputWrapper.style.display = "none";

  const textarea = document.createElement("textarea");
  textarea.className = "add-card-input";
  textarea.placeholder = "Enter card text...";

  const actions = document.createElement("div");
  actions.className = "add-card-actions";

  const submitBtn = document.createElement("button");
  submitBtn.className = "add-card-submit";
  submitBtn.textContent = "Add";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "add-card-cancel";
  cancelBtn.textContent = "Cancel";

  actions.appendChild(submitBtn);
  actions.appendChild(cancelBtn);
  inputWrapper.appendChild(textarea);
  inputWrapper.appendChild(actions);

  btn.addEventListener("click", () => {
    btn.style.display = "none";
    inputWrapper.style.display = "flex";
    textarea.value = "";
    textarea.focus();
  });

  cancelBtn.addEventListener("click", () => {
    btn.style.display = "";
    inputWrapper.style.display = "none";
  });

  const doSubmit = async () => {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = "";
    textarea.focus();
    try {
      await createCard(columnId, text);
      // The SSE event will update the board
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
      btn.style.display = "";
      inputWrapper.style.display = "none";
    }
  });

  wrapper.appendChild(btn);
  wrapper.appendChild(inputWrapper);
  return wrapper;
}

// ─────────────────────────────────────────────────
// Drag & Drop
// ─────────────────────────────────────────────────
function handleDragStart(e) {
  const cardEl = e.target.closest(".card");
  if (!cardEl) return;

  const cardId = cardEl.dataset.cardId;
  const sourceColumnId = cardEl.closest(".card-list").dataset.columnId;

  dragState = { cardId, sourceColumnId, cardEl };

  cardEl.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", cardId);

  // Delay to allow the browser to capture the drag image before dimming
  requestAnimationFrame(() => {
    cardEl.style.opacity = "0.4";
  });
}

function handleDragEnd(e) {
  const cardEl = e.target.closest(".card");
  if (cardEl) {
    cardEl.classList.remove("dragging");
    cardEl.style.opacity = "";
  }

  // Remove all drop indicators
  document.querySelectorAll(".drop-indicator").forEach((el) => el.remove());
  document.querySelectorAll(".card-list.drag-over").forEach((el) => el.classList.remove("drag-over"));

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
  const cards = [...listEl.querySelectorAll(".card:not(.dragging)")];
  const target = getDropTarget(cards, e.clientY);

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
  // Only remove if we actually left (not entering a child)
  if (!listEl.contains(e.relatedTarget)) {
    listEl.classList.remove("drag-over");
    listEl.querySelectorAll(".drop-indicator").forEach((el) => el.remove());
  }
}

function handleDrop(e) {
  e.preventDefault();
  const listEl = e.currentTarget;
  listEl.classList.remove("drag-over");
  listEl.querySelectorAll(".drop-indicator").forEach((el) => el.remove());

  if (!dragState) return;

  const { cardId, sourceColumnId } = dragState;
  const targetColumnId = listEl.dataset.columnId;

  // Determine drop position based on mouse Y
  const cards = [...listEl.querySelectorAll(".card:not(.dragging)")];
  const beforeEl = getDropTarget(cards, e.clientY);

  // Figure out afterId & beforeId
  let afterId = null;
  let beforeId = null;

  if (beforeEl) {
    beforeId = beforeEl.dataset.cardId;
    // afterId is the card before beforeEl
    const beforeIdx = cards.indexOf(beforeEl);
    if (beforeIdx > 0) {
      afterId = cards[beforeIdx - 1].dataset.cardId;
    }
  } else {
    // Dropped at the end
    if (cards.length > 0) {
      afterId = cards[cards.length - 1].dataset.cardId;
    }
  }

  // Don't count the dragging card itself as after/before
  if (afterId === cardId) afterId = null;
  if (beforeId === cardId) beforeId = null;

  // Optimistic update: move the card in the DOM immediately
  optimisticMove(cardId, targetColumnId, beforeEl, listEl);

  // Send to server
  moveCard(cardId, targetColumnId, afterId, beforeId).catch((err) => {
    console.error("Move card error:", err);
    // On failure, re-render from last known good state
    renderBoard();
  });
}

function getDropTarget(cards, mouseY) {
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (mouseY < midY) {
      return card;
    }
  }
  return null; // after last card
}

function optimisticMove(cardId, targetColumnId, beforeEl, listEl) {
  // Find the card element in the DOM
  const cardEl = document.querySelector(`.card[data-card-id="${cardId}"]`);
  if (!cardEl) return;

  cardEl.classList.add("optimistic");

  // Remove from current position
  cardEl.remove();

  // Insert at new position
  if (beforeEl) {
    listEl.insertBefore(cardEl, beforeEl);
  } else {
    listEl.appendChild(cardEl);
  }

  // Also update local state
  updateLocalState(cardId, targetColumnId, beforeEl?.dataset.cardId);

  // Update card counts
  updateCardCounts();
}

function updateLocalState(cardId, targetColumnId, beforeCardId) {
  // Remove card from its old column in state
  let card = null;
  for (const col of boardState.columns) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) {
      card = col.cards.splice(idx, 1)[0];
      break;
    }
  }
  if (!card) return;

  // Find target column
  const targetCol = boardState.columns.find((c) => c.id === targetColumnId);
  if (!targetCol) return;

  card.column_id = targetColumnId;

  if (beforeCardId) {
    const beforeIdx = targetCol.cards.findIndex((c) => c.id === beforeCardId);
    if (beforeIdx !== -1) {
      targetCol.cards.splice(beforeIdx, 0, card);
    } else {
      targetCol.cards.push(card);
    }
  } else {
    targetCol.cards.push(card);
  }
}

function updateCardCounts() {
  for (const col of boardState.columns) {
    const colEl = document.querySelector(`.column[data-column-id="${col.id}"]`);
    if (colEl) {
      const countEl = colEl.querySelector(".card-count");
      const cardList = colEl.querySelector(".card-list");
      if (countEl && cardList) {
        countEl.textContent = cardList.querySelectorAll(".card").length;
      }
    }
  }
}

// ─────────────────────────────────────────────────
// SSE – Real-time updates
// ─────────────────────────────────────────────────
let eventSource = null;

function connectSSE() {
  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.addEventListener("card-created", (e) => {
    const { card } = JSON.parse(e.data);
    handleCardCreated(card);
  });

  eventSource.addEventListener("card-moved", (e) => {
    const { card } = JSON.parse(e.data);
    handleCardMoved(card);
  });

  eventSource.addEventListener("column-renormalized", (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    handleColumnRenormalized(columnId, cards);
  });

  eventSource.addEventListener("card-deleted", (e) => {
    const { id, columnId } = JSON.parse(e.data);
    handleCardDeleted(id, columnId);
  });

  eventSource.addEventListener("open", () => {
    updateConnectionStatus(true);
  });

  eventSource.addEventListener("error", () => {
    updateConnectionStatus(false);
    // EventSource will auto-reconnect
  });
}

function handleCardCreated(card) {
  // Add card to state
  const col = boardState.columns.find((c) => c.id === card.column_id);
  if (!col) return;

  // Check for duplicates
  if (col.cards.some((c) => c.id === card.id)) return;

  col.cards.push(card);
  col.cards.sort((a, b) => a.position - b.position);

  // Update DOM
  const listEl = document.querySelector(`.card-list[data-column-id="${card.column_id}"]`);
  if (!listEl) return;

  // Check if already rendered (in case of race)
  if (listEl.querySelector(`.card[data-card-id="${card.id}"]`)) return;

  const cardEl = renderCard(card);

  // Find correct insertion point
  const existingCards = [...listEl.querySelectorAll(".card")];
  let inserted = false;
  for (const existing of existingCards) {
    if (parseFloat(existing.dataset.position) > card.position) {
      listEl.insertBefore(cardEl, existing);
      inserted = true;
      break;
    }
  }
  if (!inserted) {
    listEl.appendChild(cardEl);
  }

  updateCardCounts();
}

function handleCardMoved(card) {
  // Update state: remove card from old column, add to new column
  let existingCard = null;
  for (const col of boardState.columns) {
    const idx = col.cards.findIndex((c) => c.id === card.id);
    if (idx !== -1) {
      existingCard = col.cards.splice(idx, 1)[0];
      break;
    }
  }

  if (!existingCard) {
    existingCard = card;
  } else {
    Object.assign(existingCard, card);
  }

  const targetCol = boardState.columns.find((c) => c.id === card.column_id);
  if (!targetCol) return;

  targetCol.cards.push(existingCard);
  targetCol.cards.sort((a, b) => a.position - b.position);

  // Update DOM: remove old card element from anywhere
  const oldCardEl = document.querySelector(`.card[data-card-id="${card.id}"]`);
  if (oldCardEl) {
    oldCardEl.remove();
  }

  // Insert into correct column at correct position
  const listEl = document.querySelector(`.card-list[data-column-id="${card.column_id}"]`);
  if (!listEl) return;

  const newCardEl = renderCard(card);

  const existingCards = [...listEl.querySelectorAll(".card")];
  let inserted = false;
  for (const existing of existingCards) {
    if (parseFloat(existing.dataset.position) > card.position) {
      listEl.insertBefore(newCardEl, existing);
      inserted = true;
      break;
    }
  }
  if (!inserted) {
    listEl.appendChild(newCardEl);
  }

  updateCardCounts();
}

function handleColumnRenormalized(columnId, cards) {
  // Replace the column's cards in state
  const col = boardState.columns.find((c) => c.id === columnId);
  if (!col) return;

  col.cards = cards.sort((a, b) => a.position - b.position);

  // Re-render just this column's card list
  const listEl = document.querySelector(`.card-list[data-column-id="${columnId}"]`);
  if (!listEl) return;

  // Remove all existing cards from the list
  listEl.querySelectorAll(".card").forEach((el) => el.remove());

  // Also remove any cards with this column's card IDs that might be in other columns (cross-column moves)
  for (const card of cards) {
    const staleEl = document.querySelector(`.card[data-card-id="${card.id}"]`);
    if (staleEl) staleEl.remove();
  }

  // Re-add in order
  for (const card of col.cards) {
    listEl.appendChild(renderCard(card));
  }

  // Also make sure cards from this column are removed from other columns' state
  for (const otherCol of boardState.columns) {
    if (otherCol.id === columnId) continue;
    otherCol.cards = otherCol.cards.filter(
      (c) => !cards.some((nc) => nc.id === c.id)
    );
  }

  updateCardCounts();
}

function handleCardDeleted(cardId, columnId) {
  // Remove from state
  for (const col of boardState.columns) {
    col.cards = col.cards.filter((c) => c.id !== cardId);
  }

  // Remove from DOM
  const cardEl = document.querySelector(`.card[data-card-id="${cardId}"]`);
  if (cardEl) cardEl.remove();

  updateCardCounts();
}

// ─────────────────────────────────────────────────
// Connection status indicator
// ─────────────────────────────────────────────────
function updateConnectionStatus(connected) {
  let statusEl = document.querySelector(".connection-status");
  if (!statusEl) {
    statusEl = document.createElement("div");
    statusEl.className = "connection-status";
    document.body.appendChild(statusEl);
  }
  statusEl.className = `connection-status ${connected ? "connected" : "disconnected"}`;
  statusEl.textContent = connected ? "● Connected" : "● Disconnected";
}

// ─────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────
async function init() {
  try {
    const data = await fetchBoard();
    boardState = data;
    renderBoard();
    connectSSE();
  } catch (err) {
    console.error("Failed to initialize board:", err);
    boardEl.innerHTML = `<div style="padding:40px;color:#f87171;">Failed to load board. Is the server running?</div>`;
    // Retry after a few seconds
    setTimeout(init, 3000);
  }
}

init();
