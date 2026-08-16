import { PGlite } from '@electric-sql/pglite';
import { initSchema } from '../backend/db.js';
import { createApp } from '../backend/app.js';
import http from 'http';

/**
 * Create a test context with a fresh in-memory PGlite database and Express app.
 */
export async function createTestContext() {
  // Use in-memory PGlite for tests
  const db = new PGlite();
  await db.waitReady;
  await initSchema(db);

  const app = createApp(db);
  const server = http.createServer(app);

  // Start server on a random port
  await new Promise((resolve) => {
    server.listen(0, resolve);
  });
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  return {
    db,
    app,
    server,
    port,
    baseUrl,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await db.close();
    },
  };
}

/**
 * Helper to make API requests.
 */
export function api(baseUrl) {
  return {
    async getSeats() {
      const res = await fetch(`${baseUrl}/api/seats`);
      return { status: res.status, data: await res.json() };
    },

    async hold(seatIds, sessionId) {
      const res = await fetch(`${baseUrl}/api/holds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seatIds, sessionId }),
      });
      return { status: res.status, data: await res.json() };
    },

    async confirm(holdId) {
      const res = await fetch(`${baseUrl}/api/holds/${holdId}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      return { status: res.status, data: await res.json() };
    },

    async release(holdId) {
      const res = await fetch(`${baseUrl}/api/holds/${holdId}`, {
        method: 'DELETE',
      });
      return { status: res.status, data: await res.json() };
    },
  };
}
