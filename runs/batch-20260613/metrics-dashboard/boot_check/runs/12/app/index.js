// Root entry shim: boots the backend server.
// Uses dynamic import so it works whether treated as CJS or ESM.
import('./server/index.js').catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
