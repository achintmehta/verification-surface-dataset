/**
 * Kanban Board – main application entry point.
 *
 * Orchestrates:
 *  1. Initial board load from the server
 *  2. SSE subscription for real-time updates
 *  3. Optimistic drag-and-drop moves
 *  4. Card creation
 *  5. Reconciliation of server-authoritative state
 */

import { fetchBoard, createCard, moveCard } from './api.js';
import {
  setBoard,
  upsertCard,
  setColumnCards,
  optimisticMove,
  rollbackCard,
  getCard,
} from './state.js';
import {
  renderBoard,
  reconcileCard,
  reconcileColumn,
  setDropHandler,
  setCreateHandler,
} from './render.js';
import { on, onStatusChange, connect } from './sse-client.js';

const boardEl = document.getElementById('board');
const loadingEl = document.getElementById('board-loading');
const statusEl = document.getElementById('connection-status');

/* ── Connection status indicator ─────────────────────────── */
onStatusChange((connected) => {
  statusEl.classList.toggle('connected', connected);
  statusEl.title = connected ? 'Connected' : 'Disconnected – reconnecting…';
});

/* ── SSE event handlers ──────────────────────────────────── */

on('card:created', ({ card }) => {
  console.log('[sse] card:created', card.id);
  upsertCard(card);
  reconcileCard(card);
});

on('card:moved', ({ card }) => {
  console.log('[sse] card:moved', card.id, '→', card.column_id);
  upsertCard(card);
  reconcileCard(card);
});

on('renormalize', ({ columnId, cards }) => {
  console.log('[sse] renormalize column', columnId);
  setColumnCards(columnId, cards);
  reconcileColumn(columnId, cards);
});

/* ── Drop handler (drag-and-drop) ────────────────────────── */
setDropHandler(async ({ cardId, targetColumnId, beforeId, afterId }) => {
  // Ignore no-op drops (same position)
  const found = getCard(cardId);
  if (!found) return;

  // Apply optimistic update immediately
  const rollback = optimisticMove(cardId, targetColumnId, afterId, beforeId);

  // Reflect optimistic state in DOM
  const { card: optimisticCard } = getCard(cardId) ?? {};
  if (optimisticCard) {
    reconcileCard({ ...optimisticCard, _optimistic: true });
  }

  try {
    const { card: canonical } = await moveCard(cardId, {
      columnId: targetColumnId,
      beforeId,
      afterId,
    });

    // Reconcile with server's canonical position
    upsertCard(canonical);
    reconcileCard(canonical);
  } catch (err) {
    console.error('[move] failed, rolling back:', err.message);
    if (rollback) {
      rollbackCard(rollback.prevCard);
      reconcileCard(rollback.prevCard);
    }
  }
});

/* ── Create handler ──────────────────────────────────────── */
setCreateHandler(async (columnId, text) => {
  try {
    const { card } = await createCard(columnId, text);
    // The SSE broadcast will handle updating all clients including this one.
    // But in case SSE is slow, also apply locally:
    upsertCard(card);
    reconcileCard(card);
  } catch (err) {
    console.error('[create] failed:', err.message);
    alert(`Failed to create card: ${err.message}`);
  }
});

/* ── Initial load ────────────────────────────────────────── */
async function init() {
  try {
    const { columns } = await fetchBoard();
    setBoard(columns);

    // Remove loading indicator and render
    loadingEl?.remove();
    renderBoard({ columns }, boardEl);

    // Connect SSE after board is rendered so we don't miss events
    connect();
  } catch (err) {
    console.error('[init] failed to load board:', err);
    if (loadingEl) {
      loadingEl.textContent = `Failed to load board: ${err.message}. Retrying…`;
    }
    // Retry after 3 seconds
    setTimeout(init, 3_000);
  }
}

init();
