/**
 * sse.js – Server-Sent Events broadcast hub.
 *
 * Every seat status transition (available → held, held → booked, held →
 * available, etc.) is broadcast to all connected SSE clients so every open
 * seat map stays live without polling.
 *
 * Usage:
 *   import { sseRouter, broadcast } from './sse.js';
 *   app.use(sseRouter);
 *   broadcast([{ id, status, holdId, expiresAt, bookedBy }]);
 */

import { Router } from 'express';

// Set of active SSE response objects, keyed by a numeric client id.
const clients = new Map();
let nextClientId = 1;

export const sseRouter = Router();

/**
 * GET /api/stream
 *
 * Opens an SSE connection.  The client receives a `connected` event
 * immediately, then `seat-update` events whenever seat statuses change.
 */
sseRouter.get('/api/stream', (req, res) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  const clientId = nextClientId++;
  clients.set(clientId, res);
  console.log(`[sse] Client ${clientId} connected (total: ${clients.size})`);

  // Send an initial heartbeat so the client knows the stream is live.
  sendEvent(res, 'connected', { clientId });

  // Keep-alive ping every 20 s to prevent proxy timeouts.
  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(keepAlive);
    }
  }, 20_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(clientId);
    console.log(`[sse] Client ${clientId} disconnected (total: ${clients.size})`);
  });
});

/**
 * Broadcast an array of seat-update payloads to every connected client.
 *
 * @param {Array<{id: string, status: string, holdId?: string|null,
 *                holdExpiresAt?: string|null, bookedBy?: string|null}>} seats
 */
export function broadcast(seats) {
  if (!seats || seats.length === 0) return;

  const payload = JSON.stringify(seats);

  for (const [clientId, res] of clients) {
    try {
      sendEvent(res, 'seat-update', payload);
    } catch (err) {
      console.warn(`[sse] Failed to write to client ${clientId}:`, err.message);
      clients.delete(clientId);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write a single SSE event frame.
 *
 * @param {import('express').Response} res
 * @param {string} event  – event name
 * @param {string|object} data – will be JSON-stringified if not already a string
 */
function sendEvent(res, event, data) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  res.write(`event: ${event}\ndata: ${payload}\n\n`);
}
