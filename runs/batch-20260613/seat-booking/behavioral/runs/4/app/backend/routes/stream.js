import { Router } from "express";
import { addClient } from "../sse.js";

const router = Router();

/**
 * GET /api/stream
 * Establishes a Server-Sent Events connection.
 */
router.get("/", (req, res) => {
  // Disable response buffering (important for proxies / nginx)
  req.socket.setNoDelay(true);
  addClient(res);
  // The connection stays open; cleanup happens in addClient via 'close' event.
});

export default router;
