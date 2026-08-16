/**
 * Kanban board – frontend entry point.
 *
 * Boot sequence:
 *  1. Connect to the SSE stream so we don't miss any events that
 *     arrive while we are loading the initial board state.
 *  2. Fetch the full board state from GET /api/board.
 *  3. Initialise the store and render the board.
 */

import { fetchBoard } from './api.js';
import { initBoard } from './store.js';
import { renderBoard } from './render.js';
import { connectSSE } from './sse-client.js';

async function boot() {
  // 1. Open the SSE connection first so we don't miss events.
  connectSSE();

  // 2. Load the initial board state.
  try {
    const columns = await fetchBoard();
    initBoard(columns);
    renderBoard();
  } catch (err) {
    console.error('[main] Failed to load board:', err);
    const board = document.getElementById('board');
    if (board) {
      board.innerHTML = `
        <div class="board-loading" style="color:#de350b">
          Failed to load board. Is the server running?<br>
          <small>${err.message}</small>
        </div>`;
    }
  }
}

boot();
