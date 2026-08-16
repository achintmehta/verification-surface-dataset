// Central configuration constants for the backend.
export const PORT = Number(process.env.PORT) || 3001;

// Path where PGLite persists its data on the local filesystem.
export const DB_DIR = process.env.PGLITE_DIR || './pgdata';

// Corpus shape.
export const TOTAL_ROWS = 100_000;
export const SEED_BATCH_SIZE = 2_000;

// The 30-day window the corpus spans (deterministic, fixed anchor).
// Anchor is a fixed instant so seeds are reproducible across boots/machines.
export const CORPUS_END_MS = Date.parse('2024-06-01T00:00:00.000Z');
export const CORPUS_SPAN_DAYS = 30;

// Query API caps.
export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 100;

export const SEVERITIES = ['debug', 'info', 'warn', 'error'];

export const SERVICES = [
  'auth-service',
  'billing-service',
  'gateway',
  'inventory',
  'notifications',
  'orders',
  'search-indexer',
  'user-profile',
];
