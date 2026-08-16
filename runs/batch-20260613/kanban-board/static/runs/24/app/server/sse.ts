import type { Response } from 'express';
import type { SSEEvent } from '../shared/types.js';

interface SSEClient {
  id: string;
  res: Response;
}

const clients: SSEClient[] = [];
let clientIdCounter = 0;

/**
 * Register a new SSE client connection.
 * Returns a cleanup function to call when the connection closes.
 */
export function addClient(res: Response): () => void {
  const id = String(++clientIdCounter);
  const client: SSEClient = { id, res };
  clients.push(client);

  // Send a heartbeat comment every 15 seconds to keep the connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      // Connection already closed
    }
  }, 15000);

  return () => {
    clearInterval(heartbeat);
    const index = clients.findIndex((c) => c.id === id);
    if (index !== -1) {
      clients.splice(index, 1);
    }
  };
}

/**
 * Broadcast an SSE event to all connected clients.
 */
export function broadcast(event: SSEEvent): void {
  const data = JSON.stringify(event);
  const message = `event: ${event.type}\ndata: ${data}\n\n`;

  for (let i = clients.length - 1; i >= 0; i--) {
    try {
      clients[i].res.write(message);
    } catch {
      // Remove dead connections
      clients.splice(i, 1);
    }
  }
}

/**
 * Get the number of currently connected clients.
 */
export function getClientCount(): number {
  return clients.length;
}
