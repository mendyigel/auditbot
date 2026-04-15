'use strict';

// Initialise Sentry before anything else so all errors are captured.
const Sentry = require('./monitoring');

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { auditUrl } = require('./auditor');
const { generateHtml } = require('./report');
const { generatePdf } = require('./pdf');
const {
  createCheckoutSession,
  createTrialCheckoutSession,
  handleWebhook,
  createPortalSession,
  lookupSubscription,
  getTrialInfo,
  TRIAL_AUDIT_LIMIT,
  TRIAL_PDF_LIMIT,
} = require('./billing');
const { requireActiveSubscription, requirePdfAllowed } = require('./auth');
const db = require('./db');
const { saveReport, getReport, deleteReport, USE_S3 } = require('./storage');
const { generateLandingPage } = require('./landing');
const { consentBannerSnippet } = require('./consent-banner');
const { appPageAnalyticsSnippet, trackServerEvent } = require('./analytics');
const emailService = require('./email');

const app = express();
const PORT = process.env.PORT || 3000;

// Report TTL — default 30 days; set REPORT_TTL_DAYS env var to override
const REPORT_TTL_MS = (parseInt(process.env.REPORT_TTL_DAYS, 10) || 30) * 24 * 60 * 60 * 1000;

// Stripe webhooks require raw body — mount before express.json()
app.use('/billing/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// Prune old report metadata (and orphaned files) daily
setInterval(() => {
  db.pruneOldReports(REPORT_TTL_MS);
}, 24 * 60 * 60 * 1000);

// ── Trial email scheduler ──────────────────────────────────────────────────────
// Checks daily for subscriptions that need day-3, day-10, day-13, or day-14
// lifecycle emails based on how long since they subscribed.

const DAY_MS = 24 * 60 * 60 * 1000;

async function runTrialEmailSchedule() {
  const now = Date.now();
  // Fetch all active/trialing subs created more than 2 days ago (earliest possible trigger)
  const subs = db.getSubscriptionsForTrialEmails(now - 2 * DAY_MS);

  for (const sub of subs) {
    const ageMs  = now - sub.createdAt;
    const ageDays = ageMs / DAY_MS;
    const sent   = sub.emailsSent || {};

    try {
      // Day 3: tips email — only if no audits run yet
      if (ageDays >= 3 && ageDays < 4 && !sent.day3) {
        if (sub.auditCount === 0) {
          await emailService.sendTrialDay3(sub.email);
        }
        db.markEmailSent(sub.apiKey, 'day3');
      }

      // Day 10: 4-days-left warning
      if (ageDays >= 10 && ageDays < 11 && !sent.day10) {
        await emailService.sendTrialDay10(sub.email);
        db.markEmailSent(sub.apiKey, 'day10');
      }

      // Day 13: final warning
      if (ageDays >= 13 && ageDays < 14 && !sent.day13) {
        await emailService.sendTrialDay13(sub.email);
        db.markEmailSent(sub.apiKey, 'day13');
      }

      // Day 14: trial expired (only send if still active — paid subs skip this)
      if (ageDays >= 14 && ageDays < 15 && !sent.day14) {
        if (sub.status !== 'active') {
          await emailService.sendTrialExpired(sub.email);
        }
        db.markEmailSent(sub.apiKey, 'day14');
      }
    } catch (err) {
      console.error(`[email scheduler] Error for ${sub.email}:`, err.message);
    }
  }
}

// Run once at startup (catches any missed sends), then daily
runTrialEmailSchedule().catch((err) => console.error('[email scheduler] startup run failed:', err.message));
setInterval(() => {
  runTrialEmailSchedule().catch((err) => console.error('[email scheduler] daily run failed:', err.message));
}, DAY_MS);

console.log(`[storage] Using ${USE_S3 ? 'S3 (bucket: ' + process.env.S3_BUCKET + ')' : 'local filesystem'} for report storage`);

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /
 * orbiolabs.com landing page with email waitlist capture
 */
app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(generateLandingPage());
});

