// Root entry point: boots the metrics dashboard API server.
//
// The full implementation lives in server/src/index.js, where the runtime
// dependencies (express, cors, @electric-sql/pglite) are installed under
// server/node_modules. Node resolves those modules relative to the importing
// file, so delegating here keeps a single source of truth for the server.
import './server/src/index.js';
