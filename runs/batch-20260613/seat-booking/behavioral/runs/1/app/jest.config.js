export default {
  testEnvironment: 'node',
  transform: {},
  extensionsToTreatAsEsm: [],
  testMatch: ['**/tests/**/*.test.js'],
  // Each test file gets its own module registry so DB state doesn't leak
  resetModules: true,
  testTimeout: 30000,
};
