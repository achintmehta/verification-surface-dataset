/**
 * Test helpers: spin up a fresh in-memory PGLite instance for each test file.
 *
 * Because Jest runs each test file in its own module registry (resetModules: true),
 * importing this module gives a fresh copy of db.js each time.
 */

import { PGlite } from '@electric-sql/pglite';
import supertest from 'supertest';
import { initDb, setDb } from '../server/src/db.js';
import { createApp } from '../server/src/app.js';

export async function buildApp() {
  // Fresh in-memory DB for this test file's module registry
  const db = new PGlite();
  await db.waitReady;

  // Inject before initDb so it reuses this instance
  setDb(db);
  await initDb();

  const app = createApp();
  return { app, db };
}

export { supertest as request };
