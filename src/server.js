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
  fulfillCheckoutSession,
  TRIAL_AUDIT_LIMIT,
  TRIAL_PDF_LIMIT,
  PLANS,
} = require('./billing');
const { requireActiveSubscription, requirePdfAllowed } = require('./auth');
const db = require('./db');
const { saveReport, getReport, deleteReport, USE_S3 } = require('./storage');
const { generateLandingPage } = require('./landing');
const { generateBlogIndex, generateBlogPost } = require('./blog');
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
 * orbiolab.com landing page with email waitlist capture
 */
app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(generateLandingPage());
});

/**
 * GET /blog
 * OrbioLabs blog index — lists all posts sorted by date (newest first).
 */
app.get('/blog', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(generateBlogIndex());
});

/**
 * GET /blog/:slug
 * Individual blog post page. Returns 404 if the post slug is not found.
 */
app.get('/blog/:slug', (req, res) => {
  const html = generateBlogPost(req.params.slug);
  if (!html) {
    return res.status(404).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Post Not Found — OrbioLabs Blog</title>
<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#f1f5f9;max-width:600px;margin:80px auto;padding:0 24px}a{color:#3b82f6}</style></head>
<body><h1>Post not found</h1><p>This post doesn't exist or has been moved.</p><p><a href="/blog">&larr; Back to Blog</a></p></body></html>`);
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
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
    service: 'OrbioLabs Audit API',
    version: '1.0.0',
    description: 'OrbioLabs — Automated SEO, performance & accessibility audits with shareable HTML reports',
    endpoints: {
      'POST /audit': 'Run an audit (requires API key). Body: { url, format? } — format: json|html|pdf',
      'GET /audit?url=…': 'Browser-friendly audit (requires API key)',
      'GET /report/:id': 'View a cached HTML report by ID',
      'GET /report/:id/pdf': 'Download white-label PDF report (optional ?agency=Name&agencyUrl=…)',
      'GET /health': 'Health check',
      'POST /billing/trial': 'Start a 14-day free trial — Body: { email, tier? } (starter or pro) — returns { url } to Stripe checkout',
      'GET /trial/status?key=…': 'Get trial/plan usage: audits used, PDF exports used, days left, plan tier',
      'POST /billing/checkout': 'Subscribe — Body: { email, tier? } (starter $9/mo or pro $29/mo) — returns { url } to Stripe checkout',
      'POST /billing/portal': 'Manage your subscription — Body: { apiKey }',
      'POST /billing/webhook': 'Stripe webhook endpoint (internal)',
    },
    pricing: {
      starter: { price: '$9/month', audits: '5/month', sites: 1, pdf: false },
      pro: { price: '$29/month', audits: 'unlimited', sites: 10, pdf: true },
      trial: '14-day free trial (CC required)',
    },
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

// ── Sign-in page ──────────────────────────────────────────────────────────────

/**
 * GET /signin
 * Page where existing users enter their API key to view subscription status
 * and manage their account via Stripe portal.
 */
app.get('/signin', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign In — OrbioLabs</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root { --brand: #3b82f6; --brand-dark: #2563eb; --bg: #0f172a; --surface: #1e293b; --border: #334155; --text: #f1f5f9; --muted: #94a3b8; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
    a { color: var(--brand); text-decoration: none; }
    a:hover { text-decoration: underline; }
    nav { display: flex; align-items: center; justify-content: space-between; padding: 20px 40px; border-bottom: 1px solid var(--border); }
    .logo { font-size: 1.25rem; font-weight: 800; letter-spacing: -0.5px; color: var(--text); }
    .logo span { color: var(--brand); }
    .signin-container { max-width: 440px; margin: 80px auto; padding: 0 24px; }
    h1 { font-size: 1.75rem; font-weight: 800; margin-bottom: 8px; }
    .subtitle { color: var(--muted); margin-bottom: 32px; }
    label { display: block; font-size: 0.875rem; font-weight: 600; margin-bottom: 8px; }
    input[type="text"] {
      width: 100%; padding: 12px 16px; border-radius: 8px; border: 1px solid var(--border);
      background: var(--surface); color: var(--text); font-size: 1rem; outline: none; margin-bottom: 16px;
    }
    input[type="text"]:focus { border-color: var(--brand); }
    input[type="text"]::placeholder { color: var(--muted); }
    .btn { display: block; width: 100%; padding: 14px; background: var(--brand); color: #fff; border: none; border-radius: 8px; font-size: 1rem; font-weight: 700; cursor: pointer; }
    .btn:hover { background: var(--brand-dark); }
    .btn:disabled { opacity: 0.6; cursor: default; }
    #signin-error { display: none; margin-top: 12px; font-size: 0.9rem; color: #f87171; font-weight: 600; }
    #signin-result { display: none; margin-top: 24px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
    #signin-result h2 { font-size: 1.125rem; font-weight: 700; margin-bottom: 16px; }
    .status-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
    .status-row:last-child { border: none; }
    .status-label { color: var(--muted); }
    .status-value { font-weight: 600; }
    .portal-link { display: block; width: 100%; text-align: center; padding: 12px; background: var(--brand); color: #fff; border-radius: 8px; font-weight: 700; margin-top: 20px; }
    .portal-link:hover { background: var(--brand-dark); text-decoration: none; }
    .signup-note { text-align: center; margin-top: 24px; color: var(--muted); font-size: 0.875rem; }
  </style>
</head>
<body>
<nav>
  <a href="/" style="text-decoration:none"><div class="logo">Orbio<span>Labs</span></div></a>
  <a href="#pricing" style="background:var(--brand);color:#fff;padding:8px 20px;border-radius:6px;font-weight:600;font-size:0.875rem;">Start free trial</a>
</nav>
<div class="signin-container">
  <h1>Sign in</h1>
  <p class="subtitle">Enter your API key to view your subscription and manage your account.</p>
  <form id="signin-form" novalidate>
    <label for="api-key">API Key</label>
    <input type="text" id="api-key" name="key" placeholder="obl_xxxxxxxxxxxxxxxx" required autocomplete="off" />
    <button type="submit" class="btn" id="signin-btn">Sign in</button>
  </form>
  <div id="signin-error"></div>
  <div id="signin-result">
    <h2>Your Subscription</h2>
    <div id="status-rows"></div>
    <a id="portal-btn" href="#" class="portal-link">Manage subscription</a>
  </div>
  <div class="signup-note">Don't have an account? <a href="/#pricing">Start a free trial</a></div>
</div>
<script>
(function () {
  var form = document.getElementById('signin-form');
  var btn = document.getElementById('signin-btn');
  var errEl = document.getElementById('signin-error');
  var resultEl = document.getElementById('signin-result');

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var key = document.getElementById('api-key').value.trim();
    if (!key) return;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    errEl.style.display = 'none';
    resultEl.style.display = 'none';

    fetch('/trial/status?key=' + encodeURIComponent(key))
      .then(function (r) {
        if (!r.ok) return r.json().then(function (d) { return Promise.reject(d); });
        return r.json();
      })
      .then(function (data) {
        btn.disabled = false;
        btn.textContent = 'Sign in';
        var rows = '';
        rows += '<div class="status-row"><span class="status-label">Status</span><span class="status-value">' + data.status + '</span></div>';
        if (data.plan) {
          rows += '<div class="status-row"><span class="status-label">Plan</span><span class="status-value">' + (data.plan.name || data.plan.tier) + '</span></div>';
        }
        if (data.trial) {
          rows += '<div class="status-row"><span class="status-label">Audits used</span><span class="status-value">' + data.trial.auditsUsed + ' / ' + data.trial.auditsLimit + '</span></div>';
          rows += '<div class="status-row"><span class="status-label">PDFs used</span><span class="status-value">' + data.trial.pdfsUsed + ' / ' + data.trial.pdfsLimit + '</span></div>';
          rows += '<div class="status-row"><span class="status-label">Days left</span><span class="status-value">' + data.trial.daysLeft + '</span></div>';
        } else if (data.plan) {
          var used = data.plan.monthlyAuditsUsed != null ? data.plan.monthlyAuditsUsed : '—';
          var limit = data.plan.monthlyAuditsLimit || '—';
          rows += '<div class="status-row"><span class="status-label">Monthly audits</span><span class="status-value">' + used + ' / ' + limit + '</span></div>';
        }
        document.getElementById('status-rows').innerHTML = rows;
        document.getElementById('portal-btn').href = '/billing/portal?key=' + encodeURIComponent(key);
        resultEl.style.display = 'block';
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Sign in';
        errEl.textContent = (err && err.error) ? err.error : 'Could not find that API key. Please check and try again.';
        errEl.style.display = 'block';
      });
  });
})();
</script>
${appPageAnalyticsSnippet('signin')}
${consentBannerSnippet()}
</body>
</html>`);
});

// ── Billing routes ────────────────────────────────────────────────────────────

/**
 * GET /billing/checkout
 * Redirect to sign-in page (old bookmarks / direct navigation).
 */
app.get('/billing/checkout', (_req, res) => {
  res.redirect(301, '/signin');
});

/**
 * POST /billing/checkout
 * Body: { email? }
 * Returns { url } — redirect the user's browser to this Stripe Checkout URL.
 * After payment, Stripe redirects to APP_URL/billing/success?session_id=…
 */
app.post('/billing/checkout', async (req, res) => {
  try {
    const { email, tier = 'pro' } = req.body || {};
    if (tier !== 'starter' && tier !== 'pro') {
      return res.status(400).json({ error: 'Invalid tier. Must be "starter" or "pro".' });
    }
    const base = process.env.APP_URL || `http://localhost:${PORT}`;
    const { url, sessionId } = await createCheckoutSession({
      email: email || undefined,
      tier,
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
    const { email, tier = 'starter' } = req.body || {};
    if (tier !== 'starter' && tier !== 'pro') {
      return res.status(400).json({ error: 'Invalid tier. Must be "starter" or "pro".' });
    }
    const base = process.env.APP_URL || `http://localhost:${PORT}`;
    const { url, sessionId } = await createTrialCheckoutSession({
      email: email || undefined,
      tier,
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
app.get('/billing/trial/success', async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  let apiKeyHtml = '<p>Your API key will be sent to your email shortly. Check your inbox.</p>';
  try {
    const result = await fulfillCheckoutSession(req.query.session_id);
    if (result && result.apiKey) {
      apiKeyHtml = `<p>Your API key:</p><p><code>${result.apiKey}</code></p><p>Save this key — you'll need it to authenticate API requests. A copy has also been sent to your email.</p>`;
    }
  } catch (err) {
    console.error('[billing/trial/success] session retrieval failed:', err.message);
  }
  res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>OrbioLabs — Trial Started</title>
<style>body{font-family:system-ui,sans-serif;max-width:600px;margin:80px auto;padding:0 24px;color:#111}
h1{color:#16a34a}code{background:#f4f4f5;padding:4px 8px;border-radius:4px;font-size:1.1em;word-break:break-all}
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
${apiKeyHtml}
<p>You won't be charged until your trial ends. Cancel anytime before then at no cost.</p>
<p><a href="/">Back to OrbioLabs</a></p>
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

  const plan = PLANS[sub.planTier] || PLANS.pro;
  const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;

  if (sub.status !== 'trialing') {
    const monthlyCount = db.getMonthlyAuditCount(apiKey);
    return res.json({
      status: sub.status,
      plan: {
        tier: sub.planTier,
        name: plan.name,
        monthlyAuditsUsed: monthlyCount,
        monthlyAuditsLimit: plan.monthlyAudits === Infinity ? 'unlimited' : plan.monthlyAudits,
        pdfExport: plan.pdfExport,
        maxSites: plan.maxSites,
      },
      trial: null,
    });
  }

  const trial = getTrialInfo(sub);

  return res.json({
    status: sub.status,
    plan: { tier: sub.planTier, name: plan.name },
    trial: {
      auditsUsed:   trial.auditsUsed,
      auditsLimit:  TRIAL_AUDIT_LIMIT,
      auditsLeft:   Math.max(0, TRIAL_AUDIT_LIMIT - trial.auditsUsed),
      pdfsUsed:     trial.pdfsUsed,
      pdfsLimit:    TRIAL_PDF_LIMIT,
      pdfsLeft:     Math.max(0, TRIAL_PDF_LIMIT - trial.pdfsUsed),
      daysLeft:     trial.daysLeft,
      upgradeUrl:   `${appUrl}/billing/checkout?tier=pro`,
      softWarning:  trial.auditsUsed >= TRIAL_AUDIT_LIMIT - 2, // warn at 8/10
    },
  });
});

/**
 * GET /billing/success
 * Landing page after successful Stripe checkout.
 * Retrieves (or creates) the API key for the new customer and displays it.
 */
app.get('/billing/success', async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  let apiKeyHtml = '<p>Your API key will be sent to your email shortly.</p>';
  try {
    const result = await fulfillCheckoutSession(req.query.session_id);
    if (result && result.apiKey) {
      apiKeyHtml = `<p>Your API key:</p><p><code>${result.apiKey}</code></p><p>Save this key — you'll need it to authenticate API requests. A copy has also been sent to your email.</p>`;
    }
  } catch (err) {
    console.error('[billing/success] session retrieval failed:', err.message);
  }
  res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>OrbioLabs — Subscription Active</title>
<style>body{font-family:system-ui,sans-serif;max-width:600px;margin:80px auto;padding:0 24px;color:#111}
h1{color:#16a34a}code{background:#f4f4f5;padding:4px 8px;border-radius:4px;font-size:1.1em;word-break:break-all}</style>
</head>
<body>
<h1>You're all set!</h1>
<p>Your subscription is active.</p>
${apiKeyHtml}
<p><a href="/">Back to OrbioLabs</a></p>
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
<head><meta charset="UTF-8"><title>OrbioLabs — Checkout Cancelled</title>
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

// ── Free audit (landing page demo — no auth, rate-limited) ───────────────────

const freeAuditLimiter = { counts: new Map(), resetInterval: null };
// Clean up stale entries every 10 minutes
freeAuditLimiter.resetInterval = setInterval(() => {
  const cutoff = Date.now() - 3600000;
  for (const [ip, entry] of freeAuditLimiter.counts) {
    if (entry.firstAt < cutoff) freeAuditLimiter.counts.delete(ip);
  }
}, 600000);

/**
 * POST /audit/free
 * Body: { url: string }
 * No auth required. Returns JSON audit results for the landing page demo.
 * Rate-limited to 3 audits per IP per hour.
 */
app.post('/audit/free', async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing required field: url' });
  }

  // Basic rate limiting by IP
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = freeAuditLimiter.counts.get(ip) || { count: 0, firstAt: now };
  if (now - entry.firstAt > 3600000) {
    entry.count = 0;
    entry.firstAt = now;
  }
  if (entry.count >= 3) {
    return res.status(429).json({
      error: 'Rate limit reached',
      detail: 'Free audits are limited to 3 per hour. Start a free trial for unlimited audits.',
      trialUrl: '/billing/trial',
    });
  }
  entry.count++;
  freeAuditLimiter.counts.set(ip, entry);

  let targetUrl = url.trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }

  try {
    const audit = await auditUrl(targetUrl);

    trackServerEvent('free_audit_run', {}, req).catch(() => {});

    return res.json(audit);
  } catch (err) {
    console.error('[free audit error]', err);
    return res.status(500).json({ error: 'Audit failed', detail: err.message });
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

    // Track audit count for trial email triggers and monthly limits
    if (req.subscription?.apiKey) {
      db.incrementAuditCount(req.subscription.apiKey);
      db.incrementMonthlyAuditCount(req.subscription.apiKey);
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
  console.log(`OrbioLabs running on http://localhost:${PORT}`);
  console.log(`Try: curl -X POST http://localhost:${PORT}/audit -H 'Content-Type: application/json' -d '{"url":"https://example.com"}'`);
});

module.exports = app; // for testing
