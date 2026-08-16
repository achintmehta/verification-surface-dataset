/**
 * Drag-and-drop module for the Kanban board.
 *
 * Uses the HTML5 Drag-and-Drop API.
 * Tracks the dragged card and computes beforeId / afterId neighbours
 * from the DOM at drop time, then calls the provided onDrop callback.
 *
 * onDrop({ cardId, targetColumnId, beforeId, afterId })
 *   - cardId:        the card being moved
 *   - targetColumnId: the column it was dropped into
 *   - beforeId:      id of the card that will come AFTER the dropped card (or null)
 *   - afterId:       id of the card that will come BEFORE the dropped card (or null)
 */

let dragState = null;
let ghostEl = null;

/**
 * Attach drag-and-drop listeners to a card element.
 * @param {HTMLElement} cardEl
 * @param {string}      cardId
 * @param {Function}    onDrop
 */
export function makeCardDraggable(cardEl, cardId, onDrop) {
  cardEl.setAttribute('draggable', 'true');

  cardEl.addEventListener('dragstart', (e) => {
    dragState = { cardId, sourceEl: cardEl, onDrop };
    cardEl.classList.add('dragging');
    // Use a transparent 1×1 image as the drag image so we control appearance
    const img = new Image();
    img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    e.dataTransfer.setDragImage(img, 0, 0);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', cardId);
  });

  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('dragging');
    removeGhost();
    // Clean up drag-over highlights
    document.querySelectorAll('.card-list.drag-over').forEach((el) => {
      el.classList.remove('drag-over');
    });
    dragState = null;
  });
}

/**
 * Attach drop-zone listeners to a card-list element.
 * @param {HTMLElement} listEl
 * @param {string}      columnId
 */
export function makeListDroppable(listEl, columnId) {
  listEl.addEventListener('dragover', (e) => {
    if (!dragState) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    listEl.classList.add('drag-over');
    positionGhost(listEl, e.clientY);
  });

  listEl.addEventListener('dragleave', (e) => {
    // Only remove highlight if we're leaving the list entirely
    if (!listEl.contains(e.relatedTarget)) {
      listEl.classList.remove('drag-over');
      removeGhost();
    }
  });

  listEl.addEventListener('drop', (e) => {
    e.preventDefault();
    listEl.classList.remove('drag-over');

    if (!dragState) return;

    const { cardId, onDrop } = dragState;
    const { beforeId, afterId } = getNeighboursFromGhost(listEl);

    removeGhost();

    // Don't fire if dropped in the exact same position
    if (beforeId === cardId || afterId === cardId) return;

    onDrop({ cardId, targetColumnId: columnId, beforeId, afterId });
  });
}

/* ── Ghost element helpers ───────────────────────────────── */

function ensureGhost() {
  if (!ghostEl) {
    ghostEl = document.createElement('div');
    ghostEl.className = 'card-ghost';
  }
  return ghostEl;
}

function removeGhost() {
  if (ghostEl && ghostEl.parentNode) {
    ghostEl.parentNode.removeChild(ghostEl);
  }
}

/**
 * Insert the ghost placeholder at the correct position within `listEl`
 * based on the cursor's Y coordinate.
 */
function positionGhost(listEl, clientY) {
  const ghost = ensureGhost();
  const cards = [...listEl.querySelectorAll('.card:not(.dragging)')];

  if (cards.length === 0) {
    listEl.appendChild(ghost);
    return;
  }

  // Find the card whose midpoint is below the cursor
  let insertBefore = null;
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (clientY < midY) {
      insertBefore = card;
      break;
    }
  }

  if (insertBefore) {
    listEl.insertBefore(ghost, insertBefore);
  } else {
    listEl.appendChild(ghost);
  }
}

/**
 * Determine the beforeId and afterId neighbours based on where the ghost
 * placeholder currently sits in the list.
 *
 * @returns {{ beforeId: string|null, afterId: string|null }}
 */
function getNeighboursFromGhost(listEl) {
  if (!ghostEl || !ghostEl.parentNode) {
    return { beforeId: null, afterId: null };
  }

  const children = [...listEl.children];
  const ghostIndex = children.indexOf(ghostEl);

  // afterId = the card immediately before the ghost (will come before dropped card)
  // beforeId = the card immediately after the ghost (will come after dropped card)
  let afterId = null;
  let beforeId = null;

  for (let i = ghostIndex - 1; i >= 0; i--) {
    const el = children[i];
    if (el.classList.contains('card') && !el.classList.contains('dragging')) {
      afterId = el.dataset.cardId;
      break;
    }
  }

  for (let i = ghostIndex + 1; i < children.length; i++) {
    const el = children[i];
    if (el.classList.contains('card') && !el.classList.contains('dragging')) {
      beforeId = el.dataset.cardId;
      break;
    }
  }

  return { beforeId, afterId };
}
