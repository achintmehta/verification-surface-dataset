// Central configuration for the seat-booking server.
export const config = {
  port: Number(process.env.PORT) || 3001,
  // Directory PGLite persists data to.
  dbDir: process.env.DB_DIR || './pgdata',
  // Seat map dimensions.
  rows: Number(process.env.SEAT_ROWS) || 5,
  seatsPerRow: Number(process.env.SEAT_COLS) || 10,
  // Hold time-to-live in milliseconds.
  holdTtlMs: Number(process.env.HOLD_TTL_MS) || 60_000,
  // How often the background sweep runs (ms).
  sweepIntervalMs: Number(process.env.SWEEP_INTERVAL_MS) || 5_000,
};

// Row labels A, B, C, ...
export function rowLabel(index) {
  return String.fromCharCode(65 + index);
}
