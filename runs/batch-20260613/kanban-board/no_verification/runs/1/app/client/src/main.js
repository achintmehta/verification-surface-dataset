/**
 * Application entry point.
 *
 * 1. Fetch initial board state from the server.
 * 2. Populate the store.
 * 3. Render the board.
 * 4. Wire up the drag-and-drop render callback (breaks circular import).
 * 5. Connect to the SSE stream for real-time updates.
 */

import { fetchBoard } from './api.js';
import { setBoard } from './store.js';
import { renderBoard, renderColumn } from './board.js';
import { setRenderCallback } from './dragdrop.js';
import { connectSSE } from './sse.js';

// Import dialog module so its event listeners are registered
import './dialog.js';

async function init() {
  const boardEl   = document.getElementById('board');
  const loadingEl = document.getElementById('board-loading');

  // Wire up the render callback so dragdrop.js can trigger re-renders
  // without importing board.js directly (avoids circular dependency).
  setRenderCallback(renderColumn);

  try {
    // 1. Load board state
    const data = await fetchBoard();

    // 2. Populate store
    setBoard(data);

    // 3. Render
    loadingEl?.remove();
    renderBoard(boardEl);

    // 4. Connect SSE (after render so handlers can update the DOM)
    connectSSE();
  } catch (err) {
    console.error('[main] Failed to initialize board:', err);
    if (loadingEl) {
      loadingEl.textContent = `Failed to load board: ${err.message}. Please refresh.`;
      loadingEl.style.color = '#ff8f73';
    }
  }
}

init();
