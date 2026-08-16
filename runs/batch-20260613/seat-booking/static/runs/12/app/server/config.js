// Central configuration for the seat-booking server.
export const config = {
  // HTTP port the Express server listens on.
  port: Number(process.env.PORT) || 3001,

  // Directory where PGLite persists its data on local disk.
  dataDir: process.env.PGLITE_DIR || './server/data/pgdata',

  // Seat map dimensions.
  rows: Number(process.env.SEAT_ROWS) || 5,
  seatsPerRow: Number(process.env.SEATS_PER_ROW) || 10,

  // Hold time-to-live in milliseconds.
  holdTtlMs: Number(process.env.HOLD_TTL_MS) || 60_000,

  // How often the background sweep releases expired holds (milliseconds).
  sweepIntervalMs: Number(process.env.SWEEP_INTERVAL_MS) || 5_000,
};

// Row labels A, B, C, ... derived from the configured number of rows.
export function rowLabels(count) {
  const labels = [];
  for (let i = 0; i < count; i += 1) {
    // Supports more than 26 rows by wrapping (A..Z, then AA.. style is overkill
    // for this app, so we keep it simple with single letters for <= 26 rows).
    labels.push(String.fromCharCode(65 + (i % 26)));
  }
  return labels;
}
