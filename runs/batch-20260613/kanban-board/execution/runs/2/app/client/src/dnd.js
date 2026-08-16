/**
 * Drag-and-drop module.
 *
 * Uses the HTML5 Drag and Drop API.
 *
 * Responsibilities:
 *  - Track which card is being dragged.
 *  - Show a drop indicator (a thin blue line) between cards or at the top/bottom
 *    of a column as the user drags over it.
 *  - On drop, call the provided `onDrop` callback with:
 *      { cardId, targetColumnId, beforeId, afterId }
 *    where beforeId is the card above the insertion point (null = top)
 *    and afterId is the card below (null = bottom).
 */

export class DragAndDrop {
  /**
   * @param {(info: {cardId:string, targetColumnId:string, beforeId:string|null, afterId:string|null}) => void} onDrop
   */
  constructor(onDrop) {
    this._onDrop = onDrop;
    this._draggingCardId = null;
    this._indicator = null; // current drop indicator element
    this._indicatorParent = null;
    this._indicatorBefore = null; // element the indicator is inserted before (null = append)
  }

  // -------------------------------------------------------------------------
  // Public: attach listeners to a card element
  // -------------------------------------------------------------------------
  attachCard(cardEl, cardId) {
    cardEl.setAttribute('draggable', 'true');
    cardEl.dataset.cardId = cardId;

    cardEl.addEventListener('dragstart', (e) => this._onDragStart(e, cardId));
    cardEl.addEventListener('dragend',   (e) => this._onDragEnd(e));
  }

  // -------------------------------------------------------------------------
  // Public: attach listeners to a card-list (column body) element
  // -------------------------------------------------------------------------
  attachList(listEl, columnId) {
    listEl.dataset.columnId = columnId;

    listEl.addEventListener('dragover',  (e) => this._onDragOver(e, listEl, columnId));
    listEl.addEventListener('dragleave', (e) => this._onDragLeave(e, listEl));
    listEl.addEventListener('drop',      (e) => this._onDrop(e, listEl, columnId));
  }

  // -------------------------------------------------------------------------
  // Internal: drag lifecycle
  // -------------------------------------------------------------------------
  _onDragStart(e, cardId) {
    this._draggingCardId = cardId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', cardId);

    // Slight delay so the ghost image is captured before we add the class
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-card-id="${cardId}"]`);
      if (el) el.classList.add('dragging');
    });
  }

  _onDragEnd(_e) {
    if (this._draggingCardId) {
      const el = document.querySelector(`[data-card-id="${this._draggingCardId}"]`);
      if (el) el.classList.remove('dragging');
    }
    this._draggingCardId = null;
    this._removeIndicator();
  }

  // -------------------------------------------------------------------------
  // Internal: dragover – compute insertion point and show indicator
  // -------------------------------------------------------------------------
  _onDragOver(e, listEl, _columnId) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const { beforeEl, afterEl } = this._getInsertionPoint(e, listEl);

    // Position the indicator
    this._placeIndicator(listEl, afterEl);

    // Visual feedback for empty column
    const cards = listEl.querySelectorAll('.card:not(.dragging)');
    if (cards.length === 0) {
      listEl.classList.add('drag-over-empty');
    } else {
      listEl.classList.remove('drag-over-empty');
    }
  }

  _onDragLeave(e, listEl) {
    // Only remove if we're truly leaving the list (not entering a child)
    if (!listEl.contains(e.relatedTarget)) {
      this._removeIndicator();
      listEl.classList.remove('drag-over-empty');
    }
  }

  _onDrop(e, listEl, columnId) {
    e.preventDefault();
    listEl.classList.remove('drag-over-empty');

    const cardId = e.dataTransfer.getData('text/plain') || this._draggingCardId;
    if (!cardId) return;

    const { beforeEl, afterEl } = this._getInsertionPoint(e, listEl);

    const beforeId = beforeEl ? beforeEl.dataset.cardId : null;
    const afterId  = afterEl  ? afterEl.dataset.cardId  : null;

    this._removeIndicator();

    // Don't fire if dropped in the same position
    const sourceCard = document.querySelector(`[data-card-id="${cardId}"]`);
    const sourceColumn = sourceCard?.closest('[data-column-id]')?.dataset.columnId;
    if (
      sourceColumn === columnId &&
      beforeId === cardId // dropped on itself
    ) {
      return;
    }

    this._onDrop({ cardId, targetColumnId: columnId, beforeId, afterId });
  }

  // -------------------------------------------------------------------------
  // Internal: compute insertion point from mouse position
  // -------------------------------------------------------------------------
  /**
   * Returns { beforeEl, afterEl } where:
   *   beforeEl = the card element that will be ABOVE the drop point (null = top)
   *   afterEl  = the card element that will be BELOW the drop point (null = bottom)
   */
  _getInsertionPoint(e, listEl) {
    const cards = [...listEl.querySelectorAll('.card:not(.dragging)')];

    if (cards.length === 0) {
      return { beforeEl: null, afterEl: null };
    }

    const mouseY = e.clientY;

    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (mouseY < midY) {
        // Insert before cards[i]
        return {
          beforeEl: i > 0 ? cards[i - 1] : null,
          afterEl:  cards[i],
        };
      }
    }

    // Insert after the last card
    return { beforeEl: cards[cards.length - 1], afterEl: null };
  }

  // -------------------------------------------------------------------------
  // Internal: drop indicator management
  // -------------------------------------------------------------------------
  _placeIndicator(listEl, afterEl) {
    // Avoid redundant DOM mutations
    if (this._indicatorParent === listEl && this._indicatorBefore === afterEl) return;

    this._removeIndicator();

    const indicator = document.createElement('div');
    indicator.className = 'drop-indicator';
    this._indicator = indicator;
    this._indicatorParent = listEl;
    this._indicatorBefore = afterEl;

    if (afterEl) {
      listEl.insertBefore(indicator, afterEl);
    } else {
      listEl.appendChild(indicator);
    }
  }

  _removeIndicator() {
    if (this._indicator && this._indicator.parentNode) {
      this._indicator.parentNode.removeChild(this._indicator);
    }
    this._indicator = null;
    this._indicatorParent = null;
    this._indicatorBefore = null;
  }
}
