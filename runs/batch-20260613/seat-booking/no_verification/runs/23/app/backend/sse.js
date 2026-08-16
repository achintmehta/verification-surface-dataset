/**
 * SSE (Server-Sent Events) connection manager.
 * Maintains a set of active response objects and broadcasts seat status changes.
 */

const clients = new Set();

function addClient(res) {
  clients.add(res);
  res.on("close", () => {
    clients.delete(res);
  });
}

/**
 * Broadcast a seat status change to all connected SSE clients.
 * @param {object|object[]} seatUpdates - one or more seat objects with at least { id, status }
 */
function broadcast(seatUpdates) {
  const data = JSON.stringify({
    type: "seat-update",
    seats: Array.isArray(seatUpdates) ? seatUpdates : [seatUpdates],
    timestamp: new Date().toISOString(),
  });

  for (const client of clients) {
    try {
      client.write(`data: ${data}\n\n`);
    } catch {
      clients.delete(client);
    }
  }
}

function clientCount() {
  return clients.size;
}

module.exports = { addClient, broadcast, clientCount };
