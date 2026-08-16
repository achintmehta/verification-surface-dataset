/**
 * Drag-and-drop module for the Kanban board.
 *
 * Uses the HTML5 Drag and Drop API.
 *
 * Lifecycle:
 *   1. User grabs a card  → dragstart
 *   2. Card is dragged over a column / other cards → dragover (shows ghost)
 *   3. Card is dropped → drop → optimistic DOM update → PATCH /api/cards/:id/move
 *   4. SSE event arrives → reconcile DOM to canonical server state
 *
 * The module exposes:
 *   initDragDrop(boardEl, onDrop)
 *     boardEl – the #board container element
 *     onDrop  – async callback({ cardId, columnId, afterId, beforeId })
 */

/** @type {HTMLElement|null} Currently dragged card element */
let draggedEl = null;
/** @type {string|null} */
let draggedCardId = null;

/** Ghost placeholder element inserted during drag */
let ghostEl = null;

/**
 * Initialise drag-and-drop on the board container.
 * Safe to call multiple times – only registers listeners once.
 *
 * @param {HTMLElement} boardEl
 * @param {(info: { cardId: string, columnId: string, afterId: string|null, beforeId: string|null }) => void} onDrop
 */
export function initDragDrop(boardEl, onDrop) {
  // Guard: only wire once per boardEl instance
  if (boardEl._dragDropWired) return;
  boardEl._dragDropWired = true;
  // ── dragstart ────────────────────────────────────────────────────────────
  boardEl.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;

    draggedEl = card;
    draggedCardId = card.dataset.cardId;

    // Use a transparent drag image so we control the visual entirely
    const img = new Image();
    img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    e.dataTransfer.setDragImage(img, 0, 0);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', draggedCardId);

    // Slight delay so the browser captures the element before we style it
    requestAnimationFrame(() => {
      card.classList.add('dragging');
    });

    // Create ghost placeholder with the same height
    ghostEl = document.createElement('div');
    ghostEl.className = 'card-ghost';
    ghostEl.style.height = `${card.offsetHeight}px`;
  });

  // ── dragend ──────────────────────────────────────────────────────────────
  boardEl.addEventListener('dragend', () => {
    if (draggedEl) draggedEl.classList.remove('dragging');
    removeGhost();
    clearDropIndicators(boardEl);
    draggedEl = null;
    draggedCardId = null;
  });

  // ── dragover ─────────────────────────────────────────────────────────────
  boardEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    if (!draggedEl) return;

    const targetList = e.target.closest('.card-list');
    if (!targetList) return;

    clearDropIndicators(boardEl);
    targetList.classList.add('drag-over');

    // Find the card element under the cursor
    const targetCard = e.target.closest('.card');

    if (!targetCard || targetCard === draggedEl) {
      // Hovering over empty space in the list – append ghost at end
      if (ghostEl && ghostEl.parentElement !== targetList) {
        targetList.appendChild(ghostEl);
      } else if (!ghostEl) {
        // shouldn't happen, but guard
      }
      return;
    }

    // Determine whether cursor is in the top or bottom half of the target card
    const rect = targetCard.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;

    if (e.clientY < midY) {
      // Insert ghost BEFORE targetCard
      targetList.insertBefore(ghostEl, targetCard);
    } else {
      // Insert ghost AFTER targetCard
      targetList.insertBefore(ghostEl, targetCard.nextSibling);
    }
  });

  // ── dragleave ────────────────────────────────────────────────────────────
  boardEl.addEventListener('dragleave', (e) => {
    // Only clear if we're leaving the board entirely
    if (!boardEl.contains(e.relatedTarget)) {
      clearDropIndicators(boardEl);
    }
  });

  // ── drop ─────────────────────────────────────────────────────────────────
  boardEl.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!draggedEl || !ghostEl) return;

    const targetList = ghostEl.parentElement;
    if (!targetList || !targetList.classList.contains('card-list')) {
      removeGhost();
      clearDropIndicators(boardEl);
      return;
    }

    const columnId = targetList.closest('.column')?.dataset.columnId;
    if (!columnId) {
      removeGhost();
      clearDropIndicators(boardEl);
      return;
    }

    // Determine afterId and beforeId from ghost's neighbours
    const siblings = Array.from(targetList.querySelectorAll('.card'));

    // Cards that are rendered before and after the ghost position
    // (excluding the dragged card itself which is still in the DOM but hidden)
    const visibleCards = siblings.filter((el) => el !== draggedEl);
    const ghostPos = getGhostIndexAmongCards(targetList, ghostEl, draggedEl);

    const afterEl  = visibleCards[ghostPos - 1] ?? null;
    const beforeEl = visibleCards[ghostPos]     ?? null;

    const afterId  = afterEl  ? afterEl.dataset.cardId  : null;
    const beforeId = beforeEl ? beforeEl.dataset.cardId : null;

    // ── Optimistic DOM update ──────────────────────────────────────────────
    // Move the real card element to where the ghost is
    targetList.insertBefore(draggedEl, ghostEl);
    removeGhost();
    clearDropIndicators(boardEl);
    draggedEl.classList.remove('dragging');

    // Update the card count badges
    updateColumnCounts(boardEl);

    // ── Fire the server mutation ───────────────────────────────────────────
    onDrop({ cardId: draggedCardId, columnId, afterId, beforeId });

    draggedEl = null;
    draggedCardId = null;
  });
}

/* ─── Helpers ───────────────────────────────────────────────────────────────── */

function removeGhost() {
  if (ghostEl && ghostEl.parentElement) {
    ghostEl.parentElement.removeChild(ghostEl);
  }
  ghostEl = null;
}

function clearDropIndicators(boardEl) {
  boardEl.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
  boardEl.querySelectorAll('.drop-above').forEach((el) => el.classList.remove('drop-above'));
  boardEl.querySelectorAll('.drop-below').forEach((el) => el.classList.remove('drop-below'));
}

/**
 * Determine the index of the ghost among the visible (non-dragged) cards.
 * @param {HTMLElement} list
 * @param {HTMLElement} ghost
 * @param {HTMLElement} dragged
 * @returns {number}
 */
function getGhostIndexAmongCards(list, ghost, dragged) {
  let idx = 0;
  for (const child of list.children) {
    if (child === ghost) break;
    if (child !== dragged && child.classList.contains('card')) idx++;
  }
  return idx;
}

/**
 * Refresh the card-count badge on every column after an optimistic move.
 * @param {HTMLElement} boardEl
 */
function updateColumnCounts(boardEl) {
  boardEl.querySelectorAll('.column').forEach((col) => {
    const count = col.querySelectorAll('.card').length;
    const badge = col.querySelector('.column-count');
    if (badge) badge.textContent = count;
  });
}
