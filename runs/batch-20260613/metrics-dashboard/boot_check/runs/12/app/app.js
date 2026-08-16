// Alternate root entry shim: boots the backend server.
import('./server/index.js').catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
