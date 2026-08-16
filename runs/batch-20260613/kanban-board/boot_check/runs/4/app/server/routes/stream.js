import { Router } from 'express';
import { addClient } from '../sse.js';

const router = Router();

/**
 * GET /api/stream
 * Establishes a Server-Sent Events connection.
 */
router.get('/', (req, res) => {
  addClient(req, res);
});

export default router;
