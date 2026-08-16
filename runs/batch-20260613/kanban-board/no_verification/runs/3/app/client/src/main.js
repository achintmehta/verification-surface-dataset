/**
 * Kanban Board – main entry point.
 *
 * Responsibilities:
 *   1. Fetch initial board state and render it.
 *   2. Connect to the SSE stream and handle incoming events.
 *   3. Wire up the add-card forms.
 *   4. Initialise drag-and-drop and handle drops.
 */

import { fetchBoard, createCard, moveCard } from './api.js';
import * as state from './state.js';
import { renderBoard, renderCard, renderColumnCards } from './board.js';
import { initDragDrop } from './dragdrop.js';
import { connect, on } from './stream.js';

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('connection-status');

// ---------------------------------------------------------------------------
// 1. Initial board load
// ---------------------------------------------------------------------------

async function loadBoard() {
  try {
    const { columns } = await fetchBoard();
    state.initBoard(columns);
    renderBoard(boardEl);
    wireAddCardForms();
  } catch (err) {
    console.error('[main] Failed to load board:', err);
    const loadingEl = document.getElementById('board-loading');
    if (loadingEl) loadingEl.textContent = 'Failed to load board. Please refresh.';
  }
}

// ---------------------------------------------------------------------------
// 2. SSE event handlers
// ---------------------------------------------------------------------------

on('board:init', ({ columns }) => {
  // The server sends the full board on every new SSE connection.
  // We reconcile by replacing the entire state and re-rendering.
  state.initBoard(columns);
  renderBoard(boardEl);
  wireAddCardForms();
});

on('card:created', ({ card }) => {
  // Upsert the card into state (handles the case where we already added it
  // optimistically) then update the DOM.
  state.upsertCard(card);
  renderCard(card);
});

on('card:moved', ({ card }) => {
  // Reconcile: replace the card's position with the server's canonical value.
  state.upsertCard(card);
  renderCard(card);
});

on('column:reorder', ({ columnId, cards }) => {
  // Server renormalised positions – replace the whole column.
  state.replaceColumnCards(columnId, cards);
  renderColumnCards(columnId, cards);
});

// ---------------------------------------------------------------------------
// 3. Add-card form wiring
// ---------------------------------------------------------------------------

/**
 * Wire up add-card buttons and forms for all columns currently in the DOM.
 * Called after every full board render.
 */
function wireAddCardForms() {
  boardEl.querySelectorAll('.column').forEach((colEl) => {
    const columnId = colEl.dataset.columnId;

    const btn      = colEl.querySelector(`.add-card-btn[data-add-btn-for="${columnId}"]`);
    const form     = colEl.querySelector(`.add-card-form[data-add-form-for="${columnId}"]`);
    const textarea = colEl.querySelector(`textarea[data-textarea-for="${columnId}"]`);
    const cancel   = colEl.querySelector(`.btn-add-cancel[data-cancel-for="${columnId}"]`);

    if (!btn || !form || !textarea || !cancel) return;

    // Avoid double-binding.
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';

    btn.addEventListener('click', () => {
      btn.style.display = 'none';
      form.style.display = 'flex';
      textarea.focus();
    });

    cancel.addEventListener('click', () => {
      closeForm(btn, form, textarea);
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = textarea.value.trim();
      if (!text) return;

      closeForm(btn, form, textarea);

      try {
        await createCard(columnId, text);
        // The SSE card:created event will update the DOM.
      } catch (err) {
        console.error('[main] createCard failed:', err);
        alert(`Failed to create card: ${err.message}`);
      }
    });

    // Submit on Ctrl+Enter / Cmd+Enter.
    textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
      if (e.key === 'Escape') {
        closeForm(btn, form, textarea);
      }
    });
  });
}

function closeForm(btn, form, textarea) {
  form.style.display = 'none';
  btn.style.display = '';
  textarea.value = '';
}

// ---------------------------------------------------------------------------
// 4. Drag-and-drop
// ---------------------------------------------------------------------------

initDragDrop(boardEl, async ({ cardId, toColumnId, beforeId, afterId, toIndex }) => {
  // Check whether this is actually a move (position or column changed).
  const found = state.findCard(cardId);
  if (!found) return;

  const { col: fromCol, index: fromIndex } = found;
  const isSameColumn = fromCol.id === toColumnId;

  // Determine the effective index in the target column, accounting for the
  // fact that the card is being removed from the source.
  let effectiveIndex = toIndex;
  if (isSameColumn && fromIndex < toIndex) {
    // The card will be removed from above, so the target index shifts down.
    effectiveIndex = toIndex - 1;
  }

  // No-op: dropped back in the same position.
  if (isSameColumn && fromIndex === effectiveIndex) return;

  // Optimistic update.
  const snapshot = state.optimisticMove(cardId, toColumnId, effectiveIndex);
  if (snapshot) {
    // Re-render both affected columns.
    const col = state.columns.get(toColumnId);
    if (col) renderColumnCards(toColumnId, col.cards);
    if (!isSameColumn) {
      const fromColState = state.columns.get(fromCol.id);
      if (fromColState) renderColumnCards(fromCol.id, fromColState.cards);
    }
  }

  try {
    await moveCard(cardId, toColumnId, beforeId, afterId);
    // The SSE card:moved event will reconcile the canonical position.
  } catch (err) {
    console.error('[main] moveCard failed:', err);
    // Roll back the optimistic update.
    if (snapshot) {
      state.rollbackMove(snapshot);
      const fromColState = state.columns.get(fromCol.id);
      if (fromColState) renderColumnCards(fromCol.id, fromColState.cards);
      if (!isSameColumn) {
        const toColState = state.columns.get(toColumnId);
        if (toColState) renderColumnCards(toColumnId, toColState.cards);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 5. SSE connection & status indicator
// ---------------------------------------------------------------------------

connect((connected) => {
  statusEl.classList.toggle('connected', connected);
  statusEl.classList.toggle('disconnected', !connected);
  statusEl.querySelector('.status-label').textContent = connected
    ? 'Live'
    : 'Reconnecting…';
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

loadBoard();
