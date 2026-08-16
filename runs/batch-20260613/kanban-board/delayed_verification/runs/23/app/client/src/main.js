import { setState } from './store.js';
import { fetchBoard } from './api.js';
import { connectSSE } from './sse.js';
import { initRenderer } from './render.js';

async function init() {
  try {
    // Load initial board state
    const data = await fetchBoard();
    setState(data);

    // Start rendering
    initRenderer();

    // Connect to SSE for real-time updates
    connectSSE();
  } catch (err) {
    console.error('Failed to initialize app:', err);
    document.getElementById('board').innerHTML = `
      <div style="color: white; padding: 40px; text-align: center;">
        <h2>Failed to load board</h2>
        <p>Make sure the server is running on port 3000.</p>
        <button onclick="location.reload()" style="margin-top:16px; padding:8px 16px; cursor:pointer;">Retry</button>
      </div>
    `;
  }
}

init();
