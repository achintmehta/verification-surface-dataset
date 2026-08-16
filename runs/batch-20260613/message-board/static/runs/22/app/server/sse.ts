import type { Response } from "express";
import crypto from "node:crypto";
import type { Message } from "../shared/types.js";

/**
 * Represents a single SSE client connection.
 */
interface SSEClient {
  id: string;
  res: Response;
}

/** All currently-connected SSE clients. */
const clients: Map<string, SSEClient> = new Map();

/**
 * Registers a new SSE client. Sets the appropriate headers, sends an initial
 * `connected` event, and removes the client when the connection closes.
 *
 * @returns The unique client id.
 */
export function addClient(res: Response): string {
  const clientId = crypto.randomUUID();

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Send an initial event so the client knows it's connected
  res.write(`event: connected\ndata: ${JSON.stringify({ clientId })}\n\n`);

  const client: SSEClient = { id: clientId, res };
  clients.set(clientId, client);

  // Clean up on disconnect
  res.on("close", () => {
    clients.delete(clientId);
    console.log(`[sse] client ${clientId} disconnected – ${clients.size} active`);
  });

  console.log(`[sse] client ${clientId} connected – ${clients.size} active`);
  return clientId;
}

/**
 * Broadcasts a new message to every connected SSE client.
 */
export function broadcastMessage(message: Message): void {
  const payload = `event: new-message\ndata: ${JSON.stringify(message)}\n\n`;

  for (const client of clients.values()) {
    client.res.write(payload);
  }
}

/**
 * Returns the number of currently connected clients, useful for health checks.
 */
export function clientCount(): number {
  return clients.size;
}
