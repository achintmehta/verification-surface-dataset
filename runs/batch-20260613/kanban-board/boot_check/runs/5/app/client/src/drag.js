/**
 * Drag-and-drop logic for the Kanban board.
 *
 * Uses the HTML5 Drag-and-Drop API.
 * Emits a custom 'card:drop' event on the board element when a card is
 * successfully dropped, carrying:
 *   { cardId, targetColumnId, beforeId, afterId }
 *
 * The main module listens for this event, performs the optimistic update,
 * and fires the API call.
 */

/** @type {string|null} */
let draggingCardId = null;

/** @type {HTMLElement|null} */
let ghostEl = null;

/** @type {HTMLElement|null} */
let lastDragOverList = null;

/**
 * Attach drag-and-drop listeners to a card element.
 * @param {HTMLElement} cardEl
 * @param {string} cardId
 */
export function makeCardDraggable(cardEl, cardId) {
  cardEl.setAttribute('draggable', 'true');

  cardEl.addEventListener('dragstart', (e) => {
    draggingCardId = cardId;
    cardEl.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', cardId);

    // Create ghost placeholder with same dimensions
    ghostEl = document.createElement('div');
    ghostEl.className = 'card card-ghost';
    ghostEl.style.height = `${cardEl.offsetHeight}px`;
    ghostEl.dataset.ghost = 'true';
  });

  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('dragging');
    draggingCardId = null;
    removeGhost();
    // Remove all drag-over highlights
    document.querySelectorAll('.card-list.drag-over').forEach((el) => {
      el.classList.remove('drag-over');
    });
    lastDragOverList = null;
  });
}

/**
 * Attach drop-zone listeners to a card-list element.
 * @param {HTMLElement} listEl
 * @param {string} columnId
 * @param {HTMLElement} boardEl  the board root (receives the 'card:drop' event)
 */
export function makeListDroppable(listEl, columnId, boardEl) {
  listEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    if (lastDragOverList && lastDragOverList !== listEl) {
      lastDragOverList.classList.remove('drag-over');
    }
    listEl.classList.add('drag-over');
    lastDragOverList = listEl;

    // Position the ghost placeholder
    positionGhost(e, listEl);
  });

  listEl.addEventListener('dragleave', (e) => {
    // Only remove highlight if we're truly leaving the list
    if (!listEl.contains(e.relatedTarget)) {
      listEl.classList.remove('drag-over');
      removeGhost();
    }
  });

  listEl.addEventListener('drop', (e) => {
    e.preventDefault();
    listEl.classList.remove('drag-over');

    const cardId = e.dataTransfer.getData('text/plain') || draggingCardId;
    if (!cardId) return;

    const { beforeId, afterId } = getNeighbours(e, listEl, cardId);

    removeGhost();

    boardEl.dispatchEvent(new CustomEvent('card:drop', {
      bubbles: true,
      detail: { cardId, targetColumnId: columnId, beforeId, afterId },
    }));
  });
}

/* ------------------------------------------------------------------ */
/*  Ghost helpers                                                       */
/* ------------------------------------------------------------------ */

function positionGhost(e, listEl) {
  if (!ghostEl) return;

  const target = getCardUnderCursor(e, listEl);

  if (!target) {
    // Append at end
    if (ghostEl.parentElement !== listEl) listEl.appendChild(ghostEl);
  } else {
    const rect = target.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY < midY) {
      listEl.insertBefore(ghostEl, target);
    } else {
      listEl.insertBefore(ghostEl, target.nextSibling);
    }
  }
}

function removeGhost() {
  if (ghostEl && ghostEl.parentElement) {
    ghostEl.parentElement.removeChild(ghostEl);
  }
}

/* ------------------------------------------------------------------ */
/*  Neighbour detection                                                 */
/* ------------------------------------------------------------------ */

/**
 * Determine the beforeId / afterId based on where the ghost was placed.
 * beforeId = card directly above the drop slot
 * afterId  = card directly below the drop slot
 */
function getNeighbours(e, listEl, draggingId) {
  // Use ghost position if available, otherwise cursor position
  let insertBefore = null; // the card element that will be below the dropped card

  if (ghostEl && ghostEl.parentElement === listEl) {
    insertBefore = ghostEl.nextElementSibling;
    // Skip the ghost itself
    while (insertBefore && insertBefore.dataset.ghost) {
      insertBefore = insertBefore.nextElementSibling;
    }
  } else {
    const target = getCardUnderCursor(e, listEl);
    if (target) {
      const rect = target.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      insertBefore = e.clientY < midY ? target : target.nextElementSibling;
    }
  }

  // Collect real card elements (not ghost, not the dragging card)
  const cardEls = [...listEl.querySelectorAll('.card:not([data-ghost])')].filter(
    (el) => el.dataset.cardId !== draggingId,
  );

  if (cardEls.length === 0) {
    return { beforeId: null, afterId: null };
  }

  // Find the index of insertBefore among real cards
  let insertIdx = cardEls.length; // default: end
  if (insertBefore) {
    const idx = cardEls.indexOf(insertBefore);
    if (idx !== -1) insertIdx = idx;
  }

  const beforeId = insertIdx > 0               ? cardEls[insertIdx - 1].dataset.cardId : null;
  const afterId  = insertIdx < cardEls.length  ? cardEls[insertIdx].dataset.cardId     : null;

  return { beforeId, afterId };
}

function getCardUnderCursor(e, listEl) {
  const cards = [...listEl.querySelectorAll('.card:not([data-ghost])')];
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (e.clientY >= rect.top && e.clientY <= rect.bottom) return card;
  }
  return null;
}
