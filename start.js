'use strict';
// Catch any startup crash and log it before exiting
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception during startup:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});
try {
  require('./src/server');
} catch (err) {
  console.error('[FATAL] Failed to load server:', err);
  process.exit(1);
}
