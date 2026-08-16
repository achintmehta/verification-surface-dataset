// Central configuration for the seat-booking server.
export const config = {
  port: Number(process.env.PORT) || 3001,

  // Where PGLite persists its data on local disk.
  dataDir: process.env.PGLITE_DIR || './pgdata',

  // Seat map dimensions.
  rows: Number(process.env.SEAT_ROWS) || 5,
  seatsPerRow: Number(process.env.SEATS_PER_ROW) || 10,

  // Hold time-to-live in milliseconds.
  holdTtlMs: Number(process.env.HOLD_TTL_MS) || 2 * 60 * 1000,

  // How often the background sweep releases expired holds.
  sweepIntervalMs: Number(process.env.SWEEP_INTERVAL_MS) || 5 * 1000,
};

// Row labels: A, B, C, ... (supports up to 26 rows).
export function rowLabel(index) {
  return String.fromCharCode(65 + index);
}