/**
 * POST /waitlist
 * Email capture for early-access waitlist.
 * Body: { email: string }
 * Stores the email in the DB; a future drip campaign can be wired to it.
 */
app.post('/waitlist', express.json(), (req, res) => {
  const { email } = req.body || {};
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  const trimmed = email.trim().toLowerCase();
  db.saveWaitlistEmail(trimmed);
  console.log(`[waitlist] Signup: ${trimmed}`);
  return res.json({ ok: true });
});

/**
 * GET /api
 * JSON API descriptor (replaces the old root JSON response)
 */
app.get('/api', (_req, res) => {
  res.json({
    service: 'AuditBot',
    version: '1.0.0',
    description: 'Automated SEO, performance & accessibility audits with shareable HTML reports',
    endpoints: {
      'POST /audit': 'Run an audit (requires API key). Body: { url, format? } — format: json|html|pdf',
      'GET /audit?url=…': 'Browser-friendly audit (requires API key)',
      'GET /report/:id': 'View a cached HTML report by ID',
      'GET /report/:id/pdf': 'Download white-label PDF report (optional ?agency=Name&agencyUrl=…)',
      'GET /health': 'Health check',
      'POST /billing/trial': 'Start a 14-day free trial — returns { url } to Stripe checkout (CC required, not charged until trial ends)',
      'GET /trial/status?key=…': 'Get trial usage: audits used, PDF exports used, days left',
      'POST /billing/checkout': 'Subscribe at $29/month — returns { url } to Stripe checkout',
      'POST /billing/portal': 'Manage your subscription — Body: { apiKey }',
      'POST /billing/webhook': 'Stripe webhook endpoint (internal)',
    },
    pricing: '14-day free trial (CC required) · then $29/month · Cancel anytime',
    billingEnabled: !!process.env.STRIPE_SECRET_KEY,
  });
});

/**
 * GET /health
 * Returns 200 + JSON when all systems are operational.
 * Returns 503 + JSON when a critical dependency is unhealthy.
 * Monitored by UptimeRobot at 1-minute intervals.
 */
app.get('/health', (_req, res) => {
  const checks = {};
  let allOk = true;

  // Database liveness: a cheap ping query
  try {
    db.ping();
    checks.database = 'ok';
  } catch (err) {
    checks.database = 'error';
    allOk = false;
  }

  // Storage mode (informational — not a failure condition)
  checks.storage = USE_S3 ? 's3' : 'local';

  // Billing enabled (informational)
  checks.billing = !!process.env.STRIPE_SECRET_KEY ? 'enabled' : 'disabled';

  const payload = {
    status: allOk ? 'ok' : 'degraded',
    version: '1.0.0',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    checks,
  };

  res.status(allOk ? 200 : 503).json(payload);
});

// ── Billing routes ────────────────────────────────────────────────────────────

/**
 * POST /billing/checkout
 * Body: { email? }
 * Returns { url } — redirect the user's browser to this Stripe Checkout URL.
 * After payment, Stripe redirects to APP_URL/billing/success?session_id=…
 */
app.post('/billing/checkout', async (req, res) => {
  try {
    const { email } = req.body || {};
    const base = process.env.APP_URL || `http://localhost:${PORT}`;
    const { url, sessionId } = await createCheckoutSession({
      email: email || undefined,
      successUrl: `${base}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/billing/cancel`,
    });
    return res.json({ url, sessionId });
  } catch (err) {
    console.error('[billing/checkout error]', err);
    return res.status(500).json({ error: 'Could not create checkout session', detail: err.message });
  }
});

/**
 * POST /billing/trial
 * Body: { email? }
 * Starts a 14-day free trial — requires CC via Stripe Checkout (not charged until trial ends).
 * Returns { url, sessionId } — redirect the browser to Stripe.
 */
