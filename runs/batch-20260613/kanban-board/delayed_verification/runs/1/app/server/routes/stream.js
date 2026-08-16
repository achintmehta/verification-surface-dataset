import { Router } from 'express';
import { addClient } from '../sse.js';

const router = Router();

/**
 * GET /api/stream
 * Opens a Server-Sent Events connection.  The client will receive:
 *   - event: card-created  data: { card }
 *   - event: card-moved    data: { card }
 *   - event: column-reorder data: { columnId, cards }
 */
router.get('/', (req, res) => {
  addClient(req, res);
  // addClient keeps the connection alive; no further action needed here.
});

export default router;
