/**
 * Drag-and-drop module.
 *
 * Uses the HTML5 Drag-and-Drop API.
 * Emits a custom 'card-drop' event on the board element with:
 *   detail: { cardId, targetColumnId, beforeId, afterId }
 *
 * beforeId = id of the card that will be ABOVE the dropped card (null = top)
 * afterId  = id of the card that will be BELOW the dropped card (null = bottom)
 */

let draggingCardId = null;
let draggingCardEl = null;
let ghostEl = null;

export function initDragAndDrop(boardEl) {
  boardEl.addEventListener('dragstart', onDragStart);
  boardEl.addEventListener('dragend', onDragEnd);
  boardEl.addEventListener('dragover', onDragOver);
  boardEl.addEventListener('dragenter', onDragEnter);
  boardEl.addEventListener('dragleave', onDragLeave);
  boardEl.addEventListener('drop', onDrop);
}

/* ------------------------------------------------------------------ */

function onDragStart(e) {
  const cardEl = e.target.closest('.card');
  if (!cardEl) return;

  draggingCardId = cardEl.dataset.cardId;
  draggingCardEl = cardEl;

  // Use a transparent drag image so we control the visual ourselves
  const blank = document.createElement('div');
  blank.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:1px;height:1px;';
  document.body.appendChild(blank);
  e.dataTransfer.setDragImage(blank, 0, 0);
  setTimeout(() => document.body.removeChild(blank), 0);

  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', draggingCardId);

  // Mark the source card
  requestAnimationFrame(() => {
    if (draggingCardEl) draggingCardEl.classList.add('dragging');
  });
}

function onDragEnd(_e) {
  if (draggingCardEl) draggingCardEl.classList.remove('dragging');
  removeGhost();
  clearDragOver();
  draggingCardId = null;
  draggingCardEl = null;
}

/* ------------------------------------------------------------------ */

function getCardList(e) {
  return e.target.closest('.card-list');
}

function onDragEnter(e) {
  const list = getCardList(e);
  if (!list) return;
  e.preventDefault();
  list.classList.add('drag-over');
}

function onDragLeave(e) {
  const list = getCardList(e);
  if (!list) return;
  // Only remove if we're truly leaving the list (not entering a child)
  if (!list.contains(e.relatedTarget)) {
    list.classList.remove('drag-over');
  }
}

function clearDragOver() {
  document.querySelectorAll('.card-list.drag-over').forEach((el) =>
    el.classList.remove('drag-over')
  );
}

/* ------------------------------------------------------------------ */

function onDragOver(e) {
  if (!draggingCardId) return;
  const list = getCardList(e);
  if (!list) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  // Move ghost to the right position
  const { beforeId, afterId, insertBefore } = getDropTarget(list, e.clientY);
  positionGhost(list, insertBefore);
}

function onDrop(e) {
  if (!draggingCardId) return;
  const list = getCardList(e);
  if (!list) return;
  e.preventDefault();

  const targetColumnId = list.closest('.column').dataset.columnId;
  const { beforeId, afterId } = getDropTarget(list, e.clientY);

  // Don't emit if dropped on itself with no change
  if (
    beforeId === draggingCardId ||
    afterId === draggingCardId
  ) {
    return;
  }

  const event = new CustomEvent('card-drop', {
    bubbles: true,
    detail: { cardId: draggingCardId, targetColumnId, beforeId, afterId },
  });
  list.dispatchEvent(event);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Given a card-list element and the cursor Y position, determine:
 *   - beforeId: card above the insertion point (null = insert at top)
 *   - afterId:  card below the insertion point (null = insert at bottom)
 *   - insertBefore: the DOM element to insert the ghost before (null = append)
 */
function getDropTarget(listEl, clientY) {
  const cards = [...listEl.querySelectorAll('.card:not(.dragging):not(.card-ghost)')];

  if (cards.length === 0) {
    return { beforeId: null, afterId: null, insertBefore: null };
  }

  for (let i = 0; i < cards.length; i++) {
    const rect = cards[i].getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (clientY < midY) {
      // Insert before cards[i]
      return {
        beforeId: i > 0 ? cards[i - 1].dataset.cardId : null,
        afterId: cards[i].dataset.cardId,
        insertBefore: cards[i],
      };
    }
  }

  // Insert after the last card
  return {
    beforeId: cards[cards.length - 1].dataset.cardId,
    afterId: null,
    insertBefore: null,
  };
}

function positionGhost(listEl, insertBeforeEl) {
  if (!ghostEl) {
    ghostEl = document.createElement('div');
    ghostEl.className = 'card card-ghost';
    ghostEl.style.height = draggingCardEl
      ? `${draggingCardEl.offsetHeight}px`
      : '60px';
  }

  if (insertBeforeEl) {
    listEl.insertBefore(ghostEl, insertBeforeEl);
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