app.post('/billing/trial', async (req, res) => {
  try {
    const { email } = req.body || {};
    const base = process.env.APP_URL || `http://localhost:${PORT}`;
    const { url, sessionId } = await createTrialCheckoutSession({
      email: email || undefined,
      successUrl: `${base}/billing/trial/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl:  `${base}/billing/cancel`,
    });
    return res.json({ url, sessionId });
  } catch (err) {
    console.error('[billing/trial error]', err);
    return res.status(500).json({ error: 'Could not create trial session', detail: err.message });
  }
});

/**
 * GET /billing/trial/success
 * Landing page after a trial is started via Stripe Checkout.
 */
app.get('/billing/trial/success', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>AuditBot — Trial Started</title>
<style>body{font-family:system-ui,sans-serif;max-width:600px;margin:80px auto;padding:0 24px;color:#111}
h1{color:#16a34a}code{background:#f4f4f5;padding:4px 8px;border-radius:4px;font-size:1.1em}
.trial-info{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:20px;margin:24px 0;}
.trial-info ul{margin:8px 0 0 0;padding-left:20px;color:#15803d}</style>
</head>
<body>
<h1>Your free trial is active!</h1>
<div class="trial-info">
  <strong>14-day free trial — no charge today</strong>
  <ul>
    <li>Up to 10 audits</li>
    <li>Up to 3 PDF exports</li>
    <li>Full SEO, performance &amp; accessibility checks</li>
  </ul>
</div>
<p>Your API key will be sent to your email once the webhook confirms. Check your inbox.</p>
<p>You won't be charged until your trial ends. Cancel anytime before then at no cost.</p>
<p><a href="/">Back to AuditBot</a></p>
${appPageAnalyticsSnippet('billing/trial/success')}
${consentBannerSnippet()}
</body></html>`);
});

/**
 * GET /trial/status?key=<api-key>
 * Returns trial usage info (audits used/limit, PDFs used/limit, days left).
 * Works for trialing subscriptions only; returns null fields for paid.
 */
app.get('/trial/status', (req, res) => {
  const apiKey = req.query.key;
  if (!apiKey) return res.status(400).json({ error: 'Missing query param: key' });

  const sub = lookupSubscription(apiKey);
  if (!sub) return res.status(404).json({ error: 'API key not found' });

  if (sub.status !== 'trialing') {
    return res.json({
      status: sub.status,
      trial: null,
    });
  }

  const trial = getTrialInfo(sub);
  const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;

  return res.json({
    status: sub.status,
    trial: {
      auditsUsed:   trial.auditsUsed,
      auditsLimit:  TRIAL_AUDIT_LIMIT,
      auditsLeft:   Math.max(0, TRIAL_AUDIT_LIMIT - trial.auditsUsed),
      pdfsUsed:     trial.pdfsUsed,
      pdfsLimit:    TRIAL_PDF_LIMIT,
      pdfsLeft:     Math.max(0, TRIAL_PDF_LIMIT - trial.pdfsUsed),
      daysLeft:     trial.daysLeft,
      upgradeUrl:   `${appUrl}/billing/checkout`,
      softWarning:  trial.auditsUsed >= TRIAL_AUDIT_LIMIT - 2, // warn at 8/10
    },
  });
});

/**
 * GET /billing/success
 * Landing page after successful Stripe checkout.
 * Retrieves (or creates) the API key for the new customer and displays it.
 */
app.get('/billing/success', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>AuditBot — Subscription Active</title>
<style>body{font-family:system-ui,sans-serif;max-width:600px;margin:80px auto;padding:0 24px;color:#111}
h1{color:#16a34a}code{background:#f4f4f5;padding:4px 8px;border-radius:4px;font-size:1.1em}</style>
</head>
<body>
<h1>You're all set!</h1>
<p>Your subscription is active. Your API key will be sent to your email once the webhook confirms payment.</p>
<p>If you need your key immediately, check your inbox or contact support.</p>
<p><a href="/">Back to AuditBot</a></p>
${appPageAnalyticsSnippet('billing/success')}
${consentBannerSnippet()}
</body></html>`);
});

/**
 * GET /billing/cancel
 * Landing page when user cancels the Stripe checkout.
 */
app.get('/billing/cancel', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>AuditBot — Checkout Cancelled</title>
<style>body{font-family:system-ui,sans-serif;max-width:600px;margin:80px auto;padding:0 24px;color:#111}</style>
</head>
<body>
<h1>Checkout cancelled</h1>
<p>No charge was made. <a href="/billing/checkout">Try again</a> when you're ready.</p>
${appPageAnalyticsSnippet('billing/cancel')}
${consentBannerSnippet()}
</body></html>`);
});

/**
 * POST /billing/portal
 * Body: { apiKey }
 * Returns { url } — Stripe Customer Portal for managing subscription / payment method.
 */
app.post('/billing/portal', async (req, res) => {
  const { apiKey } = req.body || {};
  if (!apiKey) {
    return res.status(400).json({ error: 'Missing required field: apiKey' });
  }
  const sub = lookupSubscription(apiKey);
  if (!sub) {
    return res.status(404).json({ error: 'API key not found' });
  }
  try {
    const base = process.env.APP_URL || `http://localhost:${PORT}`;
    const { url } = await createPortalSession({
      customerId: sub.customerId,
      returnUrl: `${base}/`,
    });
    return res.json({ url });
  } catch (err) {
    console.error('[billing/portal error]', err);
    return res.status(500).json({ error: 'Could not create portal session', detail: err.message });
  }
});

/**
 * GET /billing/portal?key=…
 * Convenience GET redirect to the Stripe Customer Portal.
 */
app.get('/billing/portal', async (req, res) => {
  const apiKey = req.query.key;
  if (!apiKey) return res.status(400).json({ error: 'Missing query param: key' });
  const sub = lookupSubscription(apiKey);
  if (!sub) return res.status(404).json({ error: 'API key not found' });
  try {
    const base = process.env.APP_URL || `http://localhost:${PORT}`;
    const { url } = await createPortalSession({ customerId: sub.customerId, returnUrl: `${base}/` });
    return res.redirect(302, url);
  } catch (err) {
    return res.status(500).json({ error: 'Could not create portal session', detail: err.message });
  }
});

/**
 * POST /billing/webhook
 * Stripe webhook — receives subscription lifecycle events.
 * Body must be raw (mounted above express.json()).
 */
app.post('/billing/webhook', async (req, res) => {
  const signature = req.headers['stripe-signature'];
  if (!signature) {
    return res.status(400).json({ error: 'Missing stripe-signature header' });
  }
  try {
    await handleWebhook(req.body, signature);
    return res.json({ received: true });
  } catch (err) {
    console.error('[billing/webhook error]', err);
    return res.status(400).json({ error: err.message });
  }
});

// ── Audit routes (gated behind active subscription) ───────────────────────────

/**
 * POST /audit
 * Body: { url: string, format?: "json" | "html" }
 *
 * Returns JSON audit result by default. Pass format=html to get HTML directly.
 * The JSON result includes a reportUrl for the shareable HTML report.
 */
app.post('/audit', requireActiveSubscription, async (req, res) => {
  const { url, format = 'json' } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing required field: url' });
  }

  // Normalise URL
  let targetUrl = url.trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }

  try {
    const audit = await auditUrl(targetUrl);
    const html = generateHtml(audit);

    // Persist the HTML report and raw audit data
    const reportId = uuidv4();
    const storageKey = await saveReport(reportId, html);
    db.saveReportMeta({ id: reportId, url: targetUrl, storageKey, audit });

    // Track audit count for trial email triggers
    if (req.subscription?.apiKey) {
      db.incrementAuditCount(req.subscription.apiKey);
    }

    // Server-side analytics event
    trackServerEvent('audit_run', { format }, req).catch(() => {});

    const reportUrl = `/report/${reportId}`;

    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }

    if (format === 'pdf') {
      // Enforce trial PDF limit
      const sub = req.subscription;
      if (sub?.status === 'trialing' && sub.pdfCount >= TRIAL_PDF_LIMIT) {
        const appUrl = process.env.APP_URL || '';
        return res.status(402).json({
          error: 'Trial PDF limit reached',
          detail: `You've used all ${TRIAL_PDF_LIMIT} trial PDF exports. Upgrade for unlimited exports.`,
          pdfsUsed:   sub.pdfCount,
          pdfsLimit:  TRIAL_PDF_LIMIT,
          upgradeUrl: `${appUrl}/billing/checkout`,
        });
      }
      const { agency = '', agencyUrl = '' } = req.body || {};
      const pdfBuffer = await generatePdf(audit, { agencyName: agency, agencyUrl });
      const filename = `audit-${encodeURIComponent(targetUrl.replace(/https?:\/\//, ''))}.pdf`;
      if (sub?.apiKey) db.incrementPdfCount(sub.apiKey);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(pdfBuffer);
    }

    // Include trial usage info in JSON response so clients can render a progress bar
    const trialInfo = req.subscription ? getTrialInfo(req.subscription) : null;
    return res.json({ ...audit, reportUrl, pdfUrl: `${reportUrl}/pdf`, trial: trialInfo });
  } catch (err) {
    console.error('[audit error]', err);
    return res.status(500).json({ error: 'Audit failed', detail: err.message });
  }
});

