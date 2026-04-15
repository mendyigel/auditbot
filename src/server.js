'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { auditUrl } = require('./auditor');
const { generateHtml } = require('./report');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory report cache (keyed by report UUID, TTL 1 hour)
const reportCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;

app.use(express.json());

// Clean up expired cache entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of reportCache.entries()) {
    if (now - entry.createdAt > CACHE_TTL_MS) reportCache.delete(key);
  }
}, 10 * 60 * 1000);

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
      'POST /audit': 'Run an audit. Body: { url, format? }',
      'GET /report/:id': 'View a cached HTML report by ID',
      'GET /health': 'Health check',
    },
    pricing: '$29/month · Unlimited audits',
  });
});

/**
 * GET /health
 */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

/**
 * POST /audit
 * Body: { url: string, format?: "json" | "html" }
 *
 * Returns JSON audit result by default. Pass format=html to get HTML directly.
 * The JSON result includes a reportUrl for the shareable HTML report.
 */
app.post('/audit', async (req, res) => {
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

    // Cache the HTML report
    const reportId = uuidv4();
    reportCache.set(reportId, { html: generateHtml(audit), createdAt: Date.now() });

    const reportUrl = `/report/${reportId}`;

    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(reportCache.get(reportId).html);
    }

    return res.json({ ...audit, reportUrl });
  } catch (err) {
    console.error('[audit error]', err);
    return res.status(500).json({ error: 'Audit failed', detail: err.message });
  }
});

/**
 * GET /report/:id
 * Serves a cached HTML report.
 */
app.get('/report/:id', (req, res) => {
  const entry = reportCache.get(req.params.id);
  if (!entry) {
    return res.status(404).send('<h1>Report not found or expired</h1><p>Reports expire after 1 hour. Re-run the audit to generate a new one.</p>');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(entry.html);
});

/**
 * GET /audit?url=...
 * Convenience GET endpoint (browser-friendly, returns HTML report directly).
 */
app.get('/audit', async (req, res) => {
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
