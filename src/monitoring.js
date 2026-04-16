'use strict';

/**
 * monitoring.js — Error tracking (Sentry) initialisation.
 *
 * Set SENTRY_DSN in the environment to enable Sentry. If the variable is
 * absent the module is a no-op so the server starts cleanly in dev/CI.
 */

const Sentry = require('@sentry/node');

const SENTRY_DSN = process.env.SENTRY_DSN;

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    // Capture 100 % of transactions for performance monitoring
    tracesSampleRate: 1.0,
    // Add server-side request context to every event
    integrations: [
      Sentry.httpIntegration(),
      Sentry.expressIntegration(),
    ],
  });
  console.log('[monitoring] Sentry initialised (DSN configured)');
} else {
  console.log('[monitoring] SENTRY_DSN not set — error tracking disabled');
}

module.exports = Sentry;