/**
 * GET /report/:id
 * Serves a persisted HTML report.
 */
app.get('/report/:id', async (req, res) => {
  const meta = db.getReportMeta(req.params.id);
  if (!meta) {
    return res.status(404).send('<h1>Report not found</h1><p>This report does not exist or has been removed. Re-run the audit to generate a new one.</p>');
  }
  const html = await getReport(meta.storageKey);
  if (!html) {
    return res.status(404).send('<h1>Report file missing</h1><p>The report file could not be retrieved. Re-run the audit to generate a new one.</p>');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

/**
 * GET /report/:id/pdf
 * Downloads the cached report as a white-label PDF.
 * Optional query params: agency (name), agencyUrl
 * Requires active subscription + trial PDF limit enforcement.
 */
app.get('/report/:id/pdf', requireActiveSubscription, requirePdfAllowed, async (req, res) => {
  const meta = db.getReportMeta(req.params.id);
  if (!meta) {
    return res.status(404).json({ error: 'Report not found. Re-run the audit to generate a new one.' });
  }
  try {
    const { agency = '', agencyUrl = '' } = req.query;
    const pdfBuffer = await generatePdf(meta.audit, { agencyName: agency, agencyUrl });
    const safeUrl = meta.audit.url.replace(/https?:\/\//, '').replace(/[^a-z0-9.-]/gi, '-');
    if (req.subscription?.apiKey) db.incrementPdfCount(req.subscription.apiKey);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${safeUrl}.pdf"`);
    trackServerEvent('pdf_export', {}, req).catch(() => {});
    return res.send(pdfBuffer);
  } catch (err) {
    console.error('[pdf error]', err);
    return res.status(500).json({ error: 'PDF generation failed', detail: err.message });
  }
});

/**
 * GET /audit?url=...
 * Convenience GET endpoint (browser-friendly, returns HTML report directly).
 */
app.get('/audit', requireActiveSubscription, async (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'Missing query param: url' });
  }

  let targetUrl = url.trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }

  try {
    const audit = await auditUrl(targetUrl);
    const html = generateHtml(audit);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (err) {
    return res.status(500).json({ error: 'Audit failed', detail: err.message });
  }
});

// ── Sentry error handler (must be after all routes, before other error handlers)
if (process.env.SENTRY_DSN) {
  app.use(Sentry.expressErrorHandler());
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`AuditBot running on http://localhost:${PORT}`);
  console.log(`Try: curl -X POST http://localhost:${PORT}/audit -H 'Content-Type: application/json' -d '{"url":"https://example.com"}'`);
});

module.exports = app; // for testing
