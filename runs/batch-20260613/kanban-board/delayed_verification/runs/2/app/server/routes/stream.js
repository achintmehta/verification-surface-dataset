/**
 * GET /api/stream
 *
 * Server-Sent Events endpoint. Registers the client and keeps the
 * connection alive. All broadcasts are handled by sse.js.
 */

import { Router } from 'express';
import { addClient } from '../sse.js';

const router = Router();

router.get('/', (req, res) => {
  addClient(req, res);
});

export default router;
