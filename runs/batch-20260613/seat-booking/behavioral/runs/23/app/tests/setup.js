import { app } from "../backend/server.js";
import { initDb, getDb } from "../backend/db.js";
import { stopPeriodicSweep } from "../backend/expiry.js";

let server;
let baseUrl;

export async function setupTestServer() {
  await initDb();
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://localhost:${port}`;
      resolve({ server, baseUrl });
    });
  });
}

export async function teardownTestServer() {
  stopPeriodicSweep();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
}

export async function resetDatabase() {
  const db = await getDb();
  await db.exec(`
    UPDATE seats SET status = 'available', hold_id = NULL, hold_expires_at = NULL, session_id = NULL, booked_by = NULL;
    DELETE FROM holds;
  `);
}

export function getBaseUrl() {
  return baseUrl;
}
