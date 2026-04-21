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

/**
 * Resolve the API key from the request — checks Bearer token first, then session cookie.
 * Returns { apiKey, user } or { apiKey: null, user: null }.
 */
function resolveApiKey(req) {
  // 1. Bearer token takes priority (API / programmatic access)
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    return { apiKey: authHeader.slice(7).trim(), user: null };
  }

  // 2. Session cookie (browser sign-in)
  const sessionToken = req.cookies && req.cookies.session;
  if (sessionToken) {
    const user = db.getUserBySessionToken(sessionToken);
    if (user && user.api_key) {
      return { apiKey: user.api_key, user };
    }
    if (user) {
      return { apiKey: null, user };
    }
  }

  return { apiKey: null, user: null };
}

/**
 * Renders a styled HTML upgrade page for gated features (PDF export, trial limits).
 */
function upgradePage({ title, heading, detail, upgradeUrl, ctaText }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} — OrbioLabs</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f4f6f9; color: #1a1a2e; min-height: 100vh; display: flex; flex-direction: column; }
    header { background: #1a1a2e; color: #fff; padding: 20px 32px; }
    header h1 { font-size: 1.2rem; font-weight: 700; }
    .upgrade-container { flex: 1; display: flex; align-items: center; justify-content: center; padding: 32px 16px; }
    .upgrade-card { background: #fff; border-radius: 12px; padding: 48px 40px; max-width: 520px; width: 100%; text-align: center; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
    .upgrade-icon { font-size: 3rem; margin-bottom: 20px; }
    .upgrade-card h2 { font-size: 1.5rem; font-weight: 700; color: #1a1a2e; margin-bottom: 12px; }
    .upgrade-card p { font-size: 1rem; color: #4a5568; line-height: 1.6; margin-bottom: 32px; }
    .btn-upgrade { display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; font-size: 1rem; font-weight: 600; padding: 14px 36px; border-radius: 8px; text-decoration: none; transition: transform 0.15s, box-shadow 0.15s; }
    .btn-upgrade:hover { transform: translateY(-1px); box-shadow: 0 4px 14px rgba(102,126,234,0.4); }
    .back-link { display: inline-block; margin-top: 20px; font-size: 0.85rem; color: #718096; text-decoration: none; }
    .back-link:hover { color: #4a5568; }
  </style>
</head>
<body>
  <header><h1>OrbioLabs</h1></header>
  <div class="upgrade-container">
    <div class="upgrade-card">
      <div class="upgrade-icon">\u{1F4C4}</div>
      <h2>${heading}</h2>
      <p>${detail}</p>
      <a href="${upgradeUrl}" class="btn-upgrade">${ctaText}</a>
      <br>
      <a href="javascript:history.back()" class="back-link">&larr; Go back</a>
    </div>
  </div>
</body>
</html>`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_DAYS = 14;

// ── Free-tier rate limiter for Tier 1 endpoints ────────────────────────────────
const freeTierLimiter = { counts: new Map() };
setInterval(() => {
  const cutoff = Date.now() - 3600000;
  for (const [ip, entry] of freeTierLimiter.counts) {
    if (entry.firstAt < cutoff) freeTierLimiter.counts.delete(ip);
  }
}, 600000);

const FREE_TIER_HOURLY_LIMIT = 5;

/**
 * Express middleware that allows free (unauthenticated) access to Tier 1 endpoints.
 * - If the user has a valid API key + active subscription, it behaves like
 *   requireActiveSubscription (attaches req.subscription, enforces limits).
 * - If the user has no API key or no active subscription, the request is still
 *   allowed but rate-limited by IP (5 requests/hour).
 * This enables Tier 1 features (site crawl, competitor benchmarking, full audit)
 * to be used without any paid plan.
 */
function allowFreeTier(req, res, next) {
  // Dev / test: skip all enforcement
  if (!process.env.STRIPE_SECRET_KEY) {
    return next();
  }

  const { apiKey } = resolveApiKey(req);

  // If user has a valid API key, try to attach subscription and enforce limits
  if (apiKey) {
    const sub = lookupSubscription(apiKey);
    if (sub && isActive(apiKey)) {
      // Trial limit enforcement
      if (sub.status === 'trialing') {
        const appUrl = process.env.APP_URL || '';
        const ageMs = Date.now() - sub.createdAt;
        if (ageMs > TRIAL_DAYS * DAY_MS) {
          // Trial expired — fall through to free-tier rate limiting
        } else if (sub.auditCount >= TRIAL_AUDIT_LIMIT) {
          // Trial audits exhausted — fall through to free-tier rate limiting
        } else {
          req.subscription = sub;
          return next();
        }
      } else {
        // Starter tier monthly limit
        if (sub.status === 'active' && sub.planTier === 'starter') {
          const plan = PLANS.starter;
          const monthlyCount = db.getMonthlyAuditCount(apiKey);
          if (monthlyCount >= plan.monthlyAudits) {
            // Monthly limit reached — fall through to free-tier rate limiting
          } else {
            req.subscription = sub;
            return next();
          }
        } else {
          req.subscription = sub;
          return next();
        }
      }
    }
    // Invalid/inactive subscription — fall through to free-tier rate limiting
  }

  // Free-tier path: rate-limit by IP
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = freeTierLimiter.counts.get(ip) || { count: 0, firstAt: now };
  if (now - entry.firstAt > 3600000) {
    entry.count = 0;
    entry.firstAt = now;
  }
  if (entry.count >= FREE_TIER_HOURLY_LIMIT) {
    return res.status(429).json({
      error: 'Free tier rate limit reached',
      detail: `Free usage is limited to ${FREE_TIER_HOURLY_LIMIT} requests per hour. Sign up for a plan for higher limits.`,
      trialUrl: (process.env.APP_URL || '') + '/billing/trial',
      subscribeUrl: (process.env.APP_URL || '') + '/billing/checkout',
    });
  }
  entry.count++;
  freeTierLimiter.counts.set(ip, entry);

  // No subscription attached — downstream handlers should handle null req.subscription
  req.subscription = null;
  next();
}

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

  const { apiKey, user } = resolveApiKey(req);

  if (!apiKey) {
    return res.status(401).json({
      error: 'Unauthorized',
      detail: 'Sign in at /signin or include your API key as: Authorization: Bearer <your-api-key>',
      signinUrl:    (process.env.APP_URL || '') + '/signin',
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
    const upgradeUrl = `${appUrl}/billing/checkout?tier=pro`;
    return res.status(402).send(upgradePage({
      title: 'PDF Export — Pro Feature',
      heading: 'PDF export is a Pro feature',
      detail: 'White-label PDF reports are available on the Pro plan. Upgrade to generate branded, downloadable reports for your clients.',
      upgradeUrl,
      ctaText: 'Upgrade to Pro',
    }));
  }

  if (sub.status === 'trialing' && sub.pdfCount >= TRIAL_PDF_LIMIT) {
    const appUrl = process.env.APP_URL || '';
    const upgradeUrl = `${appUrl}/billing/checkout`;
    return res.status(402).send(upgradePage({
      title: 'PDF Export Limit Reached',
      heading: 'Trial PDF limit reached',
      detail: `You\u2019ve used all ${TRIAL_PDF_LIMIT} trial PDF exports. Upgrade to a paid plan for unlimited PDF exports.`,
      upgradeUrl,
      ctaText: 'Upgrade Now',
    }));
  }

  next();
}

module.exports = { requireActiveSubscription, requirePdfAllowed, allowFreeTier, resolveApiKey };
