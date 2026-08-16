const API_BASE = window.location.origin;

// ─── State ───────────────────────────────────────────────────────────────────
let boardState = { columns: [] };
let dragState = null; // { cardId, sourceColumnId }

// ─── DOM References ──────────────────────────────────────────────────────────
const boardEl = document.getElementById("board");
const statusEl = document.getElementById("connection-status");

// ─── API Helpers ─────────────────────────────────────────────────────────────
async function fetchBoard() {
  const res = await fetch(`${API_BASE}/api/board`);
  const data = await res.json();
  boardState = data;
  renderBoard();
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
    body: JSON.stringify({ columnId, afterId, beforeId }),
  });
  return res.json();
}

async function deleteCard(cardId) {
  await fetch(`${API_BASE}/api/cards/${cardId}`, { method: "DELETE" });
}

// ─── SSE Connection ──────────────────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource(`${API_BASE}/api/stream`);

  es.onopen = () => {
    statusEl.textContent = "Connected";
    statusEl.className = "status connected";
    // Re-fetch board on reconnect to catch up
    fetchBoard();
  };

  es.onerror = () => {
    statusEl.textContent = "Disconnected";
    statusEl.className = "status disconnected";
    // EventSource will auto-reconnect
  };

  es.addEventListener("card_created", (e) => {
    const { card } = JSON.parse(e.data);
    handleCardCreated(card);
  });

  es.addEventListener("card_moved", (e) => {
    const { card, oldColumnId } = JSON.parse(e.data);
    handleCardMoved(card, oldColumnId);
  });

  es.addEventListener("card_deleted", (e) => {
    const { cardId, columnId } = JSON.parse(e.data);
    handleCardDeleted(cardId, columnId);
  });

  es.addEventListener("column_renormalized", (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    handleColumnRenormalized(columnId, cards);
  });

  return es;
}

// ─── SSE Event Handlers ─────────────────────────────────────────────────────
function handleCardCreated(card) {
  const col = boardState.columns.find((c) => c.id === card.column_id);
  if (!col) return;

  // Check if card already exists (from optimistic update or duplicate event)
  const existingIdx = col.cards.findIndex((c) => c.id === card.id);
  if (existingIdx !== -1) {
    // Update with canonical data
    col.cards[existingIdx] = card;
  } else {
    col.cards.push(card);
  }
  col.cards.sort((a, b) => a.position - b.position);
  renderColumn(col);
}

function handleCardMoved(card, oldColumnId) {
  // Remove card from ALL columns to ensure it exists in exactly one place
  const affectedColumnIds = new Set();
  for (const col of boardState.columns) {
    const idx = col.cards.findIndex((c) => c.id === card.id);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      affectedColumnIds.add(col.id);
    }
  }

  // Add to target column
  const targetCol = boardState.columns.find((c) => c.id === card.column_id);
  if (!targetCol) return;

  targetCol.cards.push(card);
  targetCol.cards.sort((a, b) => a.position - b.position);
  affectedColumnIds.add(targetCol.id);

  // Re-render all affected columns
  renderBoard();
}

function handleCardDeleted(cardId, columnId) {
  for (const col of boardState.columns) {
    col.cards = col.cards.filter((c) => c.id !== cardId);
  }
  renderBoard();
}

function handleColumnRenormalized(columnId, cards) {
  const col = boardState.columns.find((c) => c.id === columnId);
  if (!col) return;
  col.cards = cards;
  col.cards.sort((a, b) => a.position - b.position);
  renderColumn(col);
}

// ─── Rendering ───────────────────────────────────────────────────────────────
function renderBoard() {
  boardEl.innerHTML = "";
  for (const col of boardState.columns) {
    boardEl.appendChild(createColumnEl(col));
  }
}

function renderColumn(col) {
  const existingEl = document.querySelector(
    `.column[data-column-id="${col.id}"]`
  );
  if (existingEl) {
    const newEl = createColumnEl(col);
    existingEl.replaceWith(newEl);
  } else {
    renderBoard();
  }
}

