// Simple Server-Sent Events broadcaster. Maintains a set of active client
// connections and pushes JSON-encoded events to all of them.

let nextId = 1;
const clients = new Map();

/**
 * Register a new SSE client. Returns a cleanup function to call on disconnect.
 */
export function addClient(res) {
  const id = nextId++;
  clients.set(id, res);

  // Send an initial comment to establish the stream and a hello event.
  res.write(': connected\n\n');
  send(res, 'hello', { clientId: id });

  return () => {
    clients.delete(id);
  };
}

function send(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Broadcast an event to every connected client.
 */
export function broadcast(event, data) {
  for (const res of clients.values()) {
    try {
      send(res, event, data);
    } catch {
      // Ignore broken pipes; the close handler will clean them up.
    }
  }
}

export function clientCount() {
  return clients.size;
}

// Periodic heartbeat keeps intermediaries from closing idle SSE connections.
setInterval(() => {
  for (const res of clients.values()) {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }
}, 25000).unref();
