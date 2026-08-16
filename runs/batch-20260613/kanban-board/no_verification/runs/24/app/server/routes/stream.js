const express = require("express");
const { addClient } = require("../sse");

const router = express.Router();

/**
 * GET /api/stream
 * Server-Sent Events endpoint. Keeps the connection open and pushes events.
 */
router.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Send an initial comment to flush headers / confirm connection
  res.write(":ok\n\n");

  // Send a heartbeat every 30 seconds to keep the connection alive
  const heartbeat = setInterval(() => {
    res.write(":heartbeat\n\n");
  }, 30000);

  req.on("close", () => {
    clearInterval(heartbeat);
  });

  addClient(res);
});

module.exports = router;
