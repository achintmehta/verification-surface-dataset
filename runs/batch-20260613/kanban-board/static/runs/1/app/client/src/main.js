/**
 * Kanban Board – frontend entry point.
 *
 * Boot sequence:
 *  1. Fetch the full board state from GET /api/board.
 *  2. Render the board into the DOM.
 *  3. Attach drag-and-drop listeners.
 *  4. Attach add-card form listeners.
 *  5. Open the SSE connection to receive real-time updates.
 */

import { fetchBoard } from './api.js';
import { setState } from './state.js';
import { renderBoard } from './board.js';
import { initDragDrop } from './dragdrop.js';
import { initAddCard } from './add-card.js';
import { connectSSE } from './sse-client.js';

async function boot() {
  const statusEl = document.getElementById('connection-status');

  try {
    // 1. Load initial board state.
    const data = await fetchBoard();
    setState(data);

    // 2. Render the board.
    renderBoard();

    // 3. Attach drag-and-drop.
    initDragDrop();

    // 4. Attach add-card forms.
    initAddCard();

    // 5. Connect to SSE stream.
    connectSSE(statusEl);
  } catch (err) {
    console.error('[main] Boot failed:', err);
    const board = document.getElementById('board');
    const loading = document.getElementById('board-loading');
    if (loading) {
      loading.textContent = `Failed to load board: ${err.message}. Please refresh.`;
      loading.style.color = '#de350b';
    } else if (board) {
      board.innerHTML = `<p style="color:#de350b;padding:40px">Failed to load board: ${err.message}. Please refresh.</p>`;
    }
  }
}

boot();
