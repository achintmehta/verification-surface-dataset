/**
 * routes/stream.js – GET /api/stream
 *
 * Opens a persistent Server-Sent Events connection for the requesting client.
 * The connection is kept alive until the client disconnects.
 */

import { Router }    from 'express';
import { addClient } from '../sse.js';

const router = Router();

router.get('/', (req, res) => {
  addClient(req, res);
});

export default router;
