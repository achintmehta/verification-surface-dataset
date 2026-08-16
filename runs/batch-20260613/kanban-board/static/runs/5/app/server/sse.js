/**
 * SSE (Server-Sent Events) connection manager.
 *
 * Keeps a registry of all active SSE response objects and provides a
 * `broadcast` helper that serialises an event payload and sends it to every
 * connected client.
 *
 * Event envelope:
 *   { type: 'card:created' | 'card:moved' | 'column:renormed', payload: … }
 */

// Map<id, res> – one entry per connected client.
const clients = new Map();
let _nextId = 1;

/**
 * Register a new SSE client.
 *
 * Sets the required SSE headers, sends an initial `connected` event so the
 * browser's EventSource knows the stream is live, and removes the client from
 * the registry when the connection closes.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
export function addClient(req, res) {
  const id = _nextId++;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Disable response buffering in Express / Node so events are flushed
  // immediately.
  res.flushHeaders();

  // Send a heartbeat comment every 25 s to keep the connection alive through
  // proxies that close idle connections.
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25_000);

  clients.set(id, res);

  // Send an initial event so the client knows it is connected.
  sendEvent(res, 'connected', { clientId: id });

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(id);
  });
}

/**
 * Broadcast an event to every connected SSE client.
 *
 * @param {string} type    – event name (e.g. 'card:created')
 * @param {object} payload – arbitrary JSON-serialisable data
 */
export function broadcast(type, payload) {
  const data = JSON.stringify({ type, payload });
  for (const res of clients.values()) {
    res.write(`data: ${data}\n\n`);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sendEvent(res, type, payload) {
  const data = JSON.stringify({ type, payload });
  res.write(`data: ${data}\n\n`);
}
