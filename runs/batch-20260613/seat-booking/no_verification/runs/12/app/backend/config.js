import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// Hold time-to-live in milliseconds. Each hold expires this long after creation.
export const HOLD_TTL_MS = process.env.HOLD_TTL_MS
  ? Number(process.env.HOLD_TTL_MS)
  : 60_000;

// Periodic sweep interval to proactively release stale holds.
export const SWEEP_INTERVAL_MS = process.env.SWEEP_INTERVAL_MS
  ? Number(process.env.SWEEP_INTERVAL_MS)
  : 5_000;

// Fixed seat map dimensions.
export const ROWS = process.env.ROWS ? Number(process.env.ROWS) : 5;
export const SEATS_PER_ROW = process.env.SEATS_PER_ROW
  ? Number(process.env.SEATS_PER_ROW)
  : 10;

// Where PGLite persists its data on local disk.
export const DB_DIR = process.env.DB_DIR
  ? path.resolve(process.env.DB_DIR)
  : path.resolve(__dirname, '..', 'data', 'pgdata');
