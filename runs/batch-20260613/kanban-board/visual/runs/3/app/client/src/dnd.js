/**
 * Drag-and-drop engine (pointer-events based, no HTML5 DnD API).
 *
 * Emits a single callback when a card is dropped:
 *   onDrop({ cardId, targetColumnId, beforeId, afterId })
 *
 * - beforeId: id of the card that will be ABOVE  the dropped card (null = top)
 * - afterId:  id of the card that will be BELOW  the dropped card (null = bottom)
 */

export function initDragAndDrop(onDrop) {
  let dragging = null;   // { cardId, ghost, originColumn, placeholder }
  let lastOver = null;   // { columnEl, beforeId, afterId, placeholderEl }

  // ── Pointer down on a card ────────────────────────────────────────────────
  document.addEventListener('pointerdown', e => {
    const cardEl = e.target.closest('.card');
    if (!cardEl) return;
    // Don't start drag on interactive children (textarea, button)
    if (e.target.closest('textarea, button, input')) return;

    e.preventDefault();

    const rect = cardEl.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;

    // Create ghost
    const ghost = cardEl.cloneNode(true);
    ghost.classList.add('ghost');
    ghost.style.width  = `${rect.width}px`;
    ghost.style.left   = `${rect.left}px`;
    ghost.style.top    = `${rect.top}px`;
    document.body.appendChild(ghost);

    // Mark original as dragging (semi-transparent placeholder in place)
    cardEl.classList.add('dragging');

    const columnEl = cardEl.closest('.column');

    dragging = {
      cardId:       cardEl.dataset.cardId,
      cardEl,
      ghost,
      offsetX,
      offsetY,
      originColumn: columnEl,
    };

    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
  });

  // ── Pointer move ──────────────────────────────────────────────────────────
  document.addEventListener('pointermove', e => {
    if (!dragging) return;
    e.preventDefault();

    const { ghost, offsetX, offsetY } = dragging;
    ghost.style.left = `${e.clientX - offsetX}px`;
    ghost.style.top  = `${e.clientY - offsetY}px`;

    // Find which column we're over
    ghost.style.pointerEvents = 'none';
    const target = document.elementFromPoint(e.clientX, e.clientY);
    ghost.style.pointerEvents = '';

    const columnEl = target?.closest('.column');
    if (!columnEl) return;

    const cardList = columnEl.querySelector('.card-list');
    if (!cardList) return;

    // Determine insertion point
    const { beforeId, afterId, refEl } = getInsertionPoint(cardList, e.clientY, dragging.cardId);

    // Move / create placeholder
    ensurePlaceholder(cardList, refEl);

    lastOver = { columnEl, beforeId, afterId };
  });

  // ── Pointer up ────────────────────────────────────────────────────────────
  document.addEventListener('pointerup', e => {
    if (!dragging) return;

    const { cardId, cardEl, ghost } = dragging;

    // Clean up ghost & dragging state
    ghost.remove();
    cardEl.classList.remove('dragging');
    removePlaceholder();

    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    if (lastOver) {
      const { columnEl, beforeId, afterId } = lastOver;
      const targetColumnId = columnEl.dataset.columnId;
      onDrop({ cardId, targetColumnId, beforeId, afterId });
    }

    dragging = null;
    lastOver = null;

    // Remove drag-over highlight from all columns
    document.querySelectorAll('.column.drag-over').forEach(c => c.classList.remove('drag-over'));
  });

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Given a card-list element and the current pointer Y, determine where to
   * insert the dragged card.
   *
   * Returns { beforeId, afterId, refEl } where refEl is the DOM element
   * AFTER which the placeholder should be inserted (null = prepend).
   */
  function getInsertionPoint(cardList, pointerY, draggedCardId) {
    const cards = [...cardList.querySelectorAll('.card:not(.dragging)')];

    if (cards.length === 0) {
      return { beforeId: null, afterId: null, refEl: null };
    }

    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      const mid  = rect.top + rect.height / 2;

      if (pointerY < mid) {
        // Insert before cards[i]
        return {
          beforeId: i > 0 ? cards[i - 1].dataset.cardId : null,
          afterId:  cards[i].dataset.cardId,
          refEl:    i > 0 ? cards[i - 1] : null,
        };
      }
    }

    // Insert after last card
    const last = cards[cards.length - 1];
    return {
      beforeId: last.dataset.cardId,
      afterId:  null,
      refEl:    last,
    };
  }

  let placeholderEl = null;

  function ensurePlaceholder(cardList, refEl) {
    // Highlight column
    document.querySelectorAll('.column.drag-over').forEach(c => c.classList.remove('drag-over'));
    cardList.closest('.column').classList.add('drag-over');

    if (!placeholderEl) {
      placeholderEl = document.createElement('div');
      placeholderEl.className = 'drop-placeholder';
    }

    if (refEl) {
      // Insert after refEl
      if (refEl.nextSibling !== placeholderEl) {
        refEl.after(placeholderEl);
      }
    } else {
      // Prepend
      if (cardList.firstChild !== placeholderEl) {
        cardList.prepend(placeholderEl);
      }
    }
  }

  function removePlaceholder() {
    if (placeholderEl) {
      placeholderEl.remove();
      placeholderEl = null;
    }
    document.querySelectorAll('.column.drag-over').forEach(c => c.classList.remove('drag-over'));
  }
}
