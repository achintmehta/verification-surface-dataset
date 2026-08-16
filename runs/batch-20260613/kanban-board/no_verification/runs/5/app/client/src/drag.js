/**
 * Drag-and-drop module.
 *
 * Uses the HTML5 Drag and Drop API.
 * Emits a custom "card-drop" event on the board element when a drop completes.
 *
 * Event detail: { cardId, targetColumnId, afterId, beforeId }
 *   afterId  – id of the card immediately ABOVE the drop position (or null)
 *   beforeId – id of the card immediately BELOW the drop position (or null)
 */

let dragCardId = null;
let dragSourceColumnId = null;

/** The ghost element used as the drag image */
let ghostEl = null;

/**
 * Attach drag-and-drop listeners to the board container.
 * @param {HTMLElement} boardEl
 */
export function initDragAndDrop(boardEl) {
  boardEl.addEventListener('dragstart', onDragStart);
  boardEl.addEventListener('dragend', onDragEnd);
  boardEl.addEventListener('dragover', onDragOver);
  boardEl.addEventListener('dragenter', onDragEnter);
  boardEl.addEventListener('dragleave', onDragLeave);
  boardEl.addEventListener('drop', onDrop);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getCardEl(el) {
  return el.closest('[data-card-id]');
}

function getColumnEl(el) {
  return el.closest('[data-column-id]');
}

function getCardListEl(el) {
  return el.closest('.card-list') ?? el.querySelector('.card-list');
}

/**
 * Given a card-list element and a clientY coordinate, return the card element
 * that the dragged card should be inserted BEFORE (or null if at the end).
 */
function getDropTarget(cardListEl, clientY) {
  const cards = [...cardListEl.querySelectorAll('[data-card-id]:not(.dragging)')];
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (clientY < midY) return card;
  }
  return null; // drop at end
}

function showDropIndicator(cardListEl, beforeCardEl) {
  // Remove all existing indicators
  cardListEl.querySelectorAll('.drop-indicator').forEach((el) => el.remove());

  const indicator = document.createElement('div');
  indicator.className = 'drop-indicator visible';

  if (beforeCardEl) {
    cardListEl.insertBefore(indicator, beforeCardEl);
  } else {
    cardListEl.appendChild(indicator);
  }
}

function clearDropIndicators(boardEl) {
  boardEl.querySelectorAll('.drop-indicator').forEach((el) => el.remove());
}

// ── Event handlers ────────────────────────────────────────────────────────────

function onDragStart(e) {
  const cardEl = getCardEl(e.target);
  if (!cardEl) return;

  dragCardId = cardEl.dataset.cardId;
  const colEl = getColumnEl(cardEl);
  dragSourceColumnId = colEl?.dataset.columnId ?? null;

  // Custom drag image
  ghostEl = document.createElement('div');
  ghostEl.className = 'drag-ghost';
  ghostEl.textContent = cardEl.querySelector('.card-text')?.textContent ?? '';
  document.body.appendChild(ghostEl);
  e.dataTransfer.setDragImage(ghostEl, 20, 20);

  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragCardId);

  // Mark the original card as dragging (slight delay so the ghost renders first)
  requestAnimationFrame(() => cardEl.classList.add('dragging'));
}

function onDragEnd(e) {
  const cardEl = getCardEl(e.target);
  if (cardEl) cardEl.classList.remove('dragging');

  if (ghostEl) {
    ghostEl.remove();
    ghostEl = null;
  }

  clearDropIndicators(document.getElementById('board'));

  // Remove drag-over highlights
  document.querySelectorAll('.column.drag-over').forEach((el) =>
    el.classList.remove('drag-over')
  );

  dragCardId = null;
  dragSourceColumnId = null;
}

function onDragEnter(e) {
  const colEl = getColumnEl(e.target);
  if (colEl) colEl.classList.add('drag-over');
  e.preventDefault();
}

function onDragLeave(e) {
  const colEl = getColumnEl(e.target);
  if (!colEl) return;
  // Only remove if we're leaving the column entirely
  if (!colEl.contains(e.relatedTarget)) {
    colEl.classList.remove('drag-over');
  }
}

function onDragOver(e) {
  if (!dragCardId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  const colEl = getColumnEl(e.target);
  if (!colEl) return;

  const cardListEl = colEl.querySelector('.card-list');
  if (!cardListEl) return;

  const beforeCardEl = getDropTarget(cardListEl, e.clientY);
  showDropIndicator(cardListEl, beforeCardEl);
}

function onDrop(e) {
  e.preventDefault();
  if (!dragCardId) return;

  const colEl = getColumnEl(e.target);
  if (!colEl) return;

  const targetColumnId = colEl.dataset.columnId;
  const cardListEl = colEl.querySelector('.card-list');
  if (!cardListEl) return;

  const beforeCardEl = getDropTarget(cardListEl, e.clientY);
  const beforeId = beforeCardEl?.dataset.cardId ?? null;

  // Find afterId: the card immediately before the drop position
  const cards = [...cardListEl.querySelectorAll('[data-card-id]:not(.dragging)')];
  let afterId = null;
  if (beforeCardEl) {
    const idx = cards.indexOf(beforeCardEl);
    if (idx > 0) afterId = cards[idx - 1].dataset.cardId;
  } else {
    // Dropping at the end
    if (cards.length > 0) afterId = cards[cards.length - 1].dataset.cardId;
  }

  // Don't fire if nothing changed
  const cardEl = document.querySelector(`[data-card-id="${dragCardId}"]`);
  const sourceColId = dragSourceColumnId;

  clearDropIndicators(document.getElementById('board'));
  document.querySelectorAll('.column.drag-over').forEach((el) =>
    el.classList.remove('drag-over')
  );

  // Emit custom event
  const boardEl = document.getElementById('board');
  boardEl.dispatchEvent(
    new CustomEvent('card-drop', {
      detail: { cardId: dragCardId, targetColumnId, afterId, beforeId, sourceColId },
    })
  );
}
