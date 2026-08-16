/**
 * main.js - application entry point.
 *
 * Wires together:
 *  - API calls (api.js)
 *  - Client-side state (state.js)
 *  - UI rendering (ui.js)
 *  - Drag-and-drop (dragdrop.js)
 *  - SSE real-time sync (sse.js)
 */

import { fetchBoard, createCard, moveCard } from './api.js';
import {
  initState,
  getState,
  optimisticMove,
  reconcileCard,
  applyColumnReorder,
  upsertCard,
  findCard,
  findCardColumn,
} from './state.js';
import {
  initUI,
  renderBoard,
  reconcileCardDOM,
  reorderColumnDOM,
  addCardToDOM,
  setConnectionStatus,
  updateAllColumnCounts,
} from './ui.js';
import { initDragDrop } from './dragdrop.js';
import { connectSSE } from './sse.js';

const boardEl = document.getElementById('board');

// ------------------------------------------------------------------ //
//  Bootstrap                                                           //
// ------------------------------------------------------------------ //

async function bootstrap() {
  boardEl.innerHTML = '<div class="board-loading">Loading board...</div>';

  try {
    const data = await fetchBoard();
    initState(data);
    initUI(boardEl, handleAddCard);
    renderBoard();
    initDragDrop(boardEl, handleDrop);
    connectSSE(
      {
        connected: () => {},
        'card:created': handleSSECardCreated,
        'card:moved': handleSSECardMoved,
        'column:reordered': handleSSEColumnReordered,
      },
      setConnectionStatus
    );
  } catch (err) {
    console.error('[bootstrap]', err);
    boardEl.innerHTML =
      '<div class="board-error">Failed to load board: ' + err.message + '</div>';
  }
}

// ------------------------------------------------------------------ //
//  Add card                                                            //
// ------------------------------------------------------------------ //

async function handleAddCard(columnId, text) {
  const tempId = 'temp-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const tempCard = {
    id: tempId,
    column_id: columnId,
    text: text,
    position: getMaxPositionInColumn(columnId) + 1000,
    created_at: new Date().toISOString(),
  };

  // Optimistic insert
  upsertCard(tempCard);
  addCardToDOM(tempCard);

  try {
    const { card } = await createCard(columnId, text);

    // Remove the temp placeholder
    removeTempCard(tempId, columnId);

    // Insert the real card if the SSE event hasn't arrived yet
    if (!findCard(card.id)) {
      upsertCard(card);
      addCardToDOM(card);
    }
  } catch (err) {
    removeTempCard(tempId, columnId);
    console.error('[handleAddCard]', err);
    alert('Could not create card: ' + err.message);
  }
}

function getMaxPositionInColumn(columnId) {
  const { columns } = getState();
  const col = columns.get(columnId);
  if (!col || col.cards.length === 0) return 0;
  return Math.max(...col.cards.map((c) => c.position));
}

function removeTempCard(tempId, columnId) {
  const { columns } = getState();
  const col = columns.get(columnId);
  if (col) {
    col.cards = col.cards.filter((c) => c.id !== tempId);
  }
  const el = document.querySelector('[data-card-id="' + tempId + '"]');
  if (el) el.remove();
  updateAllColumnCounts();
}

// ------------------------------------------------------------------ //
//  Drag-and-drop handler                                               //
// ------------------------------------------------------------------ //

async function handleDrop(cardId, targetColumnId, afterId, beforeId) {
  if (!cardId) return;

  const card = findCard(cardId);
  if (!card) return;

  // Skip no-op drops
  const srcCol = findCardColumn(cardId);
  if (srcCol && srcCol.id === targetColumnId && isNoOp(srcCol, cardId, afterId, beforeId)) {
    return;
  }

  // Optimistic update
  const prevColumnId = optimisticMove(cardId, targetColumnId, afterId, beforeId);

  rerenderColumnFromState(targetColumnId);
  if (prevColumnId && prevColumnId !== targetColumnId) {
    rerenderColumnFromState(prevColumnId);
  }

  // Server mutation
  try {
    await moveCard(cardId, targetColumnId, afterId, beforeId);
    // SSE card:moved event will reconcile canonical state
  } catch (err) {
    console.error('[handleDrop]', err);
    // Roll back by reloading from server
    try {
      const data = await fetchBoard();
      initState(data);
      renderBoard();
    } catch (reloadErr) {
      console.error('[handleDrop] reload failed', reloadErr);
    }
  }
}

// ------------------------------------------------------------------ //
//  SSE event handlers                                                  //
// ------------------------------------------------------------------ //

function handleSSECardCreated({ card }) {
  upsertCard(card);
  addCardToDOM(card);
}

function handleSSECardMoved({ card }) {
  const positionChanged = reconcileCard(card);
  reconcileCardDOM(card, positionChanged);
  updateAllColumnCounts();
}

function handleSSEColumnReordered({ columnId, cards }) {
  applyColumnReorder(columnId, cards);
  reorderColumnDOM(columnId, cards);
  updateAllColumnCounts();
}

// ------------------------------------------------------------------ //
//  Helpers                                                             //
// ------------------------------------------------------------------ //

function rerenderColumnFromState(columnId) {
  const { columns } = getState();
  const col = columns.get(columnId);
  if (!col) return;
  reorderColumnDOM(columnId, col.cards);
  updateAllColumnCounts();
}

function isNoOp(col, cardId, afterId, beforeId) {
  const cards = col.cards;
  const idx = cards.findIndex((c) => c.id === cardId);
  if (idx === -1) return false;

  const prevCard = idx > 0 ? cards[idx - 1] : null;
  const nextCard = idx < cards.length - 1 ? cards[idx + 1] : null;

  const prevId = prevCard ? prevCard.id : null;
  const nextId = nextCard ? nextCard.id : null;

  return prevId === (afterId || null) && nextId === (beforeId || null);
}

// ------------------------------------------------------------------ //
//  Start                                                               //
// ------------------------------------------------------------------ //

bootstrap();
