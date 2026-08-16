// Central configuration for the seat-booking backend.

export const config = {
  // HTTP port for the Express API + SSE server.
  port: Number(process.env.PORT) || 3001,

  // Directory on local disk where PGLite persists its data.
  dataDir: process.env.PGLITE_DIR || './pgdata',

  // Seat map dimensions. The map is fixed for the single event.
  rows: Number(process.env.SEAT_ROWS) || 5,
  seatsPerRow: Number(process.env.SEAT_PER_ROW) || 10,

  // Hold time-to-live in milliseconds. After this elapses a hold is
  // considered released and its seats become available again.
  holdTtlMs: Number(process.env.HOLD_TTL_MS) || 120000, // 2 minutes

  // How often the background sweep runs to release stale holds.
  sweepIntervalMs: Number(process.env.SWEEP_INTERVAL_MS) || 5000,
};

// Row labels A, B, C, ... derived from row count.
export function rowLabel(index) {
  // Supports more than 26 rows by falling back to AA, AB, ... if needed,
  // but for the default 5 rows simple single letters suffice.
  let label = '';
  let n = index;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}
