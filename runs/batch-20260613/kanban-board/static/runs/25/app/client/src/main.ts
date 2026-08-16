import { fetchBoard, createCard, moveCard } from "./api.js";
import type { Card, Column } from "./api.js";

// ── State ───────────────────────────────────────────────────────────────────

let boardState: Column[] = [];

// ── DOM references ──────────────────────────────────────────────────────────

const boardEl = document.getElementById("board")!;
const statusEl = document.getElementById("connection-status")!;

// ── Drag state ──────────────────────────────────────────────────────────────

let draggedCardId: string | null = null;
let draggedCardEl: HTMLElement | null = null;

// ── Rendering ───────────────────────────────────────────────────────────────

function renderBoard(): void {
  boardEl.innerHTML = "";
  for (const column of boardState) {
    boardEl.appendChild(renderColumn(column));
  }
}

function renderColumn(column: Column): HTMLElement {
  const colEl = document.createElement("div");
  colEl.className = "column";
  colEl.dataset.columnId = column.id;

  // Header
  const header = document.createElement("div");
  header.className = "column-header";
  const title = document.createElement("h2");
  title.textContent = column.title;
  const count = document.createElement("span");
  count.className = "card-count";
  count.textContent = String(column.cards.length);
  header.appendChild(title);
  header.appendChild(count);
  colEl.appendChild(header);

  // Card list
  const listEl = document.createElement("div");
  listEl.className = "card-list";
  listEl.dataset.columnId = column.id;

  // Sort cards by position
  const sortedCards = [...column.cards].sort((a, b) => a.position - b.position);

  for (const card of sortedCards) {
    listEl.appendChild(renderCard(card));
  }

  // Drag & drop events on the list
  listEl.addEventListener("dragover", handleDragOver);
  listEl.addEventListener("dragleave", handleDragLeave);
  listEl.addEventListener("drop", handleDrop);

  colEl.appendChild(listEl);

  // Add card button / form
  const addBtn = document.createElement("button");
  addBtn.className = "btn-add";
  addBtn.textContent = "+ Add a card";
  addBtn.addEventListener("click", () => {
    addBtn.style.display = "none";
    formEl.style.display = "block";
    textarea.focus();
  });

  const formEl = document.createElement("div");
  formEl.className = "add-card-form";
  formEl.style.display = "none";

  const textarea = document.createElement("textarea");
  textarea.placeholder = "Enter card text...";

  const formActions = document.createElement("div");
  formActions.className = "form-actions";

  const submitBtn = document.createElement("button");
  submitBtn.className = "btn btn-primary";
  submitBtn.textContent = "Add Card";
  submitBtn.addEventListener("click", async () => {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = "";
    try {
      await createCard(column.id, text);
    } catch (err) {
      console.error("Failed to create card:", err);
    }
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn btn-secondary";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => {
    textarea.value = "";
    formEl.style.display = "none";
    addBtn.style.display = "block";
  });

  textarea.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitBtn.click();
    }
    if (e.key === "Escape") {
      cancelBtn.click();
    }
  });

  formActions.appendChild(submitBtn);
  formActions.appendChild(cancelBtn);
  formEl.appendChild(textarea);
  formEl.appendChild(formActions);

  colEl.appendChild(addBtn);
  colEl.appendChild(formEl);

  return colEl;
}

function renderCard(card: Card): HTMLElement {
  const cardEl = document.createElement("div");
  cardEl.className = "card";
  cardEl.dataset.cardId = card.id;
  cardEl.draggable = true;
  cardEl.textContent = card.text;

  cardEl.addEventListener("dragstart", (e: DragEvent) => {
    draggedCardId = card.id;
    draggedCardEl = cardEl;
    cardEl.classList.add("dragging");
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("text/plain", card.id);
  });

  cardEl.addEventListener("dragend", () => {
    cardEl.classList.remove("dragging");
    draggedCardId = null;
    draggedCardEl = null;
    clearAllDropIndicators();
  });

  return cardEl;
}

// ── Drag & Drop handlers ────────────────────────────────────────────────────

function handleDragOver(e: DragEvent): void {
  e.preventDefault();
  e.dataTransfer!.dropEffect = "move";

  const listEl = (e.currentTarget as HTMLElement);
  clearAllDropIndicators();

  const afterElement = getDragAfterElement(listEl, e.clientY);

  // Add visual indicator
  if (afterElement) {
    afterElement.classList.add("drop-target-above");
  } else {
    listEl.classList.add("drag-over");
  }
}

