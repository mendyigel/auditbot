'use strict';

/**
 * Auth middleware — validates API key and active subscription.
 *
 * Usage:
 *   app.post('/audit', requireActiveSubscription, handler)
 *
 * In dev mode (STRIPE_SECRET_KEY not set), all requests pass through.
 * In production, callers must send:
 *   Authorization: Bearer <api-key>
 */

const { lookupSubscription, isActive } = require('./billing');

/**
 * Express middleware that requires a valid API key with an active Stripe subscription.
 * Skip enforcement when STRIPE_SECRET_KEY is absent (local dev / CI).
 */
function requireActiveSubscription(req, res, next) {
  // Dev / test: skip billing enforcement if Stripe is not configured
  if (!process.env.STRIPE_SECRET_KEY) {
    return next();
  }

  const authHeader = req.headers['authorization'] || '';
  const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (!apiKey) {
    return res.status(401).json({
      error: 'Unauthorized',
      detail: 'Include your AuditBot API key as: Authorization: Bearer <your-api-key>',
      subscribe: (process.env.APP_URL || '') + '/billing/checkout',
    });
  }

  const sub = lookupSubscription(apiKey);
  if (!sub) {
    return res.status(401).json({
      error: 'Invalid API key',
      detail: 'This API key was not found. Subscribe at /billing/checkout to get a key.',
    });
  }

  if (!isActive(apiKey)) {
    return res.status(402).json({
      error: 'Subscription inactive',
      detail: `Your subscription status is "${sub.status}". Manage it at /billing/portal?key=${apiKey}`,
    });
  }

  // Attach subscription info for downstream handlers
  req.subscription = sub;
  next();
}

module.exports = { requireActiveSubscription };
