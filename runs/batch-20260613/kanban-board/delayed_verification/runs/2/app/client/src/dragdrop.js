/**
 * Drag-and-drop controller for the Kanban board.
 *
 * Uses the HTML5 Drag-and-Drop API.
 *
 * Lifecycle:
 *  1. dragstart  – record which card is being dragged; create a ghost element.
 *  2. dragover   – highlight the target column; show a drop-indicator line.
 *  3. drop       – compute afterId / beforeId from the indicator position,
 *                  call onDrop(cardId, columnId, afterId, beforeId).
 *  4. dragend    – clean up ghost and highlights.
 */

const boardEl = document.getElementById('board');

/** @type {{ cardId: string, columnId: string, ghostEl: HTMLElement | null } | null} */
let drag = null;

/** The drop-indicator <div> we move around during dragover */
let indicator = null;

/**
 * Initialise drag-and-drop on the board element.
 *
 * @param {{ onDrop: (cardId: string, columnId: string, afterId: string|null, beforeId: string|null) => void }} opts
 */
export function initDragDrop({ onDrop }) {
  boardEl.addEventListener('dragstart', handleDragStart);
  boardEl.addEventListener('dragover',  handleDragOver);
  boardEl.addEventListener('dragleave', handleDragLeave);
  boardEl.addEventListener('drop',      (e) => handleDrop(e, onDrop));
  boardEl.addEventListener('dragend',   handleDragEnd);
}

/* ── dragstart ───────────────────────────────────────────────────────────── */

function handleDragStart(e) {
  const cardEl = e.target.closest('.card');
  if (!cardEl) return;

  drag = {
    cardId:   cardEl.dataset.cardId,
    columnId: cardEl.dataset.columnId,
    ghostEl:  null,
  };

  // Style the source card as "dragging"
  // Use rAF so the browser captures the un-dimmed card as the drag image first
  requestAnimationFrame(() => cardEl.classList.add('dragging'));

  // Create a ghost element that follows the cursor
  const ghost = cardEl.cloneNode(true);
  ghost.className = 'card-ghost';
  ghost.style.width = `${cardEl.offsetWidth}px`;
  ghost.style.top  = '-9999px';
  ghost.style.left = '-9999px';
  document.body.appendChild(ghost);
  drag.ghostEl = ghost;

  // Use a transparent 1×1 pixel as the native drag image
  const blank = document.createElement('canvas');
  blank.width = blank.height = 1;
  e.dataTransfer.setDragImage(blank, 0, 0);
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', drag.cardId);

  document.addEventListener('dragover', moveGhost);
}

function moveGhost(e) {
  if (!drag?.ghostEl) return;
  drag.ghostEl.style.top  = `${e.clientY + 10}px`;
  drag.ghostEl.style.left = `${e.clientX + 10}px`;
}

/* ── dragover ────────────────────────────────────────────────────────────── */

function handleDragOver(e) {
  const listEl = e.target.closest('.card-list');
  if (!listEl) return;

  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  // Highlight the column
  clearHighlights();
  listEl.classList.add('drag-over');

  // Position the drop indicator
  positionIndicator(e, listEl);
}

function handleDragLeave(e) {
  const listEl = e.target.closest('.card-list');
  if (!listEl) return;

  // Only clear if we're truly leaving the list (not entering a child)
  if (!listEl.contains(e.relatedTarget)) {
    listEl.classList.remove('drag-over');
    removeIndicator();
  }
}

/* ── drop ────────────────────────────────────────────────────────────────── */

function handleDrop(e, onDrop) {
  e.preventDefault();

  const listEl = e.target.closest('.card-list');
  if (!listEl || !drag) return;

  const targetColumnId = listEl.dataset.columnId;
  const { afterId, beforeId } = getNeighboursFromIndicator(listEl);

  cleanup();
  onDrop(drag.cardId, targetColumnId, afterId, beforeId);
  drag = null;
}

/* ── dragend ─────────────────────────────────────────────────────────────── */

function handleDragEnd() {
  cleanup();
  drag = null;
}

/* ── Indicator helpers ───────────────────────────────────────────────────── */

/**
 * Insert or move the drop-indicator line inside `listEl` based on cursor Y.
 */
function positionIndicator(e, listEl) {
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.className = 'drop-indicator';
  }

  const cards = [...listEl.querySelectorAll('.card:not(.dragging)')];

  if (cards.length === 0) {
    listEl.appendChild(indicator);
    return;
  }

  let insertBefore = null; // null = append at end

  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY < midY) {
      insertBefore = card;
      break;
    }
  }

  if (insertBefore) {
    listEl.insertBefore(indicator, insertBefore);
  } else {
    listEl.appendChild(indicator);
  }
}

/**
 * Read the current indicator position to determine afterId / beforeId.
 *
 * @param {HTMLElement} listEl
 * @returns {{ afterId: string|null, beforeId: string|null }}
 */
function getNeighboursFromIndicator(listEl) {
  if (!indicator || !listEl.contains(indicator)) {
    return { afterId: null, beforeId: null };
  }

  // Walk siblings to find the card immediately before and after the indicator
  let afterEl  = null;
  let beforeEl = null;

  let node = indicator.previousElementSibling;
  while (node) {
    if (node.classList.contains('card') && !node.classList.contains('dragging')) {
      afterEl = node;
      break;
    }
    node = node.previousElementSibling;
  }

  node = indicator.nextElementSibling;
  while (node) {
    if (node.classList.contains('card') && !node.classList.contains('dragging')) {
      beforeEl = node;
      break;
    }
    node = node.nextElementSibling;
  }

  return {
    afterId:  afterEl  ? afterEl.dataset.cardId  : null,
    beforeId: beforeEl ? beforeEl.dataset.cardId : null,
  };
}

/* ── Cleanup helpers ─────────────────────────────────────────────────────── */

function clearHighlights() {
  for (const el of boardEl.querySelectorAll('.card-list.drag-over')) {
    el.classList.remove('drag-over');
  }
}

function removeIndicator() {
  if (indicator && indicator.parentNode) {
    indicator.parentNode.removeChild(indicator);
  }
}

function cleanup() {
  clearHighlights();
  removeIndicator();
  indicator = null;

  document.removeEventListener('dragover', moveGhost);

  if (drag?.ghostEl) {
    drag.ghostEl.remove();
    drag.ghostEl = null;
  }

  // Remove dragging class from all cards
  for (const el of boardEl.querySelectorAll('.card.dragging')) {
    el.classList.remove('dragging');
  }
}
