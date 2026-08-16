import type { Response } from "express";
import type { MessageRow } from "./db.js";

/**
 * Manages a set of active SSE client connections and provides
 * helpers to broadcast messages to every connected client.
 */

const clients: Set<Response> = new Set();

/**
 * Register an Express response object as an active SSE client.
 * Sets the appropriate headers and keeps the connection alive.
 */
export function addClient(res: Response): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Send an initial comment to flush headers / confirm the connection
  res.write(": connected\n\n");

  clients.add(res);

  res.on("close", () => {
    clients.delete(res);
  });
}

/**
 * Broadcast a new message to every connected SSE client.
 * Each message is sent as a `newMessage` event containing JSON data.
 */
export function broadcast(message: MessageRow): void {
  const payload = `event: newMessage\ndata: ${JSON.stringify(message)}\n\n`;

  for (const client of clients) {
    client.write(payload);
  }
}

/**
 * Returns the current number of active SSE connections.
 */
export function getClientCount(): number {
  return clients.size;
}
