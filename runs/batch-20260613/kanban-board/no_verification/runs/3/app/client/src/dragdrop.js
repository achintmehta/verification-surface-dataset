/**
 * Drag-and-drop engine for the Kanban board.
 *
 * Uses the HTML5 Drag-and-Drop API.  A ghost element follows the cursor for
 * visual feedback while the source card is dimmed in place.
 *
 * The module exposes:
 *   initDragDrop(boardEl, onDrop)
 *
 * `onDrop` is called with:
 *   { cardId, toColumnId, beforeId, afterId, toIndex }
 *
 *   beforeId – id of the card that will be immediately BEFORE the dropped card
 *              (null if dropped at the top)
 *   afterId  – id of the card that will be immediately AFTER the dropped card
 *              (null if dropped at the bottom)
 *   toIndex  – 0-based index in the target column's rendered card list
 */

let dragState = null; // Active drag context.
let ghostEl = null;   // Floating ghost element.
let placeholder = null; // Blue line drop indicator.

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attach drag-and-drop listeners to the board element.
 * @param {HTMLElement} boardEl
 * @param {(info: object) => void} onDrop
 */
export function initDragDrop(boardEl, onDrop) {
  boardEl.addEventListener('mousedown', onMouseDown);

  function onMouseDown(e) {
    const cardEl = e.target.closest('.card');
    if (!cardEl) return;
    // Ignore clicks on interactive children (textarea, button, etc.)
    if (e.target.closest('textarea, button, input')) return;

    e.preventDefault();

    const cardId = cardEl.dataset.cardId;
    const rect = cardEl.getBoundingClientRect();

    dragState = {
      cardId,
      cardEl,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      currentColumnId: null,
      currentIndex: -1,
    };

    // Create ghost.
    ghostEl = document.createElement('div');
    ghostEl.className = 'card-ghost';
    ghostEl.textContent = cardEl.querySelector('.card-text')?.textContent
      ?? cardEl.textContent;
    ghostEl.style.width = `${rect.width}px`;
    positionGhost(e.clientX, e.clientY);
    document.body.appendChild(ghostEl);

    // Dim the source card.
    cardEl.classList.add('dragging');

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function onMouseMove(e) {
    if (!dragState) return;
    positionGhost(e.clientX, e.clientY);
    updateDropTarget(e.clientX, e.clientY);
  }

  function onMouseUp(e) {
    if (!dragState) return;

    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);

    // Clean up visual state.
    dragState.cardEl.classList.remove('dragging');
    ghostEl?.remove();
    ghostEl = null;
    placeholder?.remove();
    placeholder = null;

    // Remove drag-over highlights.
    boardEl.querySelectorAll('.card-list.drag-over').forEach((el) =>
      el.classList.remove('drag-over')
    );

    if (
      dragState.currentColumnId !== null &&
      dragState.currentIndex !== -1
    ) {
      const { cardId, currentColumnId, currentIndex } = dragState;
      const { beforeId, afterId } = getNeighbours(currentColumnId, currentIndex, cardId);

      onDrop({
        cardId,
        toColumnId: currentColumnId,
        beforeId,
        afterId,
        toIndex: currentIndex,
      });
    }

    dragState = null;
  }
}

// ---------------------------------------------------------------------------
// Ghost positioning
// ---------------------------------------------------------------------------

function positionGhost(x, y) {
  if (!ghostEl || !dragState) return;
  ghostEl.style.left = `${x - dragState.offsetX}px`;
  ghostEl.style.top  = `${y - dragState.offsetY}px`;
}

// ---------------------------------------------------------------------------
// Drop target detection
// ---------------------------------------------------------------------------

/**
 * Determine which column and index the cursor is hovering over and update
 * the placeholder indicator.
 */
function updateDropTarget(x, y) {
  if (!dragState) return;

  // Find the column list under the cursor.
  const listEl = getCardListAt(x, y);
  if (!listEl) {
    // Not over any column – clear state.
    clearDropHighlight();
    dragState.currentColumnId = null;
    dragState.currentIndex = -1;
    return;
  }

  const columnEl = listEl.closest('.column');
  const columnId = columnEl?.dataset.columnId;
  if (!columnId) return;

  // Highlight the column.
  document.querySelectorAll('.card-list.drag-over').forEach((el) => {
    if (el !== listEl) el.classList.remove('drag-over');
  });
  listEl.classList.add('drag-over');

  // Determine insertion index.
  const index = getInsertionIndex(listEl, y, dragState.cardId);

  dragState.currentColumnId = columnId;
  dragState.currentIndex = index;

  // Move placeholder.
  renderPlaceholder(listEl, index);
}

/**
 * Find the .card-list element at the given viewport coordinates.
 * We walk up from the element at the point, skipping the ghost and the
 * dragging card itself.
 */
function getCardListAt(x, y) {
  // Temporarily hide ghost so elementFromPoint works.
  if (ghostEl) ghostEl.style.display = 'none';
  const el = document.elementFromPoint(x, y);
  if (ghostEl) ghostEl.style.display = '';

  if (!el) return null;

  // Walk up to find a .card-list or .column.
  const list = el.closest('.card-list');
  if (list) return list;

  // If hovering over the column header or add-card area, use that column's list.
  const col = el.closest('.column');
  if (col) return col.querySelector('.card-list');

  return null;
}

/**
 * Compute the insertion index within a card list for a given Y coordinate.
 * Cards that belong to the dragging card are excluded from the count.
 */
function getInsertionIndex(listEl, y, draggingCardId) {
  const cards = Array.from(listEl.querySelectorAll('.card:not(.dragging)'));

  for (let i = 0; i < cards.length; i++) {
    const rect = cards[i].getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (y < midY) return i;
  }
  return cards.length;
}

/**
 * Render the blue placeholder line at the given index within a list.
 */
function renderPlaceholder(listEl, index) {
  if (!placeholder) {
    placeholder = document.createElement('div');
    placeholder.className = 'drop-placeholder';
  }

  const cards = Array.from(listEl.querySelectorAll('.card:not(.dragging)'));

  if (index >= cards.length) {
    listEl.appendChild(placeholder);
  } else {
    listEl.insertBefore(placeholder, cards[index]);
  }
}

function clearDropHighlight() {
  document.querySelectorAll('.card-list.drag-over').forEach((el) =>
    el.classList.remove('drag-over')
  );
  placeholder?.remove();
}

// ---------------------------------------------------------------------------
// Neighbour resolution
// ---------------------------------------------------------------------------

/**
 * Given a target column and insertion index, return the ids of the cards
 * that will be immediately before and after the dropped card.
 *
 * The dragging card itself is excluded from the neighbour list.
 *
 * @param {string} columnId
 * @param {number} index
 * @param {string} draggingCardId
 * @returns {{ beforeId: string|null, afterId: string|null }}
 */
function getNeighbours(columnId, index, draggingCardId) {
  const colEl = document.querySelector(`.column[data-column-id="${columnId}"]`);
  if (!colEl) return { beforeId: null, afterId: null };

  // All rendered cards in the column, excluding the dragging card.
  const cards = Array.from(
    colEl.querySelectorAll('.card-list .card')
  ).filter((el) => el.dataset.cardId !== draggingCardId);

  const beforeEl = index > 0 ? cards[index - 1] : null;
  const afterEl  = index < cards.length ? cards[index] : null;

  return {
    beforeId: beforeEl?.dataset.cardId ?? null,
    afterId:  afterEl?.dataset.cardId  ?? null,
  };
}
