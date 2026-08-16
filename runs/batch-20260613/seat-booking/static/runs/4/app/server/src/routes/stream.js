/**
 * GET /api/stream
 *
 * Server-Sent Events endpoint.  Registers the response with the SSE module
 * and keeps the connection open until the client disconnects.
 */

import { Router } from 'express';
import { addClient } from '../sse.js';

const router = Router();

router.get('/', (req, res) => {
  addClient(req, res);
  // The connection is kept alive by the SSE module; no further action needed.
});

export default router;
