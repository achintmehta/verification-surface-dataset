/**
 * Drag-and-drop module.
 *
 * Uses the HTML5 Drag-and-Drop API.
 *
 * Terminology used throughout:
 *   - "dragged card"  – the card element being dragged
 *   - "ghost"         – a placeholder element shown at the drop position
 *   - "beforeId"      – id of the card immediately ABOVE the drop slot
 *   - "afterId"       – id of the card immediately BELOW the drop slot
 *
 * On drop, calls the provided `onDrop` callback with:
 *   { cardId, targetColumnId, beforeId, afterId }
 */

let draggedCardId = null;
let draggedCardEl = null;
let ghostEl = null;

// Track whether listeners have been attached to avoid duplicates
let _boardEl = null;
let _dropHandler = null;

/**
 * Attach drag-and-drop listeners to the board container.
 * Safe to call multiple times – removes old listeners first.
 *
 * @param {HTMLElement} boardEl
 * @param {(info: {cardId:string, targetColumnId:string, beforeId:string|null, afterId:string|null}) => void} onDrop
 */
export function initDragAndDrop(boardEl, onDrop) {
  // Remove previous listeners if re-initializing
  if (_boardEl) {
    _boardEl.removeEventListener('dragstart', handleDragStart);
    _boardEl.removeEventListener('dragend', handleDragEnd);
    _boardEl.removeEventListener('dragover', handleDragOver);
    _boardEl.removeEventListener('dragenter', handleDragEnter);
    _boardEl.removeEventListener('dragleave', handleDragLeave);
    if (_dropHandler) _boardEl.removeEventListener('drop', _dropHandler);
  }

  _boardEl = boardEl;
  _dropHandler = (e) => handleDrop(e, onDrop);

  boardEl.addEventListener('dragstart', handleDragStart);
  boardEl.addEventListener('dragend', handleDragEnd);
  boardEl.addEventListener('dragover', handleDragOver);
  boardEl.addEventListener('dragenter', handleDragEnter);
  boardEl.addEventListener('dragleave', handleDragLeave);
  boardEl.addEventListener('drop', _dropHandler);
}

/* ------------------------------------------------------------------ */
/*  Ghost helpers                                                       */
/* ------------------------------------------------------------------ */

function createGhost() {
  const el = document.createElement('div');
  el.className = 'card card-ghost';
  el.dataset.ghost = 'true';
  return el;
}

function removeGhost() {
  if (ghostEl && ghostEl.parentNode) {
    ghostEl.parentNode.removeChild(ghostEl);
  }
  ghostEl = null;
}

/* ------------------------------------------------------------------ */
/*  Event handlers                                                      */
/* ------------------------------------------------------------------ */

function handleDragStart(e) {
  const card = e.target.closest('.card:not(.card-ghost)');
  if (!card) return;

  draggedCardId = card.dataset.cardId;
  draggedCardEl = card;

  // Use a slight delay so the browser can capture the drag image before
  // we apply the "dragging" class (which makes the card semi-transparent).
  requestAnimationFrame(() => {
    if (draggedCardEl) draggedCardEl.classList.add('dragging');
  });

  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', draggedCardId);
}

function handleDragEnd(_e) {
  if (draggedCardEl) {
    draggedCardEl.classList.remove('dragging');
  }
  removeGhost();
  draggedCardId = null;
  draggedCardEl = null;

  // Remove drag-over highlights
  document.querySelectorAll('.card-list.drag-over').forEach((el) => {
    el.classList.remove('drag-over');
  });
}

function handleDragEnter(e) {
  const list = e.target.closest('.card-list');
  if (list) list.classList.add('drag-over');
}

function handleDragLeave(e) {
  const list = e.target.closest('.card-list');
  if (!list) return;
  // Only remove if we're actually leaving the list (not entering a child)
  if (!list.contains(e.relatedTarget)) {
    list.classList.remove('drag-over');
  }
}

function handleDragOver(e) {
  if (!draggedCardId) return;

  const list = e.target.closest('.card-list');
  if (!list) return;

  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  // Determine where to insert the ghost
  const { insertBefore } = getInsertionPoint(list, e.clientY);

  // Move or insert ghost
  if (!ghostEl) ghostEl = createGhost();

  if (insertBefore) {
    if (ghostEl.nextSibling !== insertBefore) {
      list.insertBefore(ghostEl, insertBefore);
    }
  } else {
    if (list.lastChild !== ghostEl) {
      list.appendChild(ghostEl);
    }
  }
}

function handleDrop(e, onDrop) {
  e.preventDefault();

  const list = e.target.closest('.card-list');
  if (!list || !draggedCardId || !ghostEl) {
    removeGhost();
    return;
  }

  const targetColumnId = list.closest('.column').dataset.columnId;

  // Determine neighbours from ghost position
  const { beforeId, afterId } = getNeighboursFromGhost(list);

  // Remove ghost before calling onDrop so the DOM is clean
  removeGhost();

  onDrop({ cardId: draggedCardId, targetColumnId, beforeId, afterId });
}

/* ------------------------------------------------------------------ */
/*  Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Given a card-list element and a Y coordinate, return the card element
 * that the ghost should be inserted before (or null to append at end).
 * Skips the dragged card and any existing ghost.
 */
function getInsertionPoint(list, clientY) {
  const cards = [...list.querySelectorAll('.card:not(.card-ghost):not(.dragging)')];

  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (clientY < midY) {
      return { insertBefore: card };
    }
  }
  return { insertBefore: null };
}

/**
 * After the ghost is positioned in the list, determine the card ids
 * immediately above and below it (excluding the dragged card itself).
 */
function getNeighboursFromGhost(list) {
  const children = [...list.children].filter(
    (el) => !el.dataset.ghost && el.dataset.cardId !== draggedCardId
  );

  const ghostIndex = [...list.children].indexOf(ghostEl);
  if (ghostIndex === -1) return { beforeId: null, afterId: null };

  // Count how many non-ghost, non-dragged cards are before the ghost
  let beforeCount = 0;
  for (let i = 0; i < ghostIndex; i++) {
    const el = list.children[i];
    if (!el.dataset.ghost && el.dataset.cardId !== draggedCardId) beforeCount++;
  }

  const beforeCard = children[beforeCount - 1] ?? null;
  const afterCard = children[beforeCount] ?? null;

  return {
    beforeId: beforeCard ? beforeCard.dataset.cardId : null,
    afterId: afterCard ? afterCard.dataset.cardId : null,
  };
}
