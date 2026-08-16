// Central configuration for the backend.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PORT = Number(process.env.PORT) || 3001;

// Directory where PGLite persists its data on the local file system.
// Persisting to disk lets us skip reseeding on subsequent boots.
export const DATA_DIR = process.env.PGLITE_DATA_DIR
  ? path.resolve(process.env.PGLITE_DATA_DIR)
  : path.resolve(__dirname, '..', '.pgdata');

// Total number of rows in the deterministic seed corpus.
export const SEED_ROW_COUNT = Number(process.env.SEED_ROW_COUNT) || 100000;

// Rows inserted per batch during seeding.
export const SEED_BATCH_SIZE = 2000;

// Maximum number of rows any single API response may contain.
export const MAX_LIMIT = 200;

// Valid severity values.
export const SEVERITIES = ['debug', 'info', 'warn', 'error'];

// Corpus spans this many days ending "now" (fixed epoch for determinism).
export const CORPUS_DAYS = 30;

// Fixed end timestamp so the seed is fully deterministic across boots.
// 2024-01-31T00:00:00.000Z
export const CORPUS_END_MS = Date.UTC(2024, 0, 31, 0, 0, 0, 0);

// Service names used in the corpus.
export const SERVICES = [
  'auth-service',
  'payment-gateway',
  'inventory',
  'search-indexer',
  'notification',
  'user-profile',
  'api-gateway',
  'analytics',
];
