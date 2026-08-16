// Central configuration for the seat-booking server.
export const config = {
  port: Number(process.env.PORT || 3001),

  // Where PGLite persists its data on local disk.
  dataDir: process.env.PGLITE_DIR || './server/data/pgdata',

  // Seat map dimensions (fixed for the single event).
  rows: Number(process.env.SEAT_ROWS || 5),
  seatsPerRow: Number(process.env.SEAT_COLS || 10),

  // Hold time-to-live in milliseconds.
  holdTtlMs: Number(process.env.HOLD_TTL_MS || 60_000),

  // How often the background sweep runs to release stale holds.
  sweepIntervalMs: Number(process.env.SWEEP_INTERVAL_MS || 5_000)
};

// Row labels A, B, C, ...
export function rowLabel(index) {
  let label = '';
  let n = index;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}
