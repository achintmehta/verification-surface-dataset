import { fetchBoard } from './api.js';
import { setBoardState } from './state.js';
import { initRenderer } from './renderer.js';
import { connectSSE, setStatusCallback } from './sse-client.js';

async function init(): Promise<void> {
  // Set up status indicator
  const statusEl = document.getElementById('status')!;
  setStatusCallback((connected: boolean) => {
    statusEl.textContent = connected ? 'Connected' : 'Disconnected';
    statusEl.className = `status ${connected ? 'connected' : 'disconnected'}`;
  });

  // Initialize renderer (subscribes to state changes)
  initRenderer();

  // Connect to SSE for real-time updates
  connectSSE();

  // Load initial board state
  try {
    const board = await fetchBoard();
    setBoardState(board);
  } catch (err) {
    console.error('Failed to load board:', err);
  }
}

init();
