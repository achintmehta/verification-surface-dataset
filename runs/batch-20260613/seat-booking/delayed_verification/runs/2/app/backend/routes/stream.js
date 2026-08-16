/**
 * GET /api/stream
 *
 * Server-Sent Events endpoint.  Clients connect here and receive real-time
 * seat-status transitions as `seat_update` events.
 */

import { Router } from 'express';
import { addClient } from '../sse.js';

const router = Router();

router.get('/', (req, res) => {
  addClient(req, res);
  // The connection stays open; addClient handles cleanup on close/error.
});

export default router;
