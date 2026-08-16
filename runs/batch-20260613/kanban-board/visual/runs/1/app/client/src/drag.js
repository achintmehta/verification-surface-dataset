/**
 * Drag-and-drop manager.
 *
 * Uses the HTML5 Drag-and-Drop API.
 * Emits a `card-drop` custom event on the board element when a card is dropped.
 *
 * Event detail: { cardId, targetColumnId, afterId, beforeId }
 *   afterId  = id of the card immediately above the drop slot (null = top)
 *   beforeId = id of the card immediately below the drop slot (null = bottom)
 */

let dragCardId = null;
let dragSourceColumnId = null;

// The element used as a visual drop indicator line
let indicator = null;

function getIndicator() {
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.className = 'drop-indicator';
    indicator.dataset.indicator = 'true';
  }
  return indicator;
}

function removeIndicator() {
  indicator?.remove();
}

/** Find the card element and list from a drag event target */
function getDropTarget(e) {
  const list = e.target.closest('.card-list');
  if (!list) return null;
  const overCard = e.target.closest('.card[data-card-id]');
  return { list, overCard };
}

/**
 * Determine afterId / beforeId from the indicator's current position in the list.
 */
function resolveNeighbours(list) {
  const children = [...list.children].filter(
    (el) => el.dataset.cardId && el.dataset.cardId !== dragCardId
  );
  const ind = list.querySelector('[data-indicator]');
  if (!ind) return { afterId: null, beforeId: null };

  const indIndex = [...list.children].indexOf(ind);
  let afterId = null;
  let beforeId = null;

  // Walk backwards to find the card above
  for (let i = indIndex - 1; i >= 0; i--) {
    const el = list.children[i];
    if (el.dataset.cardId && el.dataset.cardId !== dragCardId) {
      afterId = el.dataset.cardId;
      break;
    }
  }
  // Walk forwards to find the card below
  for (let i = indIndex + 1; i < list.children.length; i++) {
    const el = list.children[i];
    if (el.dataset.cardId && el.dataset.cardId !== dragCardId) {
      beforeId = el.dataset.cardId;
      break;
    }
  }

  return { afterId, beforeId };
}

export function initDragAndDrop(boardEl) {
  // ── dragstart ──────────────────────────────────────────────────────────────
  boardEl.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.card[data-card-id]');
    if (!card) return;

    dragCardId = card.dataset.cardId;
    dragSourceColumnId = card.closest('.column')?.dataset.columnId || null;

    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragCardId);

    // Defer adding the dragging class so the ghost image is captured first
    requestAnimationFrame(() => card.classList.add('dragging'));
  });

  // ── dragend ────────────────────────────────────────────────────────────────
  boardEl.addEventListener('dragend', () => {
    removeIndicator();
    document
      .querySelectorAll('.card.dragging')
      .forEach((el) => el.classList.remove('dragging'));
    document
      .querySelectorAll('.column.drag-over')
      .forEach((el) => el.classList.remove('drag-over'));
    dragCardId = null;
    dragSourceColumnId = null;
  });

  // ── dragover ───────────────────────────────────────────────────────────────
  boardEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const target = getDropTarget(e);
    if (!target) return;

    const { list, overCard } = target;
    const col = list.closest('.column');
    col?.classList.add('drag-over');

    const ind = getIndicator();

    if (!overCard) {
      // Dropped onto empty space in the list → append at bottom
      list.appendChild(ind);
      return;
    }

    // Determine whether to place indicator above or below the hovered card
    const rect = overCard.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;

    if (e.clientY < midY) {
      list.insertBefore(ind, overCard);
    } else {
      overCard.after(ind);
    }
  });

  // ── dragleave ──────────────────────────────────────────────────────────────
  boardEl.addEventListener('dragleave', (e) => {
    const col = e.target.closest('.column');
    if (col && !col.contains(e.relatedTarget)) {
      col.classList.remove('drag-over');
    }
  });

  // ── drop ───────────────────────────────────────────────────────────────────
  boardEl.addEventListener('drop', (e) => {
    e.preventDefault();

    const list = e.target.closest('.card-list');
    if (!list || !dragCardId) return;

    const targetColumnId = list.closest('.column')?.dataset.columnId;
    if (!targetColumnId) return;

    const { afterId, beforeId } = resolveNeighbours(list);

    removeIndicator();
    document
      .querySelectorAll('.column.drag-over')
      .forEach((el) => el.classList.remove('drag-over'));

    boardEl.dispatchEvent(
      new CustomEvent('card-drop', {
        bubbles: true,
        detail: { cardId: dragCardId, targetColumnId, afterId, beforeId },
      })
    );
  });
}
