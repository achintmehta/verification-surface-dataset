// Central configuration for the seat-booking backend.
export const config = {
  port: Number(process.env.PORT) || 3001,
  // PGLite persists to this directory on local disk.
  dbDir: process.env.DB_DIR || './pgdata',
  // Seat map dimensions.
  rows: Number(process.env.ROWS) || 5,
  seatsPerRow: Number(process.env.SEATS_PER_ROW) || 10,
  // Hold time-to-live in milliseconds.
  holdTtlMs: Number(process.env.HOLD_TTL_MS) || 60_000,
  // Frequency of the background sweep that releases expired holds.
  sweepIntervalMs: Number(process.env.SWEEP_INTERVAL_MS) || 5_000,
};

// Row labels A, B, C, ... derived from the configured number of rows.
export function rowLabels(count) {
  const labels = [];
  for (let i = 0; i < count; i++) {
    labels.push(String.fromCharCode(65 + i));
  }
  return labels;
}
