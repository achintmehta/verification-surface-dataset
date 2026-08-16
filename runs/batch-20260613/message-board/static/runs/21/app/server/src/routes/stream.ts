import { Router } from "express";
import type { Request, Response } from "express";
import { addClient } from "../sse.js";

const router = Router();

/**
 * GET /api/stream
 *
 * Opens a Server-Sent Events (SSE) connection. The server will push
 * `newMessage` events to this connection whenever a message is created.
 */
router.get("/", (req: Request, res: Response) => {
  // Disable any request timeout so the connection stays alive indefinitely
  req.socket.setTimeout(0);

  addClient(res);
});

export default router;
