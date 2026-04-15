'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { auditUrl } = require('./auditor');
const { generateHtml } = require('./report');
const { generatePdf } = require('./pdf');
const {
  createCheckoutSession,
  handleWebhook,
  createPortalSession,
  lookupSubscription,
} = require('./billing');
const { requireActiveSubscription } = require('./auth');
const db = require('./db');
const { saveReport, getReport, deleteReport, USE_S3 } = require('./storage');

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

console.log(`[storage] Using ${USE_S3 ? 'S3 (bucket: ' + process.env.S3_BUCKET + ')' : 'local filesystem'} for report storage`);

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /
 * Simple landing page / health check
 */
app.get('/', (_req, res) => {
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
      'POST /billing/checkout': 'Subscribe at $29/month — returns { url } to Stripe checkout',
      'POST /billing/portal': 'Manage your subscription — Body: { apiKey }',
      'POST /billing/webhook': 'Stripe webhook endpoint (internal)',
    },
    pricing: '$29/month · Unlimited audits · Cancel anytime',
    billingEnabled: !!process.env.STRIPE_SECRET_KEY,
  });
});

/**
 * GET /health
 */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
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

    const reportUrl = `/report/${reportId}`;

    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }

    if (format === 'pdf') {
      const { agency = '', agencyUrl = '' } = req.body || {};
      const pdfBuffer = await generatePdf(audit, { agencyName: agency, agencyUrl });
      const filename = `audit-${encodeURIComponent(targetUrl.replace(/https?:\/\//, ''))}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(pdfBuffer);
    }

    return res.json({ ...audit, reportUrl, pdfUrl: `${reportUrl}/pdf` });
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
 */
app.get('/report/:id/pdf', async (req, res) => {
  const meta = db.getReportMeta(req.params.id);
  if (!meta) {
    return res.status(404).json({ error: 'Report not found. Re-run the audit to generate a new one.' });
  }
  try {
    const { agency = '', agencyUrl = '' } = req.query;
    const pdfBuffer = await generatePdf(meta.audit, { agencyName: agency, agencyUrl });
    const safeUrl = meta.audit.url.replace(/https?:\/\//, '').replace(/[^a-z0-9.-]/gi, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${safeUrl}.pdf"`);
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

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`AuditBot running on http://localhost:${PORT}`);
  console.log(`Try: curl -X POST http://localhost:${PORT}/audit -H 'Content-Type: application/json' -d '{"url":"https://example.com"}'`);
});

module.exports = app; // for testing
