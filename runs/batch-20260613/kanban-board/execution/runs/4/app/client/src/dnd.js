/**
 * Drag-and-drop manager for the Kanban board.
 *
 * Uses the HTML5 Drag-and-Drop API.
 *
 * Emits a custom "card-drop" event on the board element with:
 *   detail: { cardId, targetColumnId, beforeId, afterId }
 *
 * beforeId = id of the card immediately ABOVE the drop slot (null if top)
 * afterId  = id of the card immediately BELOW the drop slot (null if bottom)
 */

let draggingCardId   = null;
let draggingColumnId = null;
let placeholder      = null;

/**
 * Attach DnD listeners to the board container.
 * @param {HTMLElement} boardEl
 */
export function initDnD(boardEl) {
  boardEl.addEventListener('dragstart', onDragStart);
  boardEl.addEventListener('dragend',   onDragEnd);
  boardEl.addEventListener('dragover',  onDragOver);
  boardEl.addEventListener('dragleave', onDragLeave);
  boardEl.addEventListener('drop',      onDrop);
}

/* ------------------------------------------------------------------ */
/*  Drag start / end                                                    */
/* ------------------------------------------------------------------ */
function onDragStart(e) {
  const card = e.target.closest('.card');
  if (!card) return;

  draggingCardId   = card.dataset.cardId;
  draggingColumnId = card.closest('.column')?.dataset.columnId ?? null;

  card.classList.add('dragging');

  // Required for Firefox
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', draggingCardId);
}

function onDragEnd(e) {
  const card = e.target.closest('.card');
  if (card) card.classList.remove('dragging');

  removePlaceholder();
  clearDragOver();

  draggingCardId   = null;
  draggingColumnId = null;
}

/* ------------------------------------------------------------------ */
/*  Drag over – show placeholder                                        */
/* ------------------------------------------------------------------ */
function onDragOver(e) {
  if (!draggingCardId) return;

  const list = e.target.closest('.cards-list');
  if (!list) return;

  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  // Highlight the column
  clearDragOver();
  list.classList.add('drag-over');

  // Determine insertion point
  const { before, after } = getInsertionPoint(list, e.clientY);

  // Move / create placeholder
  ensurePlaceholder();
  if (before) {
    list.insertBefore(placeholder, before);
  } else {
    list.appendChild(placeholder);
  }
}

function onDragLeave(e) {
  const list = e.target.closest('.cards-list');
  if (!list) return;

  // Only clear if we're actually leaving the list (not entering a child)
  if (!list.contains(e.relatedTarget)) {
    list.classList.remove('drag-over');
  }
}

/* ------------------------------------------------------------------ */
/*  Drop                                                                */
/* ------------------------------------------------------------------ */
function onDrop(e) {
  if (!draggingCardId) return;

  const list = e.target.closest('.cards-list');
  if (!list) return;

  e.preventDefault();

  const targetColumnId = list.closest('.column')?.dataset.columnId;
  if (!targetColumnId) return;

  // Determine neighbours from placeholder position
  const { beforeId, afterId } = getNeighboursFromPlaceholder(list);

  // Don't fire if dropped in the same position
  const isNoop =
    targetColumnId === draggingColumnId &&
    beforeId === draggingCardId;

  removePlaceholder();
  clearDragOver();

  if (isNoop) return;

  // Dispatch semantic event for the app layer to handle
  list.closest('.board')?.dispatchEvent(
    new CustomEvent('card-drop', {
      bubbles: true,
      detail: {
        cardId:         draggingCardId,
        sourceColumnId: draggingColumnId,
        targetColumnId,
        beforeId,
        afterId,
      },
    })
  );
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Given a clientY, find the card element the placeholder should be inserted
 * before (or null to append at end).
 */
function getInsertionPoint(list, clientY) {
  const cards = [...list.querySelectorAll('.card:not(.dragging)')];

  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    const mid  = rect.top + rect.height / 2;
    if (clientY < mid) {
      return { before: card, after: null };
    }
  }
  return { before: null, after: null };
}

/**
 * Read the card ids immediately before and after the placeholder.
 */
function getNeighboursFromPlaceholder(list) {
  if (!placeholder || !list.contains(placeholder)) {
    return { beforeId: null, afterId: null };
  }

  const items = [...list.children].filter(
    (el) => el.classList.contains('card') && !el.classList.contains('dragging')
  );

  // Find the index of the placeholder among all children
  const allChildren = [...list.children];
  const phIdx = allChildren.indexOf(placeholder);

  // Cards before the placeholder (not dragging)
  const cardsBefore = allChildren
    .slice(0, phIdx)
    .filter((el) => el.classList.contains('card') && !el.classList.contains('dragging'));

  // Cards after the placeholder (not dragging)
  const cardsAfter = allChildren
    .slice(phIdx + 1)
    .filter((el) => el.classList.contains('card') && !el.classList.contains('dragging'));

  const beforeId = cardsBefore.length
    ? cardsBefore[cardsBefore.length - 1].dataset.cardId
    : null;

  const afterId = cardsAfter.length
    ? cardsAfter[0].dataset.cardId
    : null;

  return { beforeId, afterId };
}

function ensurePlaceholder() {
  if (!placeholder) {
    placeholder = document.createElement('div');
    placeholder.className = 'drop-placeholder';
  }
}

function removePlaceholder() {
  placeholder?.remove();
}

function clearDragOver() {
  document.querySelectorAll('.cards-list.drag-over').forEach((el) =>
    el.classList.remove('drag-over')
  );
}
