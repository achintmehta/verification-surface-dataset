/**
 * Drag-and-drop module for the Kanban board.
 *
 * Uses the HTML5 Drag-and-Drop API.
 *
 * Lifecycle:
 *   1. User grabs a card  → dragstart
 *   2. Card is dragged over a column / other cards → dragover (shows drop indicator)
 *   3. User releases → drop → optimistic update + server PATCH
 *   4. SSE event arrives → reconcile to canonical state
 *
 * The module exposes:
 *   - makeDraggable(cardEl, cardId, columnId)  – attach drag listeners to a card element
 *   - makeDropTarget(listEl, columnId)         – attach drop listeners to a card-list element
 *
 * To avoid circular imports (board ↔ dragdrop), the renderColumn callback
 * is injected via setRenderCallback() called from main.js after both modules load.
 */

import { moveCard } from './api.js';
import { optimisticMove, rollbackMove, getColumn } from './store.js';

/** Injected render callback: (columnId: string) => void */
let renderColumnFn = null;

/**
 * Inject the render callback. Called once from main.js after all modules load.
 * @param {(columnId: string) => void} fn
 */
export function setRenderCallback(fn) {
  renderColumnFn = fn;
}

/** The card element currently being dragged */
let draggedEl = null;
/** The card id being dragged */
let draggedId = null;
/** The source column id */
let sourceColumnId = null;

/* ── Helpers ──────────────────────────────────────────────────────── */

/**
 * Given a Y coordinate and a card-list element, find the card element
 * immediately BELOW the cursor (the card the dropped card will go before),
 * or null if the cursor is below all cards.
 *
 * @param {HTMLElement} listEl
 * @param {number} clientY
 * @returns {HTMLElement|null}
 */
function getDragAfterElement(listEl, clientY) {
  const draggableCards = [
    ...listEl.querySelectorAll('.card:not(.dragging)'),
  ];

  let closest = null;
  let closestOffset = Infinity;

  for (const card of draggableCards) {
    const rect = card.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const offset = clientY - midY;

    // We want the first card whose midpoint is above the cursor
    if (offset < 0 && Math.abs(offset) < closestOffset) {
      closestOffset = Math.abs(offset);
      closest = card;
    }
  }

  return closest; // null means "append at end"
}

/**
 * Compute optimistic position for a card dropped between two neighbours.
 *
 * @param {string|null} afterId   - card immediately above the drop slot (null = top)
 * @param {string|null} beforeId  - card immediately below the drop slot (null = bottom)
 * @param {string}      columnId
 * @returns {number}
 */
function computeOptimisticPosition(afterId, beforeId, columnId) {
  const col = getColumn(columnId);
  if (!col) return 1000;

  // Exclude the card being dragged from neighbour lookup
  const cards = col.cards.filter((c) => c.id !== draggedId);

  const afterCard  = afterId  ? cards.find((c) => c.id === afterId)  : null;
  const beforeCard = beforeId ? cards.find((c) => c.id === beforeId) : null;

  const afterPos  = afterCard  ? afterCard.position  : null;
  const beforePos = beforeCard ? beforeCard.position : null;

  if (afterPos === null && beforePos === null) return 1000;
  if (afterPos === null) return beforePos / 2;
  if (beforePos === null) return afterPos + 1000;
  return (afterPos + beforePos) / 2;
}

/* ── Drag source ──────────────────────────────────────────────────── */

/**
 * Attach drag-source listeners to a card element.
 * @param {HTMLElement} cardEl
 * @param {string} cardId
 * @param {string} columnId
 */
export function makeDraggable(cardEl, cardId, columnId) {
  cardEl.setAttribute('draggable', 'true');

  cardEl.addEventListener('dragstart', (e) => {
    draggedEl = cardEl;
    draggedId = cardId;
    sourceColumnId = columnId;

    // Use rAF so the browser renders the drag image before we add the class
    requestAnimationFrame(() => cardEl.classList.add('dragging'));

    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', cardId);
  });

  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('dragging');
    draggedEl = null;
    draggedId = null;
    sourceColumnId = null;

    // Clean up any lingering indicators
    document
      .querySelectorAll('.drop-indicator.visible')
      .forEach((el) => el.classList.remove('visible'));
  });
}

/* ── Drop target ──────────────────────────────────────────────────── */

/**
 * Attach drop-target listeners to a card-list element.
 * @param {HTMLElement} listEl
 * @param {string} columnId
 */
export function makeDropTarget(listEl, columnId) {
  listEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    // Hide all indicators first
    document
      .querySelectorAll('.drop-indicator.visible')
      .forEach((el) => el.classList.remove('visible'));

    // Show the indicator at the right position
    const afterEl = getDragAfterElement(listEl, e.clientY);
    const indicator = afterEl
      ? afterEl.previousElementSibling // indicator sits just before afterEl
      : listEl.lastElementChild;       // trailing indicator at the end

    if (indicator && indicator.classList.contains('drop-indicator')) {
      indicator.classList.add('visible');
    }
  });

  listEl.addEventListener('dragleave', (e) => {
    // Only hide if leaving the list entirely (not entering a child element)
    if (!listEl.contains(e.relatedTarget)) {
      listEl
        .querySelectorAll('.drop-indicator.visible')
        .forEach((el) => el.classList.remove('visible'));
    }
  });

  listEl.addEventListener('drop', async (e) => {
    e.preventDefault();

    // Hide indicators
    document
      .querySelectorAll('.drop-indicator.visible')
      .forEach((el) => el.classList.remove('visible'));

    if (!draggedId) return;

    const cardId         = draggedId;
    const prevColumnId   = sourceColumnId;
    const targetColumnId = columnId;

    // Determine neighbours in the target column at drop time
    const afterEl = getDragAfterElement(listEl, e.clientY);

    // afterEl  → the card that will be BELOW the dropped card (beforeId)
    // the card ABOVE the dropped card is afterEl's previous card sibling (afterId)
    let beforeId = null;
    let afterId  = null;

    if (afterEl) {
      beforeId = afterEl.dataset.cardId ?? null;
      // Walk backwards past any drop-indicator divs
      let prev = afterEl.previousElementSibling;
      while (prev && !prev.classList.contains('card')) {
        prev = prev.previousElementSibling;
      }
      if (prev && prev.dataset.cardId && prev.dataset.cardId !== cardId) {
        afterId = prev.dataset.cardId;
      }
    } else {
      // Dropping at the end — find the last card element
      let last = listEl.lastElementChild;
      while (last && !last.classList.contains('card')) {
        last = last.previousElementSibling;
      }
      if (last && last.dataset.cardId && last.dataset.cardId !== cardId) {
        afterId = last.dataset.cardId;
      }
    }

    // Compute optimistic position
    const optimisticPos = computeOptimisticPosition(afterId, beforeId, targetColumnId);

    // Apply optimistic update to store
    const rollback = optimisticMove(cardId, targetColumnId, optimisticPos);

    // Re-render affected columns immediately
    const affectedColumns = new Set([prevColumnId, targetColumnId].filter(Boolean));
    if (renderColumnFn) {
      for (const colId of affectedColumns) {
        renderColumnFn(colId);
      }
    }

    // Send move to server; SSE will deliver the canonical result
    try {
      await moveCard(cardId, targetColumnId, afterId, beforeId);
    } catch (err) {
      console.error('[dragdrop] moveCard failed, rolling back:', err);
      if (rollback) {
        rollbackMove(cardId, rollback.prevColumnId, rollback.prevPosition);
        if (renderColumnFn) {
          for (const colId of affectedColumns) {
            renderColumnFn(colId);
          }
        }
      }
    }
  });
}
