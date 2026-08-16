/**
 * @typedef {{
 *   seatId: number;
 *   rowLabel: string;
 *   seatNumber: number;
 *   status: "available" | "held" | "booked";
 *   holdId: string | null;
 *   holdExpiresAt: string | null;
 * }} SeatUpdate
 */

/**
 * @typedef {{ id: string; res: import('express').Response }} SSEClient
 */

/** @type {SSEClient[]} */
const clients = [];
let clientIdCounter = 0;

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function addClient(req, res) {
  const clientId = String(++clientIdCounter);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Send initial connected event
  res.write(`event: connected\ndata: ${JSON.stringify({ clientId })}\n\n`);

  /** @type {SSEClient} */
  const client = { id: clientId, res };
  clients.push(client);

  // Send keepalive every 15 seconds
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

/**
 * @param {SeatUpdate[]} updates
 */
export function broadcastSeatUpdates(updates) {
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

/** @returns {number} */
export function getClientCount() {
  return clients.length;
}
