import type { Response } from "express";

/**
 * Manages active SSE connections and broadcasts events to all connected clients.
 */

interface SseClient {
  id: string;
  res: Response;
}

const clients: SseClient[] = [];
let clientIdCounter = 0;

export function addClient(res: Response): string {
  const id = String(++clientIdCounter);
  clients.push({ id, res });
  return id;
}

export function removeClient(id: string): void {
  const idx = clients.findIndex((c) => c.id === id);
  if (idx !== -1) {
    clients.splice(idx, 1);
  }
}

export function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.res.write(payload);
    } catch {
      // Client may have disconnected; ignore write errors
    }
  }
}

export function getClientCount(): number {
  return clients.length;
}
