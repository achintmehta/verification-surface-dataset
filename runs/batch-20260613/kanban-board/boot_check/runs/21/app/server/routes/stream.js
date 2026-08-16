const express = require('express');
const { addClient } = require('../broadcast');

const router = express.Router();

// GET /api/stream - SSE endpoint for real-time updates
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no'
  });

  // Send a comment to establish the connection
  res.write(':connected\n\n');

  // Send a heartbeat every 30 seconds to keep the connection alive
  const heartbeat = setInterval(() => {
    res.write(':heartbeat\n\n');
  }, 30000);

  // Register this client
  addClient(res);

  // Clean up on close
  req.on('close', () => {
    clearInterval(heartbeat);
  });
});

module.exports = router;
