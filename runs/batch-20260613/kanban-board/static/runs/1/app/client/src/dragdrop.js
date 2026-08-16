/**
 * Drag-and-drop module.
 *
 * Uses the HTML5 Drag-and-Drop API.  A custom drag clone is rendered via a
 * fixed-position element so we can style it independently of the native ghost.
 *
 * Flow:
 *  1. dragstart  – record the dragged card id; show clone; hide original.
 *  2. dragover   – compute drop position; show indicator line.
 *  3. drop       – apply optimistic DOM update; fire PATCH request.
 *  4. dragend    – clean up clone and indicators.
 *
 * Optimistic update:
 *  On drop we immediately move the card element to the new position in the
 *  DOM.  When the server's SSE event arrives the `reconcileCard` function
 *  snaps the card to the canonical position (which may differ if two clients
 *  moved cards concurrently).
 */

import { moveCard } from './api.js';
import { getCardEl, getCardListEl, updateColumnCount } from './board.js';

/* ------------------------------------------------------------------ */
/*  Module-level drag state                                             */
/* ------------------------------------------------------------------ */

/** @type {{ cardId: string, sourceColumnId: string } | null} */
let dragState = null;

/** @type {HTMLElement | null} */
let cloneEl = null;

/** @type {HTMLElement | null} */
let indicatorEl = null;

/** @type {{ columnId: string, beforeEl: HTMLElement | null } | null} */
let dropTarget = null;

/* ------------------------------------------------------------------ */
/*  Initialise – attach listeners to the board via event delegation    */
/* ------------------------------------------------------------------ */

export function initDragDrop() {
  const board = document.getElementById('board');

  board.addEventListener('dragstart', onDragStart);
  board.addEventListener('dragover',  onDragOver);
  board.addEventListener('dragleave', onDragLeave);
  board.addEventListener('drop',      onDrop);
  board.addEventListener('dragend',   onDragEnd);

  // Track mouse position to move the clone.
  document.addEventListener('dragover', onDocDragOver, { passive: true });
}

/* ------------------------------------------------------------------ */
/*  Event handlers                                                      */
/* ------------------------------------------------------------------ */

/** @param {DragEvent} e */
function onDragStart(e) {
  const card = e.target.closest('.card');
  if (!card) return;

  const list = card.closest('.card-list');
  if (!list) return;

  dragState = {
    cardId: card.dataset.id,
    sourceColumnId: list.dataset.columnId,
  };

  // Use an empty image as the native drag ghost; we render our own clone.
  const empty = new Image();
  e.dataTransfer.setDragImage(empty, 0, 0);
  e.dataTransfer.effectAllowed = 'move';

  // Build the clone.
  cloneEl = card.cloneNode(true);
  cloneEl.id = 'drag-clone';
  cloneEl.style.width = `${card.offsetWidth}px`;
  document.body.appendChild(cloneEl);

  // Defer adding the .dragging class so the clone is visible first.
  requestAnimationFrame(() => {
    card.classList.add('dragging');
  });
}

/** @param {DragEvent} e */
function onDragOver(e) {
  if (!dragState) return;

  // Accept drops on the card-list OR anywhere else in the column
  // (header, add-card area) – in the latter case treat as "append to column".
  const list =
    e.target.closest('.card-list') ??
    e.target.closest('.column')?.querySelector('.card-list');
  if (!list) return;

  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  const columnId = list.dataset.columnId;

  // Determine which card (if any) the cursor is in the upper half of.
  const cards = Array.from(list.querySelectorAll('.card:not(.dragging)'));
  let beforeEl = null;

  for (const c of cards) {
    const rect = c.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY < midY) {
      beforeEl = c;
      break;
    }
  }

  dropTarget = { columnId, beforeEl };

  // Highlight the list.
  document.querySelectorAll('.card-list.drag-over').forEach((el) => {
    if (el !== list) el.classList.remove('drag-over');
  });
  list.classList.add('drag-over');

  // Show the drop indicator.
  showIndicator(list, beforeEl);
}

