/**
 * Drag-and-drop module.
 *
 * Uses the HTML5 Drag-and-Drop API.
 *
 * Lifecycle:
 *   1. User grabs a card  → dragstart
 *   2. Card is dragged over a column / card  → dragover (shows drop indicator)
 *   3. Card is dropped  → drop (optimistic update + HTTP PATCH)
 *   4. dragend cleans up ghost / indicator regardless of outcome
 *
 * The module exports `initDrag(boardEl, onDrop)` where `onDrop` is called
 * with `{ cardId, targetColumnId, afterId, beforeId }`.
 */

/** Currently dragged card id */
let dragCardId = null;

/** Ghost element that follows the cursor */
let ghost = null;

/** The .card element being dragged (gets .dragging class) */
let dragEl = null;

/** Last known drop target info */
let dropTarget = { columnId: null, afterId: null, beforeId: null };

/** Active drop indicator element */
let activeIndicator = null;

/**
 * Initialise drag-and-drop on the board element.
 *
 * @param {HTMLElement} boardEl
 * @param {(info: {cardId:string, targetColumnId:string, afterId:string|null, beforeId:string|null}) => void} onDrop
 */
export function initDrag(boardEl, onDrop) {
  boardEl.addEventListener('dragstart', handleDragStart);
  boardEl.addEventListener('dragover',  handleDragOver);
  boardEl.addEventListener('dragleave', handleDragLeave);
  boardEl.addEventListener('drop',      handleDrop);
  boardEl.addEventListener('dragend',   handleDragEnd);

  function handleDragStart(e) {
    const cardEl = e.target.closest('.card');
    if (!cardEl) return;

    dragCardId = cardEl.dataset.cardId;
    dragEl = cardEl;

    // Create a ghost element that follows the cursor
    ghost = cardEl.cloneNode(true);
    ghost.classList.add('card-ghost');
    ghost.style.width = cardEl.offsetWidth + 'px';
    ghost.style.top  = '-9999px';
    ghost.style.left = '-9999px';
    document.body.appendChild(ghost);

    // Use a transparent 1×1 pixel as the native drag image so our ghost is the only visual
    const blank = document.createElement('canvas');
    blank.width = blank.height = 1;
    e.dataTransfer.setDragImage(blank, 0, 0);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragCardId);

    // Slight delay so the card doesn't disappear before the ghost appears
    requestAnimationFrame(() => cardEl.classList.add('dragging'));

    document.addEventListener('dragover', trackGhost);
  }

  function trackGhost(e) {
    if (!ghost) return;
    ghost.style.left = (e.clientX + 12) + 'px';
    ghost.style.top  = (e.clientY - 10) + 'px';
  }

  function handleDragOver(e) {
    if (!dragCardId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const colEl = e.target.closest('.column');
    if (!colEl) return;

    const columnId = colEl.dataset.columnId;
    colEl.classList.add('drag-over');

    // Determine insertion point
    const { afterId, beforeId, indicatorEl, insertBefore } = getDropPosition(e, colEl, columnId);

    dropTarget = { columnId, afterId, beforeId };

    // Move the drop indicator
    showIndicator(colEl, indicatorEl, insertBefore);
  }

  function handleDragLeave(e) {
    const colEl = e.target.closest('.column');
    if (!colEl) return;
    // Only remove highlight if we're truly leaving the column
    if (!colEl.contains(e.relatedTarget)) {
      colEl.classList.remove('drag-over');
      hideIndicator();
    }
  }

  function handleDrop(e) {
    e.preventDefault();
    const colEl = e.target.closest('.column');
    if (!colEl) return;

    colEl.classList.remove('drag-over');
    hideIndicator();

    if (!dragCardId) return;

    const { columnId, afterId, beforeId } = dropTarget;
    if (!columnId) return;

    onDrop({ cardId: dragCardId, targetColumnId: columnId, afterId, beforeId });
  }

  function handleDragEnd() {
    cleanup();
  }

  /* ── Helpers ─────────────────────────────────────────────────────────── */

  /**
   * Determine where in the column the card should be dropped.
   * Returns { afterId, beforeId, indicatorEl, insertBefore }.
   */
  function getDropPosition(e, colEl, columnId) {
    const cardEls = Array.from(colEl.querySelectorAll('.card:not(.dragging)'));

    if (cardEls.length === 0) {
      return { afterId: null, beforeId: null, indicatorEl: null, insertBefore: null };
    }

    // Find the card whose midpoint is closest below the cursor
    for (const cardEl of cardEls) {
      const rect = cardEl.getBoundingClientRect();
      const mid  = rect.top + rect.height / 2;
      if (e.clientY < mid) {
        // Insert before this card
        const beforeId = cardEl.dataset.cardId;
        const idx = cardEls.indexOf(cardEl);
        const afterId = idx > 0 ? cardEls[idx - 1].dataset.cardId : null;
        return { afterId, beforeId, indicatorEl: cardEl, insertBefore: true };
      }
    }

    // Insert after the last card
    const lastCard = cardEls[cardEls.length - 1];
    return {
      afterId:  lastCard.dataset.cardId,
      beforeId: null,
      indicatorEl: lastCard,
      insertBefore: false,
    };
  }

  function showIndicator(colEl, referenceEl, insertBefore) {
    hideIndicator();

    const indicator = document.createElement('div');
    indicator.className = 'drop-indicator visible';
    activeIndicator = indicator;

    const list = colEl.querySelector('.card-list');
    if (!referenceEl) {
      list.appendChild(indicator);
    } else if (insertBefore) {
      list.insertBefore(indicator, referenceEl);
    } else {
      referenceEl.insertAdjacentElement('afterend', indicator);
    }
  }

  function hideIndicator() {
    if (activeIndicator) {
      activeIndicator.remove();
      activeIndicator = null;
    }
    // Remove drag-over from all columns
    document.querySelectorAll('.column.drag-over').forEach(c => c.classList.remove('drag-over'));
  }

  function cleanup() {
    if (dragEl) { dragEl.classList.remove('dragging'); dragEl = null; }
    if (ghost)  { ghost.remove(); ghost = null; }
    hideIndicator();
    document.removeEventListener('dragover', trackGhost);
    dragCardId = null;
    dropTarget = { columnId: null, afterId: null, beforeId: null };
  }
}
