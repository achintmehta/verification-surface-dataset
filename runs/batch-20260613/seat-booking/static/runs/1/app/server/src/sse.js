/**
 * Server-Sent Events (SSE) broadcaster.
 *
 * Maintains a set of active Response objects and pushes seat-status
 * change events to all of them.  The module is intentionally stateless
 * beyond the client set so it can be imported anywhere without circular
 * dependency issues.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

/**
 * Express middleware that upgrades the connection to an SSE stream.
 * Keeps the socket alive with a heartbeat every 15 s.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
export function sseHandler(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  // Send an initial "connected" event so the client knows the stream is live.
  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  clients.add(res);
  console.log(`[sse] Client connected. Total: ${clients.size}`);

  // Heartbeat – prevents proxies from closing idle connections.
  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 15_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    console.log(`[sse] Client disconnected. Total: ${clients.size}`);
  });
}

/**
 * Broadcast a seat-status update to every connected client.
 *
 * @param {'held'|'booked'|'released'} eventType
 * @param {Array<{id:string, status:string, holdId?:string|null, bookedBy?:string|null, holdExpiresAt?:string|null}>} seats
 */
export function broadcast(eventType, seats) {
  if (clients.size === 0) return;

  const payload = JSON.stringify({ type: eventType, seats });
  const message = `event: seat-update\ndata: ${payload}\n\n`;

  for (const client of clients) {
    try {
      client.write(message);
    } catch {
      // If writing fails the 'close' handler will clean up.
    }
  }
}
