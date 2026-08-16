// Central configuration for the log explorer backend.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const config = {
  // HTTP port for the API server.
  port: Number(process.env.PORT) || 3001,

  // On-disk location for the embedded PGLite database. Persisting to the file
  // system is what lets the corpus survive a full server restart without
  // reseeding.
  dbDir: process.env.DB_DIR || path.resolve(__dirname, '..', '.pgdata'),

  // Corpus shape.
  seed: {
    totalRows: 100_000,
    days: 30,
    services: [
      'auth-service',
      'payment-gateway',
      'user-profile',
      'search-index',
      'notification',
      'inventory',
      'api-gateway',
      'billing',
    ],
    // Roughly 60/25/10/5 distribution across debug/info/warn/error.
    // Expressed as cumulative thresholds over a deterministic 0..99 bucket.
    severityDistribution: [
      { level: 'debug', threshold: 60 }, // 0..59  -> 60%
      { level: 'info', threshold: 85 }, // 60..84 -> 25%
      { level: 'warn', threshold: 95 }, // 85..94 -> 10%
      { level: 'error', threshold: 100 }, // 95..99 -> 5%
    ],
    batchSize: 2_000,
  },

  // API query constraints.
  api: {
    maxLimit: 200,
    defaultLimit: 100,
  },
};

export const SEVERITIES = ['debug', 'info', 'warn', 'error'];
