/**
 * Drag-and-drop module.
 *
 * Implements pointer-event-based drag-and-drop (not the HTML5 DnD API, which
 * has poor cross-browser behaviour for custom ghost elements).
 *
 * Lifecycle:
 *   1. pointerdown on a .card  → start drag
 *   2. pointermove              → move ghost, compute drop target
 *   3. pointerup                → commit drop, call onDrop callback
 *
 * The module is stateless between drags; all drag state lives in a closure
 * created per drag gesture.
 */

/** @typedef {import('./state.js').Card} Card */

/**
 * @callback OnDropCallback
 * @param {string}      cardId
 * @param {string}      targetColumnId
 * @param {string|null} beforeId   – card immediately before the drop slot
 * @param {string|null} afterId    – card immediately after the drop slot
 */

/**
 * Attach drag-and-drop listeners to the board element.
 *
 * @param {HTMLElement}    boardEl  – the .board container
 * @param {OnDropCallback} onDrop   – called when a card is successfully dropped
 */
export function initDragDrop(boardEl, onDrop) {
  boardEl.addEventListener('pointerdown', (e) => {
    const cardEl = e.target.closest('.card');
    if (!cardEl) return;

    // Prevent text selection during drag.
    e.preventDefault();

    startDrag(e, cardEl, boardEl, onDrop);
  });
}

// ---------------------------------------------------------------------------
// Drag implementation
// ---------------------------------------------------------------------------

function startDrag(startEvent, cardEl, boardEl, onDrop) {
  const cardId = cardEl.dataset.cardId;
  if (!cardId) return;

  // ── Ghost element ──────────────────────────────────────────────────────
  const ghost = document.createElement('div');
  ghost.className = 'card-ghost';
  ghost.textContent = cardEl.textContent;
  ghost.style.width = `${cardEl.offsetWidth}px`;
  document.body.appendChild(ghost);

  // Offset of the pointer within the card so the ghost tracks naturally.
  const rect = cardEl.getBoundingClientRect();
  const offsetX = startEvent.clientX - rect.left;
  const offsetY = startEvent.clientY - rect.top;

  positionGhost(ghost, startEvent.clientX, startEvent.clientY, offsetX, offsetY);

  // Mark the original card as dragging (dims it).
  cardEl.classList.add('dragging');

  // Active placeholder element (the blue insertion indicator).
  let placeholder = null;

  // ── Pointer move ───────────────────────────────────────────────────────
  function onPointerMove(e) {
    positionGhost(ghost, e.clientX, e.clientY, offsetX, offsetY);

    // Remove old placeholder.
    if (placeholder) {
      placeholder.remove();
      placeholder = null;
    }

    const target = computeDropTarget(e.clientX, e.clientY, cardEl, boardEl);
    if (!target) return;

    placeholder = createPlaceholder(target.isEmpty);
    insertPlaceholder(placeholder, target);
  }

  // ── Pointer up ─────────────────────────────────────────────────────────
  function onPointerUp(e) {
    cleanup();

    const target = computeDropTarget(e.clientX, e.clientY, cardEl, boardEl);
    if (!target) return;

    onDrop(cardId, target.columnId, target.beforeId, target.afterId);
  }

  // ── Pointer cancel ─────────────────────────────────────────────────────
  function onPointerCancel() {
    cleanup();
  }

  function cleanup() {
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerCancel);
    ghost.remove();
    cardEl.classList.remove('dragging');
    if (placeholder) {
      placeholder.remove();
      placeholder = null;
    }
  }

  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerCancel);
}

// ---------------------------------------------------------------------------
// Drop target computation
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   columnId: string,
 *   beforeId: string|null,
 *   afterId:  string|null,
 *   isEmpty:  boolean,
 *   refEl:    HTMLElement|null,
 *   insertBefore: boolean,
 * }} DropTarget
 */

/**
 * Given the current pointer position, determine where the card would be
 * dropped.
 *
 * Returns null if the pointer is not over any column.
 *
 * @param {number}      x
 * @param {number}      y
 * @param {HTMLElement} draggedCardEl  – the card being dragged (excluded from targets)
 * @param {HTMLElement} boardEl
 * @returns {DropTarget|null}
 */
function computeDropTarget(x, y, draggedCardEl, boardEl) {
  // Find which column the pointer is over.
  const columnEl = findColumnAtPoint(x, y, boardEl);
  if (!columnEl) return null;

  const columnId = columnEl.dataset.columnId;
  const cardListEl = columnEl.querySelector('.card-list');
  if (!cardListEl) return null;

  // Collect all card elements in this column, excluding the dragged card.
  const cardEls = Array.from(cardListEl.querySelectorAll('.card')).filter(
    (el) => el !== draggedCardEl && !el.classList.contains('dragging'),
  );

  if (cardEls.length === 0) {
    // Empty column – drop at the only slot.
    return {
      columnId,
      beforeId: null,
      afterId: null,
      isEmpty: true,
      refEl: cardListEl,
      insertBefore: false,
    };
  }

  // Find the card whose vertical midpoint is closest to the pointer.
  // We insert BEFORE a card if the pointer is in its upper half, AFTER if lower.
  for (let i = 0; i < cardEls.length; i++) {
    const el = cardEls[i];
    const r = el.getBoundingClientRect();
    const mid = r.top + r.height / 2;

    if (y <= mid) {
      // Insert before cardEls[i]
      const afterId = el.dataset.cardId ?? null;
      const beforeId = i > 0 ? (cardEls[i - 1].dataset.cardId ?? null) : null;
      return {
        columnId,
        beforeId,
        afterId,
        isEmpty: false,
        refEl: el,
        insertBefore: true,
      };
    }
  }

  // Pointer is below all cards – append at end.
  const lastEl = cardEls[cardEls.length - 1];
  return {
    columnId,
    beforeId: lastEl.dataset.cardId ?? null,
    afterId: null,
    isEmpty: false,
    refEl: lastEl,
    insertBefore: false,
  };
}

/**
 * Find the .column element whose bounding rect contains the point (x, y).
 * Falls back to the closest column if the pointer is between columns.
 */
function findColumnAtPoint(x, y, boardEl) {
  const columns = Array.from(boardEl.querySelectorAll('.column'));

  // Exact hit test first.
  for (const col of columns) {
    const r = col.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      return col;
    }
  }

  // Fallback: find the column whose horizontal centre is closest.
  let best = null;
  let bestDist = Infinity;
  for (const col of columns) {
    const r = col.getBoundingClientRect();
    const cx = (r.left + r.right) / 2;
    const dist = Math.abs(x - cx);
    if (dist < bestDist) {
      bestDist = dist;
      best = col;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Placeholder helpers
// ---------------------------------------------------------------------------

function createPlaceholder(isEmpty) {
  const el = document.createElement('div');
  el.className = isEmpty ? 'drop-placeholder tall' : 'drop-placeholder';
  return el;
}

function insertPlaceholder(placeholder, target) {
  if (target.isEmpty) {
    target.refEl.appendChild(placeholder);
    return;
  }

  if (target.insertBefore) {
    target.refEl.parentNode.insertBefore(placeholder, target.refEl);
  } else {
    target.refEl.parentNode.insertBefore(placeholder, target.refEl.nextSibling);
  }
}

// ---------------------------------------------------------------------------
// Ghost positioning
// ---------------------------------------------------------------------------

function positionGhost(ghost, clientX, clientY, offsetX, offsetY) {
  ghost.style.left = `${clientX - offsetX}px`;
  ghost.style.top = `${clientY - offsetY}px`;
}
