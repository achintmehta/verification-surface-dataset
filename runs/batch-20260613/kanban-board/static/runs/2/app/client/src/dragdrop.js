/**
 * Drag-and-drop module.
 *
 * Uses the HTML5 Drag and Drop API.
 * Emits a custom 'card:drop' event on the board element when a card is dropped,
 * carrying { cardId, targetColumnId, afterId, beforeId }.
 *
 * A placeholder element is inserted during the drag to show where the card
 * will land.
 */

const boardEl = /** @type {HTMLElement} */ (document.getElementById('board'));

/** @type {HTMLElement|null} */
let draggingEl = null;

/** @type {HTMLElement|null} */
let placeholder = null;

/** @type {string|null} */
let draggingCardId = null;

/* ------------------------------------------------------------------ */
/* Initialise – attach delegated listeners to the board                */
/* ------------------------------------------------------------------ */

export function initDragDrop() {
  boardEl.addEventListener('dragstart', onDragStart);
  boardEl.addEventListener('dragend', onDragEnd);
  boardEl.addEventListener('dragover', onDragOver);
  boardEl.addEventListener('dragenter', onDragEnter);
  boardEl.addEventListener('dragleave', onDragLeave);
  boardEl.addEventListener('drop', onDrop);
}

/* ------------------------------------------------------------------ */
/* Event handlers                                                       */
/* ------------------------------------------------------------------ */

function onDragStart(e) {
  const cardEl = e.target.closest('.card');
  if (!cardEl) return;

  draggingEl = cardEl;
  draggingCardId = cardEl.dataset.cardId;

  // Use a transparent drag image so we control the visual entirely
  const ghost = cardEl.cloneNode(true);
  ghost.style.position = 'absolute';
  ghost.style.top = '-9999px';
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 0, 0);
  requestAnimationFrame(() => document.body.removeChild(ghost));

  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', draggingCardId);

  // Defer adding the class so the drag image captures the normal style
  requestAnimationFrame(() => {
    if (draggingEl) draggingEl.classList.add('dragging');
  });

  // Create placeholder with same height as the card
  placeholder = document.createElement('div');
  placeholder.className = 'card-placeholder';
  placeholder.style.height = `${cardEl.offsetHeight}px`;
}

function onDragEnd(e) {
  if (draggingEl) {
    draggingEl.classList.remove('dragging');
    draggingEl = null;
  }
  if (placeholder && placeholder.parentNode) {
    placeholder.parentNode.removeChild(placeholder);
  }
  placeholder = null;
  draggingCardId = null;

  // Remove all drag-over highlights
  boardEl.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
}

function onDragEnter(e) {
  const list = e.target.closest('.card-list');
  if (list) {
    list.classList.add('drag-over');
    e.preventDefault();
  }
}

function onDragLeave(e) {
  const list = e.target.closest('.card-list');
  if (list && !list.contains(e.relatedTarget)) {
    list.classList.remove('drag-over');
  }
}

function onDragOver(e) {
  if (!draggingEl) return;

  const list = e.target.closest('.card-list');
  if (!list) return;

  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  // Find the card element directly under the cursor
  const afterEl = getDragAfterElement(list, e.clientY);

  if (afterEl == null) {
    // Append placeholder at end
    list.appendChild(placeholder);
  } else {
    list.insertBefore(placeholder, afterEl);
  }
}

function onDrop(e) {
  e.preventDefault();

  const list = e.target.closest('.card-list');
  if (!list || !draggingEl || !placeholder) return;

  list.classList.remove('drag-over');

  const targetColumnId = list.dataset.columnId;
  if (!targetColumnId || !draggingCardId) return;

  // Determine neighbours from placeholder position
  const { afterId, beforeId } = getNeighbours(list, placeholder, draggingCardId);

  // Dispatch custom event for main.js to handle
  boardEl.dispatchEvent(
    new CustomEvent('card:drop', {
      detail: { cardId: draggingCardId, targetColumnId, afterId, beforeId },
      bubbles: false,
    })
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

/**
 * Returns the card element that the dragged card should be inserted before,
 * based on the cursor's Y position within the list.
 * Returns null if the card should be appended at the end.
 *
 * @param {HTMLElement} list
 * @param {number} y - clientY
 * @returns {HTMLElement|null}
 */
function getDragAfterElement(list, y) {
  const draggableEls = [
    ...list.querySelectorAll('.card:not(.dragging)'),
  ];

  let closest = null;
  let closestOffset = Number.NEGATIVE_INFINITY;

  for (const el of draggableEls) {
    const rect = el.getBoundingClientRect();
    const offset = y - rect.top - rect.height / 2;
    if (offset < 0 && offset > closestOffset) {
      closestOffset = offset;
      closest = el;
    }
  }

  return closest;
}

/**
 * Given the placeholder's current position in the list, determine the
 * card ids immediately before (afterId) and after (beforeId) the placeholder.
 *
 * @param {HTMLElement} list
 * @param {HTMLElement} ph - placeholder element
 * @param {string} draggingId
 * @returns {{ afterId: string|null, beforeId: string|null }}
 */
function getNeighbours(list, ph, draggingId) {
  const phIndex = [...list.children].indexOf(ph);

  // Cards before the placeholder (excluding dragging card)
  const before = [...list.children]
    .slice(0, phIndex)
    .filter((el) => el.classList.contains('card') && el.dataset.cardId !== draggingId);

  // Cards after the placeholder (excluding dragging card)
  const after = [...list.children]
    .slice(phIndex + 1)
    .filter((el) => el.classList.contains('card') && el.dataset.cardId !== draggingId);

  const afterId = before.length > 0 ? before[before.length - 1].dataset.cardId : null;
  const beforeId = after.length > 0 ? after[0].dataset.cardId : null;

  return { afterId: afterId ?? null, beforeId: beforeId ?? null };
}

/** Returns the id of the card currently being dragged (or null). */
export function getDraggingCardId() {
  return draggingCardId;
}
