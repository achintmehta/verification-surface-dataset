import { Request, Response } from "express";

export interface SeatUpdate {
  seatId: number;
  rowLabel: string;
  seatNumber: number;
  status: "available" | "held" | "booked";
  holdId: string | null;
  holdExpiresAt: string | null;
}

interface SSEClient {
  id: string;
  res: Response;
}

const clients: SSEClient[] = [];
let clientIdCounter = 0;

export function addClient(req: Request, res: Response): void {
  const clientId = String(++clientIdCounter);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  res.write(`event: connected\ndata: ${JSON.stringify({ clientId })}\n\n`);

  const client: SSEClient = { id: clientId, res };
  clients.push(client);

  const keepalive = setInterval(() => {
    res.write(":keepalive\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(keepalive);
    const index = clients.findIndex((c) => c.id === clientId);
    if (index !== -1) {
      clients.splice(index, 1);
    }
  });
}

export function broadcastSeatUpdates(updates: SeatUpdate[]): void {
  if (updates.length === 0) return;

  const data = JSON.stringify(updates);
  const message = `event: seat-updates\ndata: ${data}\n\n`;

  for (const client of clients) {
    try {
      client.res.write(message);
    } catch (_e) {
      // Client disconnected; will be cleaned up on 'close'
    }
  }
}

export function getClientCount(): number {
  return clients.length;
}
