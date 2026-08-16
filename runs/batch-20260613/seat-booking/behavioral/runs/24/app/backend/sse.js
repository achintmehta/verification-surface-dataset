// SSE connection manager – keeps track of all connected clients and
// broadcasts seat-status transitions to everyone.

const clients = new Set();

export function addClient(res) {
  clients.add(res);
  res.on("close", () => clients.delete(res));
}

export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

export function clientCount() {
  return clients.size;
}
