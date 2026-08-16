// Centralized configuration for the seat-booking server.
export const PORT = process.env.PORT || 3000;

// Where PGLite persists its data on local disk.
export const DATA_DIR = process.env.PGLITE_DIR || './server/.pgdata';

// Fixed seat map dimensions.
export const ROWS = Number(process.env.SEAT_ROWS || 5);
export const SEATS_PER_ROW = Number(process.env.SEATS_PER_ROW || 10);

// Hold time-to-live in milliseconds (default 2 minutes).
export const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS || 2 * 60 * 1000);

// Periodic sweep interval for expiring stale holds.
export const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS || 5 * 1000);

// Row labels: A, B, C, ...
export function rowLabel(index) {
  return String.fromCharCode('A'.charCodeAt(0) + index);
}
