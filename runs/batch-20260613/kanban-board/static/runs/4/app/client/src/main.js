/**
 * Kanban Board – main application entry point.
 *
 * Responsibilities:
 *   1. Fetch initial board state and render it.
 *   2. Connect to the SSE stream; apply incoming events to state + DOM.
 *   3. Wire up the "Add card" forms in each column.
 *   4. Initialise drag-and-drop; on drop, send PATCH and reconcile.
 */

import { fetchBoard, createCard, moveCard } from './api.js';
import {
  getState,
  setBoardState,
  applyCardCreated,
  applyCardMoved,
  applyColumnReordered,
} from './state.js';
import { renderBoard, reconcileBoard, reconcileColumn, createCardEl } from './render.js';
import { connectSSE } from './sse-client.js';
import { initDragDrop } from './dragdrop.js';

const boardEl = document.getElementById('board');

/* ─────────────────────────────────────────────────────────────────────────────
   1. Initial load
───────────────────────────────────────────────────────────────────────────── */

async function loadBoard() {
  boardEl.innerHTML = `
    <div class="board-loading">
      <div class="spinner"></div>
      <span>Loading board…</span>
    </div>
  `;

  try {
    const data = await fetchBoard();
    setBoardState(data);
    renderBoard(boardEl, getState().columns);
    wireAddCardForms(boardEl);
    initDragDrop(boardEl, handleDrop);
  } catch (err) {
    console.error('[main] Failed to load board:', err);
    boardEl.innerHTML = `
      <div class="board-loading" style="color:#de350b">
        ⚠ Failed to load board. Please refresh.
      </div>
    `;
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   2. SSE event handlers
───────────────────────────────────────────────────────────────────────────── */

connectSSE({
  /**
   * board:state – full snapshot sent on (re)connect.
   * Reconcile the DOM to the server's canonical state.
   */
  onBoardState(payload) {
    setBoardState(payload);
    // reconcileBoard may do a full re-render which resets the wiring flags.
    // wireAddCardForms and initDragDrop both guard against double-registration.
    reconcileBoard(boardEl, getState().columns);
    wireAddCardForms(boardEl);
    initDragDrop(boardEl, handleDrop);
  },

  /**
   * card:created – a new card was created (possibly by another client).
   * Add it to state and insert it into the correct column's DOM.
   */
  onCardCreated(payload) {
    applyCardCreated(payload);
    const card = payload.card;
    const colEl = boardEl.querySelector(`.column[data-column-id="${card.column_id}"]`);
    if (!colEl) return;

    const list = colEl.querySelector('.card-list');
    if (!list) return;

    // Check if the card already exists in the DOM (optimistic insert)
    if (list.querySelector(`[data-card-id="${card.id}"]`)) return;

    // Find the correct insertion point by position
    const existingCards = Array.from(list.querySelectorAll('.card'));
    const insertBefore = existingCards.find(
      (el) => Number(el.dataset.position) > card.position,
    ) ?? null;

    const cardEl = createCardEl(card);
    list.insertBefore(cardEl, insertBefore);

    // Update count badge
    const badge = colEl.querySelector('.column-count');
    if (badge) badge.textContent = list.querySelectorAll('.card').length;
  },

  /**
   * card:moved – a card was moved (possibly by another client, or the
   * server's canonical response to our own move).
   * Reconcile the affected column(s) to the canonical state.
   */
  onCardMoved(payload) {
    const prevColumnId = findCardColumnInDOM(payload.card.id);
    applyCardMoved(payload);

    const targetColumnId = payload.card.column_id;

    // For cross-column moves: reconcile the SOURCE column first so the card
    // element is removed from the old column before we insert it into the new
    // one. This prevents a transient duplicate.
    if (prevColumnId && prevColumnId !== targetColumnId) {
      const srcCol = getState().columns.find((c) => c.id === prevColumnId);
      if (srcCol) reconcileColumn(prevColumnId, srcCol.cards);
    }

    // Reconcile the target column (card is now inserted here)
    const targetCol = getState().columns.find((c) => c.id === targetColumnId);
    if (targetCol) reconcileColumn(targetColumnId, targetCol.cards);
  },

  /**
   * column:reordered – server renormalised positions in a column.
   * Snap the column's DOM to the canonical order.
   */
  onColumnReordered(payload) {
    applyColumnReordered(payload);
    reconcileColumn(payload.columnId, payload.cards);
  },
});

/* ─────────────────────────────────────────────────────────────────────────────
   3. Add-card forms
───────────────────────────────────────────────────────────────────────────── */

/**
 * Wire up the "Add a card" button and form for every column currently in the DOM.
 * Safe to call multiple times (uses event delegation via closest()).
 */
function wireAddCardForms(boardEl) {
  // Use event delegation on the board element to avoid re-wiring on reconcile
  // (we only call this once per full render, but guard against duplicates)
  if (boardEl._addCardWired) return;
  boardEl._addCardWired = true;

  boardEl.addEventListener('click', async (e) => {
    // ── Open form ──────────────────────────────────────────────────────────
    const addBtn = e.target.closest('.add-card-btn');
    if (addBtn) {
      const area = addBtn.closest('.add-card-area');
      addBtn.style.display = 'none';
      const form = area.querySelector('.add-card-form');
      form.classList.add('visible');
      form.querySelector('.add-card-textarea').focus();
      return;
    }

    // ── Cancel form ────────────────────────────────────────────────────────
    const cancelBtn = e.target.closest('.add-card-cancel');
    if (cancelBtn) {
      closeAddCardForm(cancelBtn.closest('.add-card-area'));
      return;
    }

    // ── Submit form ────────────────────────────────────────────────────────
    const submitBtn = e.target.closest('.add-card-submit');
    if (submitBtn) {
      await submitAddCard(submitBtn);
      return;
    }
  });

  // Allow Ctrl+Enter / Cmd+Enter to submit, Escape to cancel
  boardEl.addEventListener('keydown', async (e) => {
    const textarea = e.target.closest('.add-card-textarea');
    if (!textarea) return;

    if (e.key === 'Escape') {
      closeAddCardForm(textarea.closest('.add-card-area'));
      return;
    }

    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      const submitBtn = textarea.closest('.add-card-form').querySelector('.add-card-submit');
      await submitAddCard(submitBtn);
    }
  });
}

function closeAddCardForm(areaEl) {
  const form = areaEl.querySelector('.add-card-form');
  form.classList.remove('visible');
  form.querySelector('.add-card-textarea').value = '';
  areaEl.querySelector('.add-card-btn').style.display = '';
}

async function submitAddCard(submitBtn) {
  const form    = submitBtn.closest('.add-card-form');
  const area    = form.closest('.add-card-area');
  const colEl   = area.closest('.column');
  const columnId = colEl.dataset.columnId;
  const textarea = form.querySelector('.add-card-textarea');
  const text     = textarea.value.trim();

  if (!text) {
    textarea.focus();
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Adding…';

  try {
    await createCard(columnId, text);
    // The SSE event will add the card to the DOM
    closeAddCardForm(area);
  } catch (err) {
    console.error('[main] Failed to create card:', err);
    alert(`Failed to add card: ${err.message}`);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Add card';
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   4. Drag-and-drop handler
───────────────────────────────────────────────────────────────────────────── */

/**
 * Called by the drag-drop module after a successful drop.
 * Sends the PATCH request; the SSE event will reconcile the canonical state.
 *
 * @param {{ cardId: string, columnId: string, afterId: string|null, beforeId: string|null }} info
 */
async function handleDrop({ cardId, columnId, afterId, beforeId }) {
  try {
    await moveCard(cardId, columnId, afterId, beforeId);
    // The server will broadcast a card:moved event which reconciles the DOM
  } catch (err) {
    console.error('[main] Failed to move card:', err);
    // On failure, re-fetch and reconcile to restore correct state
    try {
      const data = await fetchBoard();
      setBoardState(data);
      reconcileBoard(boardEl, getState().columns);
    } catch (fetchErr) {
      console.error('[main] Failed to recover board state:', fetchErr);
    }
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Utility
───────────────────────────────────────────────────────────────────────────── */

/**
 * Find which column a card currently lives in by inspecting the DOM.
 * @param {string} cardId
 * @returns {string|null}
 */
function findCardColumnInDOM(cardId) {
  const cardEl = boardEl.querySelector(`[data-card-id="${cardId}"]`);
  if (!cardEl) return null;
  return cardEl.closest('.column')?.dataset.columnId ?? null;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Bootstrap
───────────────────────────────────────────────────────────────────────────── */

loadBoard();
