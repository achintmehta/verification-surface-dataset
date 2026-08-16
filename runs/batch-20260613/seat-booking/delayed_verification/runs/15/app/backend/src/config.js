// Central configuration for the seat-booking backend.

export const PORT = Number(process.env.PORT || 3001);

// Where PGLite persists its data on local disk.
export const DATA_DIR = process.env.PGLITE_DIR || './pgdata';

// Seat map dimensions.
export const ROWS = Number(process.env.SEAT_ROWS || 5);
export const SEATS_PER_ROW = Number(process.env.SEATS_PER_ROW || 10);

// Hold time-to-live in milliseconds.
export const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS || 120_000);

// Interval for the periodic sweep that releases stale holds.
export const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS || 5_000);

// Row labels A, B, C, ...
export function rowLabel(index) {
  // Supports more than 26 rows by wrapping (AA, AB, ...). Good enough here.
  let label = '';
  let n = index;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}
