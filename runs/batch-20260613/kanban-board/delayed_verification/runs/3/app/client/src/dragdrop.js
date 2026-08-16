/**
 * Drag-and-drop module for the Kanban board.
 *
 * Uses the HTML5 Drag-and-Drop API.  Each card element is made draggable.
 * Drop targets are the card-list containers inside each column.
 *
 * The module fires a single callback `onDrop(cardId, targetColumnId, afterId, beforeId)`
 * when a card is successfully dropped.
 *
 * Ghost element
 * -------------
 * While dragging, the original card is made semi-transparent (via the
 * `dragging` CSS class).  A lightweight ghost placeholder is inserted at
 * the current hover position so the user can see where the card will land.
 */

let dragState = null; // { cardId, sourceColumnId, ghostEl }

/**
 * Initialise drag-and-drop on the board.
 *
 * @param {HTMLElement} boardEl  - the #board container
 * @param {Function}    onDrop   - callback(cardId, columnId, afterId, beforeId)
 */
export function initDragDrop(boardEl, onDrop) {
  // ── Drag start ────────────────────────────────────────────────────
  boardEl.addEventListener('dragstart', (e) => {
    const cardEl = e.target.closest('.card');
    if (!cardEl) return;

    const cardId = cardEl.dataset.cardId;
    const columnEl = cardEl.closest('.column');
    const sourceColumnId = columnEl?.dataset.columnId ?? null;

    dragState = {
      cardId,
      sourceColumnId,
      ghostEl: null,
    };

    // Use a transparent 1×1 image as the drag image so we control visuals
    const img = new Image();
    img.src =
      'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    e.dataTransfer.setDragImage(img, 0, 0);
    e.dataTransfer.effectAllowed = 'move';

    // Defer adding the class so the browser captures the original look
    requestAnimationFrame(() => cardEl.classList.add('dragging'));
  });

  // ── Drag over (fires on card-list and on individual cards) ─────────
  boardEl.addEventListener('dragover', (e) => {
    if (!dragState) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const listEl = e.target.closest('.card-list');
    if (!listEl) return;

    listEl.classList.add('drag-over');

    // Position the ghost placeholder
    positionGhost(listEl, e.clientY);
  });

  // ── Drag leave ────────────────────────────────────────────────────
  boardEl.addEventListener('dragleave', (e) => {
    const listEl = e.target.closest('.card-list');
    if (!listEl) return;

    // Only remove highlight if we actually left the list
    if (!listEl.contains(e.relatedTarget)) {
      listEl.classList.remove('drag-over');
      removeGhost();
    }
  });

  // ── Drop ──────────────────────────────────────────────────────────
  boardEl.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!dragState) return;

    const listEl = e.target.closest('.card-list');
    if (!listEl) {
      cleanup();
      return;
    }

    listEl.classList.remove('drag-over');

    const columnEl = listEl.closest('.column');
    const targetColumnId = columnEl?.dataset.columnId ?? null;
    if (!targetColumnId) {
      cleanup();
      return;
    }

    // Determine afterId / beforeId from ghost position
    const { afterId, beforeId } = getNeighbours(listEl, dragState.cardId);

    cleanup();

    onDrop(dragState?.cardId ?? null, targetColumnId, afterId, beforeId);
    dragState = null;
  });

  // ── Drag end (fires even if drop was cancelled) ────────────────────
  boardEl.addEventListener('dragend', () => {
    cleanup();
    dragState = null;
  });
}

/* ------------------------------------------------------------------ */
/*  Ghost placeholder                                                   */
/* ------------------------------------------------------------------ */

function positionGhost(listEl, clientY) {
  // Find the card element we are hovering over
  const cards = [...listEl.querySelectorAll('.card:not(.dragging):not(.card-ghost)')];

  let referenceEl = null; // insert ghost before this element (null → append)

  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (clientY < midY) {
      referenceEl = card;
      break;
    }
  }

  // Create ghost if it doesn't exist yet
  if (!dragState.ghostEl) {
    const ghost = document.createElement('div');
    ghost.className = 'card card-ghost';
    ghost.style.height = getSourceCardHeight() + 'px';
    dragState.ghostEl = ghost;
  }

  // Insert at the right position
  if (referenceEl) {
    listEl.insertBefore(dragState.ghostEl, referenceEl);
  } else {
    listEl.appendChild(dragState.ghostEl);
  }
}

function removeGhost() {
  if (dragState?.ghostEl) {
    dragState.ghostEl.remove();
    dragState.ghostEl = null;
  }
}

function getSourceCardHeight() {
  if (!dragState) return 40;
  const el = document.querySelector(`[data-card-id="${dragState.cardId}"]`);
  return el ? el.offsetHeight : 40;
}

/* ------------------------------------------------------------------ */
/*  Neighbour resolution                                                */
/* ------------------------------------------------------------------ */

/**
 * Given the ghost's current position in the list, return the ids of the
 * cards immediately above (afterId) and below (beforeId) the drop slot.
 */
function getNeighbours(listEl, draggingCardId) {
  // All rendered cards in the list, excluding the dragging card and ghost
  const cards = [
    ...listEl.querySelectorAll('.card:not(.dragging):not(.card-ghost)'),
  ];

  const ghostEl = dragState?.ghostEl;
  if (!ghostEl || !ghostEl.parentElement) {
    // Ghost not in DOM – append at end
    const lastCard = cards[cards.length - 1];
    return {
      afterId: lastCard?.dataset.cardId ?? null,
      beforeId: null,
    };
  }

  // Find ghost index among all children (cards + ghost)
  const children = [...listEl.children];
  const ghostIndex = children.indexOf(ghostEl);

  // Cards before and after the ghost
  const before = children
    .slice(0, ghostIndex)
    .filter((el) => el.classList.contains('card') && !el.classList.contains('card-ghost') && el.dataset.cardId !== draggingCardId);

  const after = children
    .slice(ghostIndex + 1)
    .filter((el) => el.classList.contains('card') && !el.classList.contains('card-ghost') && el.dataset.cardId !== draggingCardId);

  return {
    afterId: before.length > 0 ? before[before.length - 1].dataset.cardId : null,
    beforeId: after.length > 0 ? after[0].dataset.cardId : null,
  };
}

/* ------------------------------------------------------------------ */
/*  Cleanup                                                             */
/* ------------------------------------------------------------------ */

function cleanup() {
  removeGhost();

  // Remove dragging class from the card
  if (dragState?.cardId) {
    const el = document.querySelector(`[data-card-id="${dragState.cardId}"]`);
    el?.classList.remove('dragging');
  }

  // Remove all drag-over highlights
  document.querySelectorAll('.card-list.drag-over').forEach((el) =>
    el.classList.remove('drag-over')
  );
}