function createColumnEl(col) {
  const colEl = document.createElement("div");
  colEl.className = "column";
  colEl.dataset.columnId = col.id;

  const headerEl = document.createElement("div");
  headerEl.className = "column-header";
  headerEl.textContent = `${col.title} (${col.cards.length})`;

  const listEl = document.createElement("div");
  listEl.className = "card-list";
  listEl.dataset.columnId = col.id;

  for (const card of col.cards) {
    listEl.appendChild(createCardEl(card));
  }

  // Drag and drop handlers on the list
  setupDropTarget(listEl, col.id);

  // Add card form
  const formEl = createAddCardForm(col.id);

  colEl.appendChild(headerEl);
  colEl.appendChild(listEl);
  colEl.appendChild(formEl);

  return colEl;
}

function createCardEl(card) {
  const cardEl = document.createElement("div");
  cardEl.className = "card";
  cardEl.dataset.cardId = card.id;
  cardEl.dataset.position = card.position;
  cardEl.draggable = true;

  const textEl = document.createElement("div");
  textEl.className = "card-text";
  textEl.textContent = card.text;

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "card-delete";
  deleteBtn.textContent = "✕";
  deleteBtn.title = "Delete card";
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    deleteCard(card.id);
  });

  cardEl.appendChild(textEl);
  cardEl.appendChild(deleteBtn);

  // Drag start
  cardEl.addEventListener("dragstart", (e) => {
    dragState = {
      cardId: card.id,
      sourceColumnId: card.column_id,
    };
    // Use setTimeout so the browser captures the card's visual before we add the class
    setTimeout(() => {
      cardEl.classList.add("dragging");
    }, 0);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", card.id.toString());
  });

  cardEl.addEventListener("dragend", () => {
    cardEl.classList.remove("dragging");
    clearAllDropIndicators();
    dragState = null;
  });

  return cardEl;
}

function createAddCardForm(columnId) {
  const container = document.createElement("div");
  container.className = "add-card-form";

  const btn = document.createElement("button");
  btn.className = "add-card-btn";
  btn.textContent = "+ Add a card";

  const inputArea = document.createElement("div");
  inputArea.className = "add-card-input-area";

  const textarea = document.createElement("textarea");
  textarea.placeholder = "Enter a title for this card…";

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

  inputArea.appendChild(textarea);
  inputArea.appendChild(actions);

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
    textarea.focus();
    await createCard(columnId, text);
  };

  submitBtn.addEventListener("click", doSubmit);

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSubmit();
    }
    if (e.key === "Escape") {
      btn.style.display = "";
      inputArea.classList.remove("active");
      textarea.value = "";
    }
  });

  container.appendChild(btn);
  container.appendChild(inputArea);

  return container;
}

// ─── Drag and Drop ───────────────────────────────────────────────────────────
function setupDropTarget(listEl, columnId) {
  listEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    if (!dragState) return;

    clearAllDropIndicators();

    const cardEls = Array.from(listEl.querySelectorAll(".card:not(.dragging)"));

    if (cardEls.length === 0) {
      listEl.classList.add("drop-target-empty");
      return;
    }

    const target = getClosestCard(e.clientY, cardEls);
    if (target.el) {
      if (target.position === "above") {
        target.el.classList.add("drop-target-above");
      } else {
        target.el.classList.add("drop-target-below");
      }
    }
  });

  listEl.addEventListener("dragleave", (e) => {
    // Only clear if we're actually leaving the list
    if (!listEl.contains(e.relatedTarget)) {
      clearDropIndicators(listEl);
    }
  });

  listEl.addEventListener("drop", async (e) => {
    e.preventDefault();
    clearAllDropIndicators();

    if (!dragState) return;

    const cardId = dragState.cardId;

    const cardEls = Array.from(listEl.querySelectorAll(".card:not(.dragging)"));

    let afterId = null;
    let beforeId = null;

    if (cardEls.length === 0) {
      // Empty column, no after/before
    } else {
      const target = getClosestCard(e.clientY, cardEls);

      if (target.el) {
        const targetCardId = parseInt(target.el.dataset.cardId, 10);
        const targetIndex = cardEls.indexOf(target.el);

        if (target.position === "above") {
          beforeId = targetCardId;
          if (targetIndex > 0) {
            afterId = parseInt(cardEls[targetIndex - 1].dataset.cardId, 10);
          }
        } else {
          afterId = targetCardId;
          if (targetIndex < cardEls.length - 1) {
            beforeId = parseInt(cardEls[targetIndex + 1].dataset.cardId, 10);
          }
        }
      }
    }

    // Optimistic update: move card in local state
    optimisticMove(cardId, columnId, afterId, beforeId);

    // Send to server
    try {
      await moveCard(cardId, columnId, afterId, beforeId);
    } catch (err) {
      console.error("Move failed:", err);
      // Server broadcast will reconcile, or we re-fetch
      fetchBoard();
    }
  });
}