function handleDragLeave(e: DragEvent): void {
  const listEl = e.currentTarget as HTMLElement;
  // Only clear if we're actually leaving the list
  const relatedTarget = e.relatedTarget as HTMLElement | null;
  if (!relatedTarget || !listEl.contains(relatedTarget)) {
    clearAllDropIndicators();
    listEl.classList.remove("drag-over");
  }
}

function handleDrop(e: DragEvent): void {
  e.preventDefault();
  clearAllDropIndicators();

  if (!draggedCardId) return;

  const listEl = e.currentTarget as HTMLElement;
  const columnId = listEl.dataset.columnId!;
  const afterElement = getDragAfterElement(listEl, e.clientY);

  // Get the cards in order in this column (excluding the dragged card)
  const cardEls = Array.from(listEl.querySelectorAll<HTMLElement>(".card")).filter(
    (el) => el.dataset.cardId !== draggedCardId
  );

  let afterId: string | null = null; // card above insertion point
  let beforeId: string | null = null; // card below insertion point

  if (afterElement) {
    // We're inserting before afterElement
    beforeId = afterElement.dataset.cardId || null;

    // Find the card before afterElement
    const idx = cardEls.indexOf(afterElement);
    if (idx > 0) {
      afterId = cardEls[idx - 1].dataset.cardId || null;
    }
  } else {
    // Dropping at the end
    if (cardEls.length > 0) {
      afterId = cardEls[cardEls.length - 1].dataset.cardId || null;
    }
  }

  // Optimistic update: move the card in the DOM immediately
  if (draggedCardEl) {
    // Remove from current location
    draggedCardEl.remove();

    // Insert at new location
    if (afterElement) {
      listEl.insertBefore(draggedCardEl, afterElement);
    } else {
      listEl.appendChild(draggedCardEl);
    }

    // Also update internal state optimistically
    optimisticMoveInState(draggedCardId, columnId, afterId, beforeId);
    updateCardCounts();
  }

  // Send to server
  const cardId = draggedCardId;
  moveCard(cardId, columnId, afterId, beforeId).catch((err) => {
    console.error("Failed to move card:", err);
    // On failure, re-fetch the full board
    loadBoard();
  });
}

function getDragAfterElement(
  container: HTMLElement,
  y: number
): HTMLElement | null {
  const cardElements = Array.from(
    container.querySelectorAll<HTMLElement>(".card:not(.dragging)")
  );

  let closest: { element: HTMLElement | null; offset: number } = {
    element: null,
    offset: Number.NEGATIVE_INFINITY,
  };

  for (const child of cardElements) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;

    if (offset < 0 && offset > closest.offset) {
      closest = { element: child, offset };
    }
  }

  return closest.element;
}

function clearAllDropIndicators(): void {
  document.querySelectorAll(".drop-target-above").forEach((el) => {
    el.classList.remove("drop-target-above");
  });
  document.querySelectorAll(".drop-target-below").forEach((el) => {
    el.classList.remove("drop-target-below");
  });
  document.querySelectorAll(".drag-over").forEach((el) => {
    el.classList.remove("drag-over");
  });
}

// ── Optimistic state updates ────────────────────────────────────────────────

function optimisticMoveInState(
  cardId: string,
  targetColumnId: string,
  afterId: string | null,
  beforeId: string | null
): void {
  // Find and remove the card from its current column
  let card: Card | undefined;
  for (const col of boardState) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx !== -1) {
      card = col.cards.splice(idx, 1)[0];
      break;
    }
  }
  if (!card) return;

  // Find target column
  const targetCol = boardState.find((c) => c.id === targetColumnId);
  if (!targetCol) return;

  // Compute a rough position for optimistic state
  card.column_id = targetColumnId;

  const sortedCards = [...targetCol.cards].sort(
    (a, b) => a.position - b.position
  );

  if (afterId && beforeId) {
    const afterCard = sortedCards.find((c) => c.id === afterId);
    const beforeCard = sortedCards.find((c) => c.id === beforeId);
    if (afterCard && beforeCard) {
      card.position = (afterCard.position + beforeCard.position) / 2;
    }
  } else if (afterId) {
    const afterCard = sortedCards.find((c) => c.id === afterId);
    if (afterCard) {
      card.position = afterCard.position + 500;
    }
  } else if (beforeId) {
    const beforeCard = sortedCards.find((c) => c.id === beforeId);
    if (beforeCard) {
      card.position = beforeCard.position / 2;
    }
  } else {
    card.position = sortedCards.length > 0
      ? sortedCards[sortedCards.length - 1].position + 1000
      : 1000;
  }

  targetCol.cards.push(card);
}

