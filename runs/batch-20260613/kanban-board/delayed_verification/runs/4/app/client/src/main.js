/**
 * Application entry point.
 *
 * Orchestrates:
 *   1. Initial board load from GET /api/board
 *   2. Board rendering
 *   3. Drag-and-drop wiring
 *   4. SSE subscription for real-time updates
 *   5. Optimistic updates + server reconciliation
 */

import { fetchBoard, createCard, moveCard } from './api.js';
import {
  initBoard as initState,
  upsertCard,
  replaceColumnCards,
  optimisticMove,
  rollbackMove,
  columns,
} from './state.js';
import {
  initBoard as initRenderer,
  renderBoard,
  renderCard,
  renderColumn,
} from './board.js';
import { initDrag } from './drag.js';
import { initSSE, onSSE } from './sse.js';

/* ── DOM refs ────────────────────────────────────────────────────────────── */
const boardEl    = document.getElementById('board');
const loadingEl  = document.getElementById('board-loading');
const sseStatus  = document.getElementById('sse-status');

/* ── Bootstrap ───────────────────────────────────────────────────────────── */

async function bootstrap() {
  // 1. Register SSE handlers BEFORE opening the connection so we don't miss
  //    events that arrive immediately after the stream opens.
  registerSSEHandlers();

  // 2. Connect to SSE stream
  initSSE(sseStatus);

  // 3. Load initial board state
  try {
    const board = await fetchBoard();
    initState(board);
  } catch (err) {
    console.error('[main] Failed to load board:', err);
    loadingEl.textContent = 'Failed to load board. Please refresh.';
    return;
  }

  // 4. Render
  loadingEl.remove();
  initRenderer(boardEl, handleAddCard);
  renderBoard();

  // 5. Wire up drag-and-drop
  initDrag(boardEl, handleDrop);
}

/* ── Add card ────────────────────────────────────────────────────────────── */

async function handleAddCard(columnId, text) {
  try {
    // Optimistic: the SSE broadcast will deliver the canonical card to all
    // clients (including this one), so we don't need a local optimistic insert.
    // We just fire the request; the SSE 'card-created' event will render it.
    await createCard(columnId, text);
  } catch (err) {
    console.error('[main] Failed to create card:', err);
    alert(`Could not create card: ${err.message}`);
  }
}

/* ── Drag-and-drop drop handler ──────────────────────────────────────────── */

/**
 * Called by the drag module when a card is dropped.
 *
 * @param {{ cardId: string, targetColumnId: string, afterId: string|null, beforeId: string|null }} info
 */
async function handleDrop({ cardId, targetColumnId, afterId, beforeId }) {
  // Validate that the target column exists
  if (!columns.has(targetColumnId)) return;

  // Apply optimistic update immediately
  const snapshot = optimisticMove(cardId, targetColumnId, afterId, beforeId);

  // Re-render the affected columns
  const affectedColumns = new Set([targetColumnId]);
  if (snapshot) affectedColumns.add(snapshot.prevColumnId);
  for (const colId of affectedColumns) renderColumn(colId);

  try {
    // Send the move to the server; the SSE broadcast will reconcile all clients
    await moveCard(cardId, targetColumnId, afterId, beforeId);
    // The SSE 'card-moved' event will apply the canonical state
  } catch (err) {
    console.error('[main] Move failed, rolling back:', err);
    // Roll back the optimistic update
    if (snapshot) {
      rollbackMove(cardId, snapshot);
      for (const colId of affectedColumns) renderColumn(colId);
    }
  }
}

/* ── SSE event handlers ──────────────────────────────────────────────────── */

function registerSSEHandlers() {
  /**
   * card-created: { card }
   * A new card was created. Apply to state and render.
   */
  onSSE('card-created', ({ card }) => {
    if (!card) return;
    upsertCard(card);
    renderCard(card);

    // Update count badge for the column
    const colEl = boardEl.querySelector(`.column[data-column-id="${card.column_id}"]`);
    if (colEl) {
      const countEl = colEl.querySelector('.column-count');
      if (countEl) {
        const col = columns.get(card.column_id);
        if (col) countEl.textContent = col.cards.length;
      }
    }
  });

  /**
   * card-moved: { card }
   * A card was moved/reordered. Apply canonical state and re-render.
   */
  onSSE('card-moved', ({ card }) => {
    if (!card) return;

    // Determine which columns are affected (source may differ from target)
    const existing = document.querySelector(`.card[data-card-id="${card.id}"]`);
    const prevColEl = existing?.closest('.column');
    const prevColId = prevColEl?.dataset.columnId;

    upsertCard(card);

    // Re-render affected columns for a clean, sorted view
    const affected = new Set([card.column_id]);
    if (prevColId && prevColId !== card.column_id) affected.add(prevColId);

    for (const colId of affected) renderColumn(colId);
  });

  /**
   * column-reordered: { columnId, cards }
   * The server renormalized a column's positions. Replace local state and re-render.
   */
  onSSE('column-reordered', ({ columnId, cards: serverCards }) => {
    if (!columnId || !serverCards) return;
    replaceColumnCards(columnId, serverCards);
    renderColumn(columnId);
  });
}

/* ── Start ───────────────────────────────────────────────────────────────── */
bootstrap();