function optimisticMove(cardId, targetColumnId, afterId, beforeId) {
  // Find and remove card from current column
  let card = null;
  for (const col of boardState.columns) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) {
      card = { ...col.cards[idx] };
      col.cards.splice(idx, 1);
      break;
    }
  }
  if (!card) return;

  // Find target column
  const targetCol = boardState.columns.find((c) => c.id === targetColumnId);
  if (!targetCol) return;

  // Compute insertion index
  let insertIdx = targetCol.cards.length; // default: end

  if (beforeId != null) {
    const beforeIdx = targetCol.cards.findIndex((c) => c.id === beforeId);
    if (beforeIdx !== -1) {
      insertIdx = beforeIdx;
    }
  } else if (afterId != null) {
    const afterIdx = targetCol.cards.findIndex((c) => c.id === afterId);
    if (afterIdx !== -1) {
      insertIdx = afterIdx + 1;
    }
  }

  // Assign a temporary optimistic position
  const afterCard = insertIdx > 0 ? targetCol.cards[insertIdx - 1] : null;
  const beforeCard =
    insertIdx < targetCol.cards.length ? targetCol.cards[insertIdx] : null;

  let newPos;
  if (afterCard && beforeCard) {
    newPos = (afterCard.position + beforeCard.position) / 2;
  } else if (afterCard) {
    newPos = afterCard.position + 1000;
  } else if (beforeCard) {
    newPos = beforeCard.position / 2;
  } else {
    newPos = 1000;
  }

  card.column_id = targetColumnId;
  card.position = newPos;

  targetCol.cards.splice(insertIdx, 0, card);

  renderBoard();
}

function getClosestCard(mouseY, cardEls) {
  let closest = { el: null, position: "below", distance: Infinity };

  for (const cardEl of cardEls) {
    const rect = cardEl.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const distance = Math.abs(mouseY - midY);

    if (distance < closest.distance) {
      closest = {
        el: cardEl,
        position: mouseY < midY ? "above" : "below",
        distance,
      };
    }
  }

  return closest;
}

function clearAllDropIndicators() {
  document.querySelectorAll(".drop-target-above").forEach((el) => {
    el.classList.remove("drop-target-above");
  });
  document.querySelectorAll(".drop-target-below").forEach((el) => {
    el.classList.remove("drop-target-below");
  });
  document.querySelectorAll(".drop-target-empty").forEach((el) => {
    el.classList.remove("drop-target-empty");
  });
}

function clearDropIndicators(listEl) {
  listEl.querySelectorAll(".drop-target-above").forEach((el) => {
    el.classList.remove("drop-target-above");
  });
  listEl.querySelectorAll(".drop-target-below").forEach((el) => {
    el.classList.remove("drop-target-below");
  });
  listEl.classList.remove("drop-target-empty");
}

// ─── Init ────────────────────────────────────────────────────────────────────
async function init() {
  await fetchBoard();
  connectSSE();
}

init();
