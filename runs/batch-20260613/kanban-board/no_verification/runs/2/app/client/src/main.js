/**
 * Kanban Board – main entry point.
 *
 * Orchestrates:
 *  1. Initial board load from the server
 *  2. SSE stream for real-time updates
 *  3. Drag-and-drop interactions
 *  4. Optimistic UI with server reconciliation
 */

import { fetchBoard, createCard, moveCard } from './api.js';
import {
  loadBoard,
  getColumns,
  optimisticAddCard,
  confirmCard,
  revertCard,
  optimisticMove,
  applyCardUpsert,
  applyColumnReorder,
} from './state.js';
import {
  setBoardEl,
  renderBoard,
  upsertCardInDom,
  reorderColumnInDom,
  updateColumnCount,
} from './render.js';
import { initDragAndDrop } from './drag.js';
import { startStream } from './stream.js';

/* ------------------------------------------------------------------ */
/*  Bootstrap                                                           */
/* ------------------------------------------------------------------ */

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('connection-status');

setBoardEl(boardEl);

async function init() {
  boardEl.innerHTML = '<div class="board-loading">Loading board…</div>';

  try {
    const serverColumns = await fetchBoard();
    loadBoard(serverColumns);
    renderBoard(handleAddCard);
    initDragAndDrop(boardEl, handleDrop);
    startStream({
      onCardCreated: handleServerCardCreated,
      onCardMoved: handleServerCardMoved,
      onColumnReorder: handleServerColumnReorder,
      onStatusChange: updateConnectionStatus,
    });
  } catch (err) {
    console.error('[init] Failed to load board:', err);
    boardEl.innerHTML = `<div class="board-error">Failed to load board: ${err.message}</div>`;
  }
}

/* ------------------------------------------------------------------ */
/*  Connection status indicator                                         */
/* ------------------------------------------------------------------ */

function updateConnectionStatus(status) {
  statusEl.className = `connection-status ${status}`;
  const labels = {
    connected: 'Connected',
    disconnected: 'Disconnected',
    reconnecting: 'Reconnecting…',
  };
  statusEl.title = labels[status] ?? status;
}

/* ------------------------------------------------------------------ */
/*  Add card handler                                                    */
/* ------------------------------------------------------------------ */

async function handleAddCard(columnId, text) {
  // Generate a temporary id for optimistic rendering
  const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Optimistic update
  const tempCard = optimisticAddCard(columnId, text, tempId);
  if (tempCard) {
    upsertCardInDom(tempCard);
    updateColumnCount(columnId);
  }

  try {
    const serverCard = await createCard(columnId, text);
    // Replace temp card with server card in state
    confirmCard(tempId, serverCard);
    // The SSE `card-created` event will also arrive and call upsertCardInDom,
    // but we handle it here too in case SSE is slow or this client's own event
    // arrives before the SSE broadcast.
    upsertCardInDom(serverCard);
    updateColumnCount(columnId);
  } catch (err) {
    console.error('[handleAddCard]', err);
    revertCard(tempId);
    // Remove the optimistic element from DOM
    const el = boardEl.querySelector(`.card[data-card-id="${tempId}"]`);
    if (el) el.remove();
    updateColumnCount(columnId);
    alert(`Failed to create card: ${err.message}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Drag-and-drop drop handler                                          */
/* ------------------------------------------------------------------ */

async function handleDrop({ cardId, targetColumnId, beforeId, afterId }) {
  // Find the card's current column before the optimistic move
  const sourceColumnId = (() => {
    for (const col of getColumns()) {
      if (col.cards.some((c) => c.id === cardId)) return col.id;
    }
    return null;
  })();

  // Optimistic update
  optimisticMove(cardId, targetColumnId, beforeId, afterId);
  upsertCardInDom(
    // Find the card in state after the optimistic move
    (() => {
      for (const col of getColumns()) {
        const c = col.cards.find((x) => x.id === cardId);
        if (c) return c;
      }
      return null;
    })()
  );
  if (sourceColumnId && sourceColumnId !== targetColumnId) {
    updateColumnCount(sourceColumnId);
  }
  updateColumnCount(targetColumnId);

  try {
    const serverCard = await moveCard(cardId, targetColumnId, beforeId, afterId);
    // Reconcile: apply server's canonical position
    applyCardUpsert(serverCard);
    upsertCardInDom(serverCard);
    if (sourceColumnId && sourceColumnId !== targetColumnId) {
      updateColumnCount(sourceColumnId);
    }
    updateColumnCount(targetColumnId);
  } catch (err) {
    console.error('[handleDrop]', err);
    // On error, reload the full board to get back to a consistent state
    try {
      const serverColumns = await fetchBoard();
      loadBoard(serverColumns);
      renderBoard(handleAddCard);
      initDragAndDrop(boardEl, handleDrop);
    } catch (reloadErr) {
      console.error('[handleDrop] reload failed:', reloadErr);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  SSE event handlers                                                  */
/* ------------------------------------------------------------------ */

/**
 * A new card was created (possibly by another client).
 * We must not duplicate a card we already added optimistically.
 */
function handleServerCardCreated(card) {
  // If we already have this card (confirmed from our own POST response),
  // just ensure the DOM is up to date.
  applyCardUpsert(card);
  upsertCardInDom(card);
  updateColumnCount(card.column_id);
}

/**
 * A card was moved (possibly by another client).
 */
function handleServerCardMoved(card) {
  // Find old column before applying state change
  let oldColumnId = null;
  for (const col of getColumns()) {
    if (col.cards.some((c) => c.id === card.id)) {
      oldColumnId = col.id;
      break;
    }
  }

  applyCardUpsert(card);
  upsertCardInDom(card);

  if (oldColumnId && oldColumnId !== card.column_id) {
    updateColumnCount(oldColumnId);
  }
  updateColumnCount(card.column_id);
}

/**
 * A column's cards were renormalized by the server.
 */
function handleServerColumnReorder(columnId, cards) {
  applyColumnReorder(columnId, cards);
  reorderColumnInDom(columnId, cards);
  updateColumnCount(columnId);
}

/* ------------------------------------------------------------------ */
/*  Start                                                               */
/* ------------------------------------------------------------------ */

init();