/** @param {DragEvent} e */
function onDragLeave(e) {
  const column = e.target.closest('.column');
  if (!column) return;

  // Only remove the highlight if we've truly left the column.
  const related = e.relatedTarget;
  if (related && column.contains(related)) return;

  const list = column.querySelector('.card-list');
  if (list) list.classList.remove('drag-over');
  removeIndicator();
  dropTarget = null;
}

/** @param {DragEvent} e */
function onDrop(e) {
  if (!dragState || !dropTarget) return;

  e.preventDefault();

  const { cardId, sourceColumnId } = dragState;
  const { columnId, beforeEl } = dropTarget;

  // Determine afterId (the card immediately above the drop position).
  const list = getCardListEl(columnId);
  if (!list) return;

  const cards = Array.from(list.querySelectorAll('.card:not(.dragging)'));
  let afterEl = null;

  if (beforeEl) {
    const idx = cards.indexOf(beforeEl);
    afterEl = idx > 0 ? cards[idx - 1] : null;
  } else {
    afterEl = cards.length > 0 ? cards[cards.length - 1] : null;
  }

  const afterId  = afterEl  ? afterEl.dataset.id  : null;
  const beforeId = beforeEl ? beforeEl.dataset.id : null;

  // ---- Optimistic DOM update ----------------------------------------
  const cardEl = getCardEl(cardId);
  if (cardEl) {
    // Compute an optimistic position for the data-position attribute.
    const afterPos  = afterEl  ? parseFloat(afterEl.dataset.position)  : null;
    const beforePos = beforeEl ? parseFloat(beforeEl.dataset.position) : null;

    let optimisticPos;
    if (afterPos === null && beforePos === null) {
      optimisticPos = 1000;
    } else if (afterPos === null) {
      optimisticPos = beforePos - 500;
    } else if (beforePos === null) {
      optimisticPos = afterPos + 1000;
    } else {
      optimisticPos = (afterPos + beforePos) / 2;
    }

    cardEl.dataset.position = String(optimisticPos);

    if (beforeEl) {
      list.insertBefore(cardEl, beforeEl);
    } else {
      list.appendChild(cardEl);
    }

    // Update counts if cross-column move.
    if (sourceColumnId !== columnId) {
      updateColumnCount(sourceColumnId);
      updateColumnCount(columnId);
    }
  }

  // ---- Fire the server request --------------------------------------
  moveCard(cardId, columnId, afterId, beforeId).catch((err) => {
    console.error('[dragdrop] moveCard failed:', err);
    // On error the SSE stream will not deliver a correction; we could
    // reload the board here as a fallback.
  });
}

/** @param {DragEvent} e */
function onDragEnd(e) {
  // Remove the dragging class from the original card.
  if (dragState) {
    const cardEl = getCardEl(dragState.cardId);
    if (cardEl) cardEl.classList.remove('dragging');
  }

  // Remove the clone.
  if (cloneEl) {
    cloneEl.remove();
    cloneEl = null;
  }

  // Clean up indicators and highlights.
  removeIndicator();
  document.querySelectorAll('.card-list.drag-over').forEach((el) => {
    el.classList.remove('drag-over');
  });

  dragState  = null;
  dropTarget = null;
}

/* ------------------------------------------------------------------ */
/*  Clone tracking                                                      */
/* ------------------------------------------------------------------ */

/** @param {MouseEvent} e */
function onDocDragOver(e) {
  if (!cloneEl) return;
  cloneEl.style.left = `${e.clientX + 12}px`;
  cloneEl.style.top  = `${e.clientY - 10}px`;
}

/* ------------------------------------------------------------------ */
/*  Drop indicator                                                      */
/* ------------------------------------------------------------------ */

/**
 * Show a horizontal line indicating where the card will be dropped.
 *
 * @param {HTMLElement}      list
 * @param {HTMLElement|null} beforeEl
 */
function showIndicator(list, beforeEl) {
  removeIndicator();

  indicatorEl = document.createElement('div');
  indicatorEl.className = 'drop-indicator';

  if (beforeEl) {
    list.insertBefore(indicatorEl, beforeEl);
  } else {
    list.appendChild(indicatorEl);
  }
}

function removeIndicator() {
  if (indicatorEl) {
    indicatorEl.remove();
    indicatorEl = null;
  }
}
