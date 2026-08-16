// Manages SSE connections and broadcasts events to all connected clients.

const clients = new Set();

export function addClient(res) {
  clients.add(res);
  res.on("close", () => {
    clients.delete(res);
  });
}

export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

export function getClientCount() {
  return clients.size;
}
