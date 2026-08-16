/**
 * drag.js – HTML5 drag-and-drop logic for the Kanban board.
 *
 * Design:
 *  - Each .card element is draggable.
 *  - Each .card-list element is a drop zone.
 *  - While dragging, a .drop-placeholder element is inserted to show where
 *    the card will land.
 *  - On drop, the caller-supplied `onDrop` callback receives the move intent.
 *
 * The module is stateless between drags; all drag state lives in module-level
 * variables that are reset on dragend.
 */

/** @type {HTMLElement|null} Currently dragged card element. */
let draggedCard = null;

/** @type {HTMLElement|null} Visual placeholder shown at the drop target. */
let placeholder = null;

/** @type {string|null} data-card-id of the dragged card. */
let draggedCardId = null;

/** @type {string|null} data-column-id of the column the drag started in. */
let sourceColumnId = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createPlaceholder() {
  const el = document.createElement('div');
  el.className = 'drop-placeholder';
  return el;
}

/**
 * Given a card-list element and the current cursor Y position, determine
 * where a dropped card should be inserted.
 *
 * Returns the card element that should come immediately BEFORE the drop
 * position (beforeEl) and the one immediately AFTER (afterEl).
 * Either may be null (meaning "insert at start" or "insert at end").
 *
 * @param {HTMLElement} list
 * @param {number}      clientY
 * @returns {{ beforeEl: HTMLElement|null, afterEl: HTMLElement|null }}
 */
function getInsertionPoint(list, clientY) {
  // Collect all real card elements, excluding the dragged card and the
  // placeholder so they don't affect the geometry calculation.
  const cards = [...list.querySelectorAll('.card')]
    .filter(el => el !== draggedCard && !el.classList.contains('dragging'));

  if (cards.length === 0) {
    return { beforeEl: null, afterEl: null };
  }

  for (let i = 0; i < cards.length; i++) {
    const rect = cards[i].getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (clientY < midY) {
      return {
        beforeEl: i > 0 ? cards[i - 1] : null,
        afterEl:  cards[i],
      };
    }
  }

  // Cursor is below all cards → append at end.
  return { beforeEl: cards[cards.length - 1], afterEl: null };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attach drag event listeners to a card element.
 *
 * @param {HTMLElement} cardEl
 */
export function makeDraggable(cardEl) {
  cardEl.setAttribute('draggable', 'true');

  cardEl.addEventListener('dragstart', (e) => {
    draggedCard    = cardEl;
    draggedCardId  = cardEl.dataset.cardId;
    sourceColumnId = cardEl.closest('.card-list')?.dataset.columnId ?? null;
    placeholder    = createPlaceholder();

    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', draggedCardId);

    // Apply the .dragging class after the browser has captured the drag image.
    requestAnimationFrame(() => {
      if (draggedCard) draggedCard.classList.add('dragging');
    });
  });

  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('dragging');
    placeholder?.remove();
    placeholder = null;

    // Remove drag-over highlights from all lists.
    document.querySelectorAll('.card-list.drag-over')
      .forEach(el => el.classList.remove('drag-over'));

    draggedCard    = null;
    draggedCardId  = null;
    sourceColumnId = null;
  });
}

/**
 * Attach drop-zone behaviour to a card-list element.
 *
 * @param {HTMLElement} listEl
 * @param {string}      columnId
 * @param {(intent: {
 *   cardId:   string,
 *   columnId: string,
 *   beforeId: string|null,
 *   afterId:  string|null
 * }) => void} onDrop
 */
export function makeDropZone(listEl, columnId, onDrop) {
  listEl.addEventListener('dragover', (e) => {
    if (!draggedCard) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    listEl.classList.add('drag-over');

    const { beforeEl, afterEl } = getInsertionPoint(listEl, e.clientY);

    // Move the placeholder to the correct insertion point.
    if (afterEl) {
      listEl.insertBefore(placeholder, afterEl);
    } else {
      listEl.appendChild(placeholder);
    }
  });

  listEl.addEventListener('dragleave', (e) => {
    // Only remove the highlight when the pointer truly leaves the list
    // (not when it moves over a child element).
    if (!listEl.contains(e.relatedTarget)) {
      listEl.classList.remove('drag-over');
    }
  });

  listEl.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!draggedCard || !draggedCardId) return;

    listEl.classList.remove('drag-over');

    const { beforeEl, afterEl } = getInsertionPoint(listEl, e.clientY);

    const beforeId = beforeEl?.dataset.cardId ?? null;
    const afterId  = afterEl?.dataset.cardId  ?? null;

    // Avoid a no-op move: same column and the card's neighbours haven't changed.
    // We compare by card id rather than DOM element identity because the
    // dragged card's element may have been hidden (.dragging) during the drag.
    if (columnId === sourceColumnId) {
      // Get the ordered card ids in this list (excluding the dragged card).
      const siblings = [...listEl.querySelectorAll('.card')]
        .filter(el => el !== draggedCard && !el.classList.contains('dragging'))
        .map(el => el.dataset.cardId);

      const draggedIdx = [...listEl.querySelectorAll('.card')]
        .filter(el => !el.classList.contains('dragging'))
        .map(el => el.dataset.cardId)
        .indexOf(draggedCardId);

      // Determine what the current neighbours are.
      const currentBefore = draggedIdx > 0
        ? siblings[draggedIdx - 1] ?? null
        : null;
      const currentAfter = draggedIdx < siblings.length
        ? siblings[draggedIdx] ?? null
        : null;

      if (beforeId === currentBefore && afterId === currentAfter) {
        return; // No change.
      }
    }

    onDrop({ cardId: draggedCardId, columnId, beforeId, afterId });
  });
}
