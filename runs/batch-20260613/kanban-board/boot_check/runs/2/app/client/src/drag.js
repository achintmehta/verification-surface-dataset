/**
 * Drag-and-drop logic for the Kanban board.
 *
 * Uses the HTML5 Drag and Drop API.
 * Provides:
 *   - onDragStart / onDragEnd  (attached to card elements)
 *   - onDragOver               (attached to card-list elements)
 *   - onDrop                   (attached to card-list elements)
 *
 * On drop, calls `onMoveCard(cardId, targetColumnId, beforeId, afterId)`
 * where beforeId/afterId are the neighbouring card ids (or null).
 */

let draggingCardId = null;
let draggingCardEl = null;
let ghostEl = null;

/**
 * @param {DragEvent} e
 * @param {HTMLElement} cardEl
 */
export function onDragStart(e, cardEl) {
  draggingCardId = cardEl.dataset.cardId;
  draggingCardEl = cardEl;

  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', draggingCardId);

  // Slight delay so the browser renders the drag image before we hide the element
  requestAnimationFrame(() => {
    cardEl.classList.add('dragging');
  });
}

/**
 * @param {DragEvent} _e
 * @param {HTMLElement} cardEl
 */
export function onDragEnd(_e, cardEl) {
  cardEl.classList.remove('dragging');
  removeGhost();
  // Remove drag-over highlights
  document.querySelectorAll('.card-list.drag-over').forEach((el) => {
    el.classList.remove('drag-over');
  });
  draggingCardId = null;
  draggingCardEl = null;
}

/**
 * @param {DragEvent} e
 * @param {HTMLElement} listEl  - the .card-list element
 */
export function onDragOver(e, listEl) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  listEl.classList.add('drag-over');

  // Position the ghost placeholder
  const insertBefore = getInsertBeforeElement(listEl, e.clientY);
  ensureGhost(listEl, insertBefore);
}

/**
 * @param {DragEvent} e
 * @param {HTMLElement} listEl
 * @param {function} onMoveCard  - (cardId, columnId, beforeId, afterId) => void
 */
export function onDrop(e, listEl, onMoveCard) {
  e.preventDefault();
  listEl.classList.remove('drag-over');

  const cardId = e.dataTransfer.getData('text/plain') || draggingCardId;
  if (!cardId) return;

  const targetColumnId = listEl.dataset.columnId;
  const insertBefore = getInsertBeforeElement(listEl, e.clientY);

  // Determine neighbour ids
  // Cards in the list (excluding ghost and the dragging card itself)
  const cardEls = [...listEl.querySelectorAll('.card:not(.dragging):not(.card-ghost)')];

  let beforeId = null; // card that will be immediately BEFORE the dropped card (lower pos)
  let afterId = null;  // card that will be immediately AFTER the dropped card (higher pos)

  if (insertBefore) {
    // insertBefore is the card that will come AFTER our dropped card
    afterId = insertBefore.dataset.cardId ?? null;
    const insertBeforeIdx = cardEls.indexOf(insertBefore);
    if (insertBeforeIdx > 0) {
      beforeId = cardEls[insertBeforeIdx - 1].dataset.cardId ?? null;
    }
  } else {
    // Dropping at the end
    if (cardEls.length > 0) {
      beforeId = cardEls[cardEls.length - 1].dataset.cardId ?? null;
    }
  }

  removeGhost();

  onMoveCard(cardId, targetColumnId, beforeId, afterId);
}

/* ── Ghost placeholder ────────────────────────────────────────────── */

function ensureGhost(listEl, insertBefore) {
  if (!ghostEl) {
    ghostEl = document.createElement('div');
    ghostEl.className = 'card-ghost';
  }
  if (insertBefore) {
    listEl.insertBefore(ghostEl, insertBefore);
  } else {
    listEl.appendChild(ghostEl);
  }
}

function removeGhost() {
  if (ghostEl && ghostEl.parentNode) {
    ghostEl.parentNode.removeChild(ghostEl);
  }
  ghostEl = null;
}

/* ── Utility ──────────────────────────────────────────────────────── */

/**
 * Given a card-list element and a Y coordinate, return the card element
 * that the dragged card should be inserted before (or null to append).
 */
function getInsertBeforeElement(listEl, clientY) {
  const draggableCards = [
    ...listEl.querySelectorAll('.card:not(.dragging):not(.card-ghost)'),
  ];

  let closest = null;
  let closestOffset = Infinity;

  for (const card of draggableCards) {
    const rect = card.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const offset = clientY - midY;

    // We want the first card whose midpoint is below the cursor
    if (offset < 0 && Math.abs(offset) < closestOffset) {
      closestOffset = Math.abs(offset);
      closest = card;
    }
  }

  return closest;
}
