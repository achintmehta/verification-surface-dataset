/**
 * Drag-and-drop logic for the Kanban board.
 *
 * Uses the native HTML5 Drag-and-Drop API.
 *
 * Terminology:
 *   afterId  – the card immediately BEFORE the drop position (the card
 *              the dragged card will be placed after).
 *   beforeId – the card immediately AFTER the drop position (the card
 *              the dragged card will be placed before).
 *
 * Both may be null when dropping at the very start or very end of a
 * column.
 */

import { optimisticMove, rollback } from './store.js';
import { moveCard as apiMoveCard } from './api.js';
import { renderBoard } from './render.js';

// The card element currently being dragged.
let draggedCardId = null;
let draggedCardEl = null;

// Placeholder element shown at the prospective drop position.
let placeholder = null;

/**
 * Attach drag-and-drop event listeners to a card element.
 * Called once per card when it is first rendered.
 */
export function makeDraggable(cardEl, cardId) {
  cardEl.setAttribute('draggable', 'true');

  cardEl.addEventListener('dragstart', (e) => {
    draggedCardId = cardId;
    draggedCardEl = cardEl;

    // Use a transparent 1×1 image as the drag image so the card stays
    // visible in place (we dim it with the .dragging class instead).
    const ghost = document.createElement('div');
    ghost.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;';
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 0, 0);
    setTimeout(() => document.body.removeChild(ghost), 0);

    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', cardId);

    requestAnimationFrame(() => cardEl.classList.add('dragging'));

    placeholder = document.createElement('div');
    placeholder.className = 'card-placeholder';
    placeholder.style.height = `${cardEl.offsetHeight}px`;
  });

  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('dragging');
    placeholder?.remove();
    placeholder = null;
    draggedCardId = null;
    draggedCardEl = null;

    // Remove all drag-over highlights.
    document
      .querySelectorAll('.card-list.drag-over')
      .forEach((el) => el.classList.remove('drag-over'));
  });
}

/**
 * Attach dragover / drop listeners to a card-list element (the
 * scrollable list inside each column).
 *
 * @param {HTMLElement} listEl   – the .card-list element
 * @param {string}      columnId – the column this list belongs to
 */
export function makeDropTarget(listEl, columnId) {
  listEl.addEventListener('dragover', (e) => {
    if (!draggedCardId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    listEl.classList.add('drag-over');

    // Determine where in the list the placeholder should go.
    const { afterEl } = getDropPosition(listEl, e.clientY);

    if (afterEl) {
      afterEl.after(placeholder);
    } else {
      listEl.prepend(placeholder);
    }
  });

  listEl.addEventListener('dragleave', (e) => {
    // Only remove the highlight when leaving the list itself, not a child.
    if (!listEl.contains(e.relatedTarget)) {
      listEl.classList.remove('drag-over');
    }
  });

  listEl.addEventListener('drop', (e) => {
    e.preventDefault();
    listEl.classList.remove('drag-over');

    if (!draggedCardId || !placeholder) return;

    const cardId = draggedCardId;

    // Determine neighbours from the placeholder's current position.
    const { afterId, beforeId } = getNeighbourIds(listEl, placeholder);

    // Don't do anything if the card is dropped in its own position.
    if (
      afterId === cardId ||
      beforeId === cardId ||
      (afterId === null && beforeId === null && isOnlyCardInColumn(cardId, columnId))
    ) {
      return;
    }

    // Optimistic update.
    const snapshot = optimisticMove(cardId, columnId, afterId, beforeId);
    renderBoard();

    // Send to server.
    apiMoveCard(cardId, columnId, beforeId, afterId)
      .then(({ card }) => {
        // The SSE broadcast will reconcile the canonical state.
        // If the server position differs from our optimistic guess the
        // SSE handler will call renderBoard() again with the correct order.
        void card; // suppress lint warning
      })
      .catch((err) => {
        console.error('[dragdrop] Move failed, rolling back:', err);
        rollback(snapshot);
        renderBoard();
      });
  });
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Given a Y coordinate, find the card element in `listEl` that the
 * pointer is currently below (i.e. the card that should come before
 * the placeholder).
 *
 * Returns `{ afterEl }` where `afterEl` is the DOM element after which
 * the placeholder should be inserted, or null if it should be prepended.
 */
function getDropPosition(listEl, clientY) {
  const cards = [
    ...listEl.querySelectorAll('.card:not(.dragging)'),
  ];

  let afterEl = null;

  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (clientY > midY) {
      afterEl = card;
    }
  }

  return { afterEl };
}

/**
 * Inspect the DOM around the placeholder to determine the IDs of the
 * neighbouring cards.
 */
function getNeighbourIds(listEl, ph) {
  const cards = [...listEl.querySelectorAll('.card:not(.dragging)')];
  const phIndex = getElementIndex(ph, listEl);

  // afterId: the card whose DOM index is just before the placeholder.
  // beforeId: the card whose DOM index is just after the placeholder.
  let afterId = null;
  let beforeId = null;

  for (const card of cards) {
    const idx = getElementIndex(card, listEl);
    if (idx < phIndex) {
      afterId = card.dataset.cardId;
    } else if (idx > phIndex && beforeId === null) {
      beforeId = card.dataset.cardId;
    }
  }

  return { afterId, beforeId };
}

/**
 * Return the index of `el` among its parent's children.
 */
function getElementIndex(el, parent) {
  return [...parent.children].indexOf(el);
}

/**
 * Check whether a card is the only card in a column (so a drop on
 * itself is a no-op).
 */
function isOnlyCardInColumn(cardId, columnId) {
  const listEl = document.querySelector(
    `.column[data-column-id="${columnId}"] .card-list`
  );
  if (!listEl) return false;
  const cards = listEl.querySelectorAll('.card');
  return cards.length === 1 && cards[0].dataset.cardId === cardId;
}
