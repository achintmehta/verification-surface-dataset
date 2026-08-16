// Central configuration for the seat-booking server.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  // HTTP port for the API + SSE server.
  port: Number(process.env.PORT) || 3001,

  // PGLite persists to this directory on local disk.
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', '.pgdata'),

  // Seat map dimensions (fixed map for a single event).
  rows: Number(process.env.ROWS) || 5,
  seatsPerRow: Number(process.env.SEATS_PER_ROW) || 10,

  // Hold time-to-live in milliseconds.
  holdTtlMs: Number(process.env.HOLD_TTL_MS) || 60_000,

  // How often the lazy sweep runs to release stale holds (ms).
  sweepIntervalMs: Number(process.env.SWEEP_INTERVAL_MS) || 5_000,
};

// Row labels: A, B, C, ... derived from the row count.
export function rowLabel(index) {
  // Supports more than 26 rows via AA, AB ... if ever needed.
  let label = '';
  let n = index;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}
