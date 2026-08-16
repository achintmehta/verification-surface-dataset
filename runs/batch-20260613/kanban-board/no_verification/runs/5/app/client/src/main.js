/**
 * Main entry point for the Kanban board SPA.
 *
 * Responsibilities:
 *  1. Fetch initial board state and render it.
 *  2. Connect to the SSE stream for real-time updates.
 *  3. Wire up the "Add card" modal.
 *  4. Wire up drag-and-drop with optimistic updates + server reconciliation.
 */

import { fetchBoard, createCard, moveCard } from './api.js';
import { loadBoard, upsertCard, optimisticMove } from './store.js';
import { renderBoard, reconcileCard, reconcileColumn } from './render.js';
import { connectSSE } from './sse.js';
import { initDragAndDrop } from './drag.js';

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function init() {
  try {
    const board = await fetchBoard();
    loadBoard(board);
    renderBoard();
  } catch (err) {
    console.error('[init] Failed to load board:', err);
    document.getElementById('board-loading').textContent =
      'Failed to load board. Is the server running?';
    return;
  }

  // Remove loading indicator (renderBoard already cleared it via innerHTML)
  const loadingEl = document.getElementById('board-loading');
  if (loadingEl) loadingEl.remove();

  connectSSE();
  initDragAndDrop(document.getElementById('board'));
  wireAddCard();
  wireDrop();
}

// ── Add-card modal ────────────────────────────────────────────────────────────

let pendingColumnId = null;

function wireAddCard() {
  const modal = document.getElementById('card-modal');
  const form = document.getElementById('card-form');
  const textarea = document.getElementById('card-text');
  const cancelBtn = document.getElementById('modal-cancel');

  // Delegate click on any "Add a card" button
  document.getElementById('board').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-add-card]');
    if (!btn) return;
    pendingColumnId = btn.dataset.addCard;
    textarea.value = '';
    modal.showModal();
    textarea.focus();
  });

  cancelBtn.addEventListener('click', () => {
    modal.close();
    pendingColumnId = null;
  });

  // Close on backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.close();
      pendingColumnId = null;
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textarea.value.trim();
    if (!text || !pendingColumnId) return;

    modal.close();

    const colId = pendingColumnId;
    pendingColumnId = null;

    try {
      const { card } = await createCard(colId, text);
      // The SSE broadcast will handle updating all clients including this one.
      // But in case SSE is slow, also apply locally:
      upsertCard(card);
      reconcileCard(card);
    } catch (err) {
      console.error('[addCard] Failed:', err);
      alert(`Failed to create card: ${err.message}`);
    }
  });
}

// ── Drag-and-drop ─────────────────────────────────────────────────────────────

function wireDrop() {
  document.getElementById('board').addEventListener('card-drop', async (e) => {
    const { cardId, targetColumnId, afterId, beforeId } = e.detail;

    // Optimistic update
    const snapshot = optimisticMove(cardId, targetColumnId, afterId, beforeId);

    // Reflect optimistic state in the DOM immediately
    if (snapshot) {
      // Reconcile both source and target columns
      if (snapshot.prevColumnId !== targetColumnId) {
        reconcileColumn(snapshot.prevColumnId);
      }
      reconcileColumn(targetColumnId);
    }

    // Send to server
    try {
      const { card } = await moveCard(cardId, targetColumnId, afterId, beforeId);
      // Apply canonical server state (reconciles any optimistic drift)
      upsertCard(card);
      reconcileCard(card);
    } catch (err) {
      console.error('[drop] moveCard failed:', err);
      // Roll back optimistic update by re-fetching the board
      try {
        const board = await fetchBoard();
        loadBoard(board);
        renderBoard();
      } catch (fetchErr) {
        console.error('[drop] rollback fetch failed:', fetchErr);
      }
    }
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────

init();
