// Central configuration for the seat-booking server.
export const PORT = Number(process.env.PORT || 3000);

// Where PGLite persists its data on the local file system.
export const DATA_DIR = process.env.DATA_DIR || './data/pgdata';

// Fixed seat map dimensions.
export const NUM_ROWS = Number(process.env.NUM_ROWS || 5);
export const SEATS_PER_ROW = Number(process.env.SEATS_PER_ROW || 10);

// Hold TTL in milliseconds (how long a temporary hold survives).
export const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS || 60_000);

// How often the background sweep runs to release expired holds.
export const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS || 5_000);
