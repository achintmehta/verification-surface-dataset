import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PORT = Number(process.env.PORT ?? 3001);

// PGLite persists to this directory on the local file system so the corpus
// survives a full server restart without reseeding.
export const DATA_DIR = process.env.PGLITE_DIR
  ? path.resolve(process.env.PGLITE_DIR)
  : path.resolve(__dirname, '..', 'data', 'pgdata');

// Corpus shape.
export const TOTAL_ROWS = 100_000;
export const SEED_BATCH_SIZE = 5_000;
export const CORPUS_DAYS = 30;

export const SEVERITIES = ['debug', 'info', 'warn', 'error'];

export const SERVICES = [
  'auth-service',
  'payment-gateway',
  'user-api',
  'search-indexer',
  'notification-worker',
  'image-resizer',
  'billing-cron',
  'edge-proxy',
];

// Rough severity distribution: 60/25/10/5 (debug/info/warn/error).
// Expressed as cumulative thresholds over a deterministic 0..999 bucket.
export const SEVERITY_WEIGHTS = [
  { severity: 'debug', threshold: 600 },
  { severity: 'info', threshold: 850 },
  { severity: 'warn', threshold: 950 },
  { severity: 'error', threshold: 1000 },
];

// API limits.
export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 100;
