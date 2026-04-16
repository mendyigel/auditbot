'use strict';

/**
 * Auth middleware — validates API key and active subscription.
 *
 * Usage:
 *   app.post('/audit', requireActiveSubscription, handler)
 *   app.get('/report/:id/pdf', requireActiveSubscription, requirePdfAllowed, handler)
 *
 * In dev mode (STRIPE_SECRET_KEY not set), all requests pass through.
 * In production, callers must send:
 *   Authorization: Bearer <api-key>
 */

const { lookupSubscription, isActive, TRIAL_AUDIT_LIMIT, TRIAL_PDF_LIMIT, PLANS } = require('./billing');
const db = require('./db');

const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_DAYS = 14;

/**
 * Express middleware that requires a valid API key with an active Stripe subscription.
 * For trialing subscriptions, enforces:
 *   - 10-audit limit
 *   - 14-day time limit (belt-and-suspenders alongside Stripe's own trial expiry)
 * For Starter tier, enforces:
 *   - 5-audit monthly limit
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
      detail: 'Include your OrbioLabs API key as: Authorization: Bearer <your-api-key>',
      trialUrl:    (process.env.APP_URL || '') + '/billing/trial',
      subscribeUrl: (process.env.APP_URL || '') + '/billing/checkout',
    });
  }

  const sub = lookupSubscription(apiKey);
  if (!sub) {
    return res.status(401).json({
      error: 'Invalid API key',
      detail: 'This API key was not found. Start a free trial at /billing/trial.',
    });
  }

  if (!isActive(apiKey)) {
    return res.status(402).json({
      error: 'Subscription inactive',
      detail: `Your subscription status is "${sub.status}". Manage it at /billing/portal?key=${apiKey}`,
      upgradeUrl: (process.env.APP_URL || '') + '/billing/checkout',
    });
  }

  // ── Trial limit enforcement ──────────────────────────────────────────────────
  if (sub.status === 'trialing') {
    const appUrl = process.env.APP_URL || '';

    // 14-day time limit (belt-and-suspenders; Stripe also enforces this)
    const ageMs = Date.now() - sub.createdAt;
    if (ageMs > TRIAL_DAYS * DAY_MS) {
      return res.status(402).json({
        error: 'Trial expired',
        detail: `Your ${TRIAL_DAYS}-day free trial has ended. Upgrade to continue running audits.`,
        upgradeUrl: `${appUrl}/billing/checkout`,
      });
    }

    // 10-audit limit
    if (sub.auditCount >= TRIAL_AUDIT_LIMIT) {
      return res.status(402).json({
        error: 'Trial audit limit reached',
        detail: `You've used all ${TRIAL_AUDIT_LIMIT} trial audits. Upgrade to run unlimited audits.`,
        auditsUsed:  sub.auditCount,
        auditsLimit: TRIAL_AUDIT_LIMIT,
        upgradeUrl: `${appUrl}/billing/checkout`,
      });
    }
  }

  // ── Starter tier monthly audit limit ─────────────────────────────────────────
  if (sub.status === 'active' && sub.planTier === 'starter') {
    const plan = PLANS.starter;
    const monthlyCount = db.getMonthlyAuditCount(apiKey);
    if (monthlyCount >= plan.monthlyAudits) {
      const appUrl = process.env.APP_URL || '';
      return res.status(402).json({
        error: 'Monthly audit limit reached',
        detail: `Your Starter plan includes ${plan.monthlyAudits} audits per month. Upgrade to Pro for unlimited audits.`,
        auditsUsed: monthlyCount,
        auditsLimit: plan.monthlyAudits,
        plan: 'starter',
        upgradeUrl: `${appUrl}/billing/checkout?tier=pro`,
      });
    }
  }

  // Attach subscription info for downstream handlers
  req.subscription = sub;
  next();
}

/**
 * Express middleware for PDF export routes.
 * Must come AFTER requireActiveSubscription (needs req.subscription).
 * For trialing subscriptions, enforces the 3-PDF-export trial limit.
 * For Starter tier, PDF export is not available.
 */
function requirePdfAllowed(req, res, next) {
  // Dev / test bypass
  if (!process.env.STRIPE_SECRET_KEY) return next();

  const sub = req.subscription;
  if (!sub) return next(); // should not happen if chained after requireActiveSubscription

  // Starter tier: no PDF export
  if (sub.planTier === 'starter') {
    const appUrl = process.env.APP_URL || '';
    return res.status(402).json({
      error: 'PDF export not available on Starter plan',
      detail: 'Upgrade to Pro for white-label PDF exports.',
      plan: 'starter',
      upgradeUrl: `${appUrl}/billing/checkout?tier=pro`,
    });
  }

  if (sub.status === 'trialing' && sub.pdfCount >= TRIAL_PDF_LIMIT) {
    const appUrl = process.env.APP_URL || '';
    return res.status(402).json({
      error: 'Trial PDF limit reached',
      detail: `You've used all ${TRIAL_PDF_LIMIT} trial PDF exports. Upgrade for unlimited exports.`,
      pdfsUsed:    sub.pdfCount,
      pdfsLimit:   TRIAL_PDF_LIMIT,
      upgradeUrl: `${appUrl}/billing/checkout`,
    });
  }

  next();
}

module.exports = { requireActiveSubscription, requirePdfAllowed };
