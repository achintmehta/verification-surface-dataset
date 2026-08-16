// Server-Sent Events hub. Tracks connected clients and broadcasts seat
// status transitions so every seat map stays live.

const clients = new Set();

export function addClient(res) {
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

export function clientCount() {
  return clients.size;
}

/**
 * Broadcast a batch of seat changes to all connected clients.
 * @param {Array<{id,status,...}>} seats
 * @param {string} reason - held | booked | released | expired
 */
export function broadcast(seats, reason) {
  if (!seats || seats.length === 0) return;
  const payload = JSON.stringify({ type: 'seat-update', reason, seats });
  const frame = `event: seat-update\ndata: ${payload}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch (_) {
      clients.delete(res);
    }
  }
}