function updateCardCounts(): void {
  for (const col of boardState) {
    const colEl = document.querySelector(
      `.column[data-column-id="${col.id}"]`
    );
    if (colEl) {
      const countEl = colEl.querySelector(".card-count");
      // Count cards currently in the DOM for this column
      const listEl = colEl.querySelector(".card-list");
      const cardCount = listEl
        ? listEl.querySelectorAll(".card").length
        : col.cards.length;
      if (countEl) {
        countEl.textContent = String(cardCount);
      }
    }
  }
}

// ── SSE Connection ──────────────────────────────────────────────────────────

function connectSSE(): void {
  const evtSource = new EventSource("/api/stream");

  evtSource.addEventListener("connected", () => {
    statusEl.textContent = "Connected";
    statusEl.className = "status connected";
  });

  evtSource.addEventListener("card_created", (e: MessageEvent) => {
    const card: Card = JSON.parse(e.data);
    handleCardCreated(card);
  });

  evtSource.addEventListener("card_moved", (e: MessageEvent) => {
    const card: Card = JSON.parse(e.data);
    handleCardMoved(card);
  });

  evtSource.addEventListener("column_renormalized", (e: MessageEvent) => {
    const data: { columnId: string; cards: Card[] } = JSON.parse(e.data);
    handleColumnRenormalized(data.columnId, data.cards);
  });

  evtSource.onerror = () => {
    statusEl.textContent = "Disconnected";
    statusEl.className = "status disconnected";
    // EventSource will auto-reconnect
  };

  evtSource.onopen = () => {
    statusEl.textContent = "Connected";
    statusEl.className = "status connected";
  };
}

function handleCardCreated(card: Card): void {
  const col = boardState.find((c) => c.id === card.column_id);
  if (!col) return;

  // Avoid duplicates
  if (col.cards.find((c) => c.id === card.id)) return;

  col.cards.push(card);
  renderColumnCards(col);
}

function handleCardMoved(card: Card): void {
  // Track which columns need re-rendering
  const columnsToRender = new Set<string>();

  // Remove card from all columns in state
  for (const col of boardState) {
    const idx = col.cards.findIndex((c) => c.id === card.id);
    if (idx !== -1) {
      col.cards.splice(idx, 1);
      columnsToRender.add(col.id);
    }
  }

  // Add to target column with canonical position
  const targetCol = boardState.find((c) => c.id === card.column_id);
  if (!targetCol) return;

  targetCol.cards.push(card);
  columnsToRender.add(targetCol.id);

  // Re-render affected columns
  for (const colId of columnsToRender) {
    const col = boardState.find((c) => c.id === colId);
    if (col) renderColumnCards(col);
  }
}

function handleColumnRenormalized(columnId: string, cards: Card[]): void {
  // First remove any of these cards from all columns
  const cardIds = new Set(cards.map((c) => c.id));
  for (const col of boardState) {
    const before = col.cards.length;
    col.cards = col.cards.filter((c) => !cardIds.has(c.id));
    if (col.cards.length !== before) {
      renderColumnCards(col);
    }
  }

  // Set the target column's cards
  const targetCol = boardState.find((c) => c.id === columnId);
  if (!targetCol) return;

  // Keep any cards that weren't in the renormalized set
  const existingNonRenormalized = targetCol.cards.filter(
    (c) => !cardIds.has(c.id)
  );
  targetCol.cards = [...existingNonRenormalized, ...cards];
  renderColumnCards(targetCol);
}

function renderColumnCards(column: Column): void {
  const listEl = document.querySelector(
    `.card-list[data-column-id="${column.id}"]`
  );
  if (!listEl) return;

  const sortedCards = [...column.cards].sort(
    (a, b) => a.position - b.position
  );

  listEl.innerHTML = "";
  for (const card of sortedCards) {
    listEl.appendChild(renderCard(card));
  }

  // Update count
  const colEl = listEl.closest(".column");
  if (colEl) {
    const countEl = colEl.querySelector(".card-count");
    if (countEl) {
      countEl.textContent = String(sortedCards.length);
    }
  }
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

async function loadBoard(): Promise<void> {
  try {
    boardState = await fetchBoard();
    renderBoard();
  } catch (err) {
    console.error("Failed to load board:", err);
  }
}

async function init(): Promise<void> {
  await loadBoard();
  connectSSE();
}

init();
