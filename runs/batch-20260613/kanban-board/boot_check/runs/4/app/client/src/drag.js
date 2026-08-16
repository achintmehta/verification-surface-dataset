/**
 * Drag-and-drop implementation using the HTML5 Drag and Drop API.
 *
 * Strategy:
 *  1. dragstart  – record the dragged card id and source column id.
 *  2. dragover   – compute the insertion point and show a drop indicator.
 *  3. drop       – read the insertion point, call the move callback.
 *  4. dragend    – clean up all drag state.
 */

let dragCardId     = null;
let dragSrcColId   = null;
let indicatorEl    = null;   // the blue line shown during drag
let dropTarget     = null;   // { columnId, beforeId, afterId }

/* ------------------------------------------------------------------ */
/*  Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Attach drag-and-drop listeners to the board element.
 * Uses event delegation so dynamically added cards are covered.
 *
 * @param {HTMLElement} boardEl
 * @param {Function}    onDrop  – called with (cardId, columnId, beforeId, afterId)
 */
export function initDragAndDrop(boardEl, onDrop) {
  boardEl.addEventListener('dragstart', handleDragStart);
  boardEl.addEventListener('dragover',  handleDragOver);
  boardEl.addEventListener('dragleave', handleDragLeave);
  boardEl.addEventListener('drop',      (e) => handleDrop(e, onDrop));
  boardEl.addEventListener('dragend',   handleDragEnd);
}

/* ------------------------------------------------------------------ */
/*  Handlers                                                            */
/* ------------------------------------------------------------------ */

function handleDragStart(e) {
  const cardEl = e.target.closest('.card');
  if (!cardEl) return;

  dragCardId   = cardEl.dataset.cardId;
  dragSrcColId = cardEl.dataset.columnId;

  // Use a ghost image (the card itself, slightly transparent)
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragCardId);

  // Defer adding the class so the ghost image is captured first
  requestAnimationFrame(() => cardEl.classList.add('dragging'));
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  const listEl = e.target.closest('.card-list');
  if (!listEl) return;

  const columnId = listEl.dataset.columnId;

  // Highlight the column
  document.querySelectorAll('.column.drag-over').forEach(el => {
    if (el.dataset.columnId !== columnId) el.classList.remove('drag-over');
  });
  listEl.closest('.column').classList.add('drag-over');

  // Compute insertion point
  const { beforeId, afterId, refEl } = getInsertionPoint(listEl, e.clientY);
  dropTarget = { columnId, beforeId, afterId };

  // Move / create the indicator
  showIndicator(listEl, refEl, beforeId, afterId);
}

function handleDragLeave(e) {
  // Only clear if we're leaving the board entirely
  const related = e.relatedTarget;
  if (!related || !e.currentTarget.contains(related)) {
    clearDragState();
  }
}

function handleDrop(e, onDrop) {
  e.preventDefault();
  if (!dropTarget || !dragCardId) return;

  const { columnId, beforeId, afterId } = dropTarget;
  onDrop(dragCardId, columnId, beforeId, afterId);

  clearDragState();
}

function handleDragEnd() {
  clearDragState();
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Determine where in the list the card should be inserted.
 *
 * Returns:
 *   beforeId – id of the card that will be immediately BEFORE the drop (lower position)
 *   afterId  – id of the card that will be immediately AFTER  the drop (higher position)
 *   refEl    – the card element after which the indicator should appear
 *              (null → prepend indicator)
 */
function getInsertionPoint(listEl, clientY) {
  const cards = [...listEl.querySelectorAll('.card:not(.dragging)')];

  if (cards.length === 0) {
    return { beforeId: null, afterId: null, refEl: null };
  }

  for (let i = 0; i < cards.length; i++) {
    const rect = cards[i].getBoundingClientRect();
    const mid  = rect.top + rect.height / 2;

    if (clientY < mid) {
      // Insert before cards[i]
      return {
        beforeId: i > 0 ? cards[i - 1].dataset.cardId : null,
        afterId:  cards[i].dataset.cardId,
        refEl:    i > 0 ? cards[i - 1] : null,
      };
    }
  }

  // Insert after the last card
  return {
    beforeId: cards[cards.length - 1].dataset.cardId,
    afterId:  null,
    refEl:    cards[cards.length - 1],
  };
}

function showIndicator(listEl, refEl, beforeId, afterId) {
  removeIndicator();

  indicatorEl = document.createElement('div');
  indicatorEl.className = 'drop-indicator';

  if (refEl) {
    refEl.after(indicatorEl);
  } else {
    listEl.prepend(indicatorEl);
  }
}

function removeIndicator() {
  if (indicatorEl) {
    indicatorEl.remove();
    indicatorEl = null;
  }
}

function clearDragState() {
  removeIndicator();
  document.querySelectorAll('.card.dragging').forEach(el => el.classList.remove('dragging'));
  document.querySelectorAll('.column.drag-over').forEach(el => el.classList.remove('drag-over'));
  dragCardId   = null;
  dragSrcColId = null;
  dropTarget   = null;
}
