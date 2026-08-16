const clients = new Set();

export function addClient(res) {
  clients.add(res);
  
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  
  // Send initial ping
  res.write('data: {"type":"connected"}\n\n');

  res.on('close', () => {
    clients.delete(res);
  });
}

export function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch (e) {
      clients.delete(client);
    }
  }
}

export function getClientCount() {
  return clients.size;
}