/**
 * sse.js – Server-Sent Events broadcast hub.
 *
 * Any part of the backend calls `broadcast(eventName, payload)` and every
 * connected SSE client receives the message immediately.
 */

// Set of active SSE response objects.
const clients = new Set();

/**
 * Express middleware that upgrades a GET /api/stream request into a
 * long-lived SSE connection.
 */
export function sseHandler(req, res) {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Send a comment every 25 s to keep the connection alive through proxies.
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25_000);

  clients.add(res);

  // Send a "connected" event so the client knows the stream is live.
  sendEvent(res, 'connected', { message: 'SSE stream connected' });

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

/**
 * Broadcast an SSE event to every connected client.
 *
 * @param {string} eventName  – the SSE `event:` field
 * @param {object} payload    – serialised as JSON in the `data:` field
 */
export function broadcast(eventName, payload) {
  const chunk = formatEvent(eventName, payload);
  for (const res of clients) {
    try {
      res.write(chunk);
    } catch {
      clients.delete(res);
    }
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function sendEvent(res, eventName, payload) {
  res.write(formatEvent(eventName, payload));
}

function formatEvent(eventName, payload) {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}
