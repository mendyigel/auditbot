'use strict';

// Initialise Sentry before anything else so all errors are captured.
const Sentry = require('./monitoring');

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { auditUrl } = require('./auditor');
const { crawlSite } = require('./crawler');
const { benchmarkCompetitors } = require('./competitor');
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
  cancelSubscription,
  TRIAL_AUDIT_LIMIT,
  TRIAL_PDF_LIMIT,
  PLANS,
} = require('./billing');
const { requireActiveSubscription, requirePdfAllowed, allowFreeTier } = require('./auth');
const db = require('./db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const { saveReport, getReport, deleteReport, USE_S3 } = require('./storage');
const { generateLandingPage } = require('./landing');
const { generateBlogIndex, generateBlogPost } = require('./blog');
const { consentBannerSnippet } = require('./consent-banner');
const { appPageAnalyticsSnippet, trackServerEvent } = require('./analytics');
const emailService = require('./email');
const { mapKeywordOpportunities } = require('./keywords');
const { analyzeContentGaps } = require('./content-gap');
const { frameRoi } = require('./roi');
const { startScheduler, MAX_SITES_PER_USER } = require('./monitor');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = (process.env.APP_URL || '').startsWith('https');

/** Cookie options with secure flag in production */
function cookieOpts(extra = {}) {
  const opts = { httpOnly: true, sameSite: 'lax', path: '/', ...extra };
  if (IS_PRODUCTION) opts.secure = true;
  return opts;
}

// Report TTL — default 30 days; set REPORT_TTL_DAYS env var to override
const REPORT_TTL_MS = (parseInt(process.env.REPORT_TTL_DAYS, 10) || 30) * 24 * 60 * 60 * 1000;

// Stripe webhooks require raw body — mount before express.json()
app.use('/billing/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cookieParser());

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
      'POST /audit': 'Run a single-page audit (requires API key). Body: { url, format? } — format: json|html|pdf',
      'POST /audit/site': 'Multi-page site crawl + audit (requires API key). Body: { url, maxPages? }',
      'POST /audit/competitors': 'Competitor benchmarking (requires API key). Body: { url, competitors: string[] }',
      'POST /audit/keywords': 'Keyword opportunity mapping — Pro plan only. Body: { url, maxKeywords? }',
      'POST /audit/content-gaps': 'Content gap analysis — Pro plan only. Body: { url, competitors: string[], maxGaps? }',
      'POST /audit/full': 'Full audit: page audit + site crawl + competitor benchmarking + Tier 2 (Pro). Body: { url, competitors?, maxPages?, format?, industry? }',
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

  // Email configuration (informational)
  checks.email = emailService.getStatus();

  const payload = {
    status: allOk ? 'ok' : 'degraded',
    version: '1.0.0',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    checks,
  };

  res.status(allOk ? 200 : 503).json(payload);
});

/**
 * POST /admin/test-email
 * Sends a test email and returns the raw Resend API response for diagnostics.
 * Body: { "to": "recipient@example.com" }
 */
app.post('/admin/test-email', async (req, res) => {
  const { to } = req.body || {};
  if (!to) return res.status(400).json({ error: 'Missing "to" field' });
  const result = await emailService.sendTest(to);
  res.json({ emailConfig: emailService.getStatus(), result });
});

// ── Auth style shared between sign-in and sign-up ────────────────────────────

const authPageStyles = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root { --brand: #3b82f6; --brand-dark: #2563eb; --bg: #0f172a; --surface: #1e293b; --border: #334155; --text: #f1f5f9; --muted: #94a3b8; --danger: #f87171; --success: #34d399; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
    a { color: var(--brand); text-decoration: none; }
    a:hover { text-decoration: underline; }
    nav { display: flex; align-items: center; justify-content: space-between; padding: 20px 40px; border-bottom: 1px solid var(--border); }
    .logo { font-size: 1.25rem; font-weight: 800; letter-spacing: -0.5px; color: var(--text); }
    .logo span { color: var(--brand); }
    .auth-container { max-width: 440px; margin: 80px auto; padding: 0 24px; }
    h1 { font-size: 1.75rem; font-weight: 800; margin-bottom: 8px; }
    .subtitle { color: var(--muted); margin-bottom: 32px; }
    label { display: block; font-size: 0.875rem; font-weight: 600; margin-bottom: 8px; }
    input[type="text"], input[type="password"] {
      width: 100%; padding: 12px 16px; border-radius: 8px; border: 1px solid var(--border);
      background: var(--surface); color: var(--text); font-size: 1rem; outline: none; margin-bottom: 16px;
    }
    input:focus { border-color: var(--brand); }
    input::placeholder { color: var(--muted); }
    .btn { display: block; width: 100%; padding: 14px; background: var(--brand); color: #fff; border: none; border-radius: 8px; font-size: 1rem; font-weight: 700; cursor: pointer; }
    .btn:hover { background: var(--brand-dark); }
    .btn:disabled { opacity: 0.6; cursor: default; }
    .form-error { display: none; margin-top: 12px; font-size: 0.9rem; color: var(--danger); font-weight: 600; }
    .form-success { display: none; margin-top: 12px; font-size: 0.9rem; color: var(--success); font-weight: 600; }
    .alt-link { text-align: center; margin-top: 24px; color: var(--muted); font-size: 0.875rem; }
    .field-hint { font-size: 0.8rem; color: var(--muted); margin-top: -12px; margin-bottom: 16px; }
`;

const authNavHtml = `<nav>
  <a href="/" style="text-decoration:none"><div class="logo">Orbio<span>Labs</span></div></a>
  <a href="/#pricing" style="background:var(--brand);color:#fff;padding:8px 20px;border-radius:6px;font-weight:600;font-size:0.875rem;">Start free trial</a>
</nav>`;

// ── Sign-up page ─────────────────────────────────────────────────────────────

app.get('/signup', (req, res) => {
  const tier = req.query.tier || '';
  const validTier = (tier === 'starter' || tier === 'pro') ? tier : '';
  const trialStarted = req.query.trial_started === '1';
  const planNames = { starter: 'Starter ($9/mo)', pro: 'Pro ($29/mo)' };
  const tierBanner = trialStarted
    ? '<div style="background:rgba(22,163,74,0.1);border:1px solid rgba(22,163,74,0.3);border-radius:8px;padding:16px;margin-bottom:24px;color:#15803d;font-weight:600;font-size:0.9rem;">Your free trial is active! Create an account to access your dashboard and start running audits.</div>'
    : validTier
    ? '<div style="background:rgba(59,130,246,0.12);border:1px solid rgba(59,130,246,0.3);border-radius:8px;padding:16px;margin-bottom:24px;color:var(--brand);font-weight:600;font-size:0.9rem;">14-day free trial — ' + planNames[validTier] + '. You won\'t be charged today.</div>'
    : '';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign Up — OrbioLabs</title>
  <style>${authPageStyles}</style>
</head>
<body>
${authNavHtml}
<div class="auth-container">
  <h1>Create your account</h1>
  <p class="subtitle">Sign up to get started with OrbioLabs website audits.</p>
  ${tierBanner}
  <form id="signup-form" novalidate>
    <input type="hidden" id="tier" value="${validTier}" />
    <label for="username">Username</label>
    <input type="text" id="username" name="username" placeholder="johndoe" required autocomplete="username" />
    <label for="password">Password</label>
    <input type="password" id="password" name="password" placeholder="At least 8 characters" required autocomplete="new-password" />
    <p class="field-hint">Must be at least 8 characters long.</p>
    <label for="email">Email</label>
    <input type="text" id="email" name="email" placeholder="you@example.com" required autocomplete="email" />
    <button type="submit" class="btn" id="signup-btn">${validTier ? 'Create account &amp; start free trial' : 'Create account'}</button>
  </form>
  <div id="form-error" class="form-error"></div>
  <div id="form-success" class="form-success"></div>
  <p class="alt-link">Already have an account? <a href="/signin">Sign in</a></p>
</div>
<script>
(function () {
  var form = document.getElementById('signup-form');
  var btn = document.getElementById('signup-btn');
  var errEl = document.getElementById('form-error');
  var successEl = document.getElementById('form-success');
  var tierEl = document.getElementById('tier');

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var username = document.getElementById('username').value.trim();
    var password = document.getElementById('password').value;
    var email = document.getElementById('email').value.trim();
    var tier = tierEl ? tierEl.value : '';
    if (!username || !password) return;
    if (password.length < 8) {
      errEl.textContent = 'Password must be at least 8 characters.';
      errEl.style.display = 'block';
      successEl.style.display = 'none';
      return;
    }
    if (tier && !email) {
      errEl.textContent = 'Email is required to start a free trial.';
      errEl.style.display = 'block';
      successEl.style.display = 'none';
      return;
    }
    btn.disabled = true;
    btn.textContent = tier ? 'Creating account…' : 'Creating account…';
    errEl.style.display = 'none';
    successEl.style.display = 'none';

    var body = { username: username, password: password };
    if (email) body.email = email;
    if (tier) body.tier = tier;

    fetch('/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    .then(function (r) {
      if (!r.ok) return r.json().then(function (d) { return Promise.reject(d); });
      return r.json();
    })
    .then(function (data) {
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      } else {
        window.location.href = '/dashboard';
      }
    })
    .catch(function (err) {
      btn.disabled = false;
      btn.textContent = tier ? 'Create account & start free trial' : 'Create account';
      errEl.textContent = (err && err.error) ? err.error : 'Sign-up failed. Please try again.';
      errEl.style.display = 'block';
    });
  });
})();
</script>
${appPageAnalyticsSnippet('signup')}
${consentBannerSnippet()}
</body>
</html>`);
});

// ── Sign-in page ──────────────────────────────────────────────────────────────

app.get('/signin', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign In — OrbioLabs</title>
  <style>${authPageStyles}</style>
</head>
<body>
${authNavHtml}
<div class="auth-container">
  <h1>Sign in</h1>
  <p class="subtitle">Enter your username and password to access your account.</p>
  <form id="signin-form" novalidate>
    <label for="username">Username</label>
    <input type="text" id="username" name="username" placeholder="johndoe" required autocomplete="username" />
    <label for="password">Password</label>
    <input type="password" id="password" name="password" placeholder="Your password" required autocomplete="current-password" />
    <button type="submit" class="btn" id="signin-btn">Sign in</button>
  </form>
  <div id="form-error" class="form-error"></div>
  <p class="alt-link" style="margin-bottom:12px"><a href="/auth/forgot-password">Forgot your password?</a></p>
  <p class="alt-link">Don't have an account? <a href="/signup">Sign up</a></p>
</div>
<script>
(function () {
  var form = document.getElementById('signin-form');
  var btn = document.getElementById('signin-btn');
  var errEl = document.getElementById('form-error');

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var username = document.getElementById('username').value.trim();
    var password = document.getElementById('password').value;
    if (!username || !password) return;
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    errEl.style.display = 'none';

    fetch('/auth/signin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password })
    })
    .then(function (r) {
      if (!r.ok) return r.json().then(function (d) { return Promise.reject(d); });
      return r.json();
    })
    .then(function () {
      window.location.href = '/dashboard';
    })
    .catch(function (err) {
      btn.disabled = false;
      btn.textContent = 'Sign in';
      if (err && err.resubscribeUrl) {
        errEl.innerHTML = err.error + ' <a href="' + err.resubscribeUrl + '" style="color:#3b82f6">Resubscribe</a>';
      } else {
        errEl.textContent = (err && err.error) ? err.error : 'Invalid username or password.';
      }
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

// ── Auth API endpoints ───────────────────────────────────────────────────────

const BCRYPT_ROUNDS = 12;

/**
 * POST /auth/signup
 * Body: { username, password, email?, tier? }
 * Creates a new user account with hashed password, sets session cookie.
 * If tier is provided (starter/pro), creates a Stripe trial checkout session
 * and returns { checkoutUrl } so the client can redirect to Stripe.
 */
app.post('/auth/signup', async (req, res) => {
  const { username, password, email, tier } = req.body || {};

  if (!username || typeof username !== 'string' || username.trim().length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters.' });
  }
  if (!password || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (username.trim().length > 64) {
    return res.status(400).json({ error: 'Username must be 64 characters or fewer.' });
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(username.trim())) {
    return res.status(400).json({ error: 'Username may only contain letters, numbers, underscores, hyphens, and dots.' });
  }
  if (tier && tier !== 'starter' && tier !== 'pro') {
    return res.status(400).json({ error: 'Invalid plan tier.' });
  }
  if (tier && !email) {
    return res.status(400).json({ error: 'Email is required to start a free trial.' });
  }

  const trimmedUsername = username.trim();
  const existing = db.getUserByUsername(trimmedUsername);
  if (existing) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const userId = uuidv4();
    const sessionToken = crypto.randomBytes(32).toString('hex');

    db.createUser({
      id: userId,
      username: trimmedUsername,
      passwordHash,
      email: email || null,
      sessionToken,
    });

    res.cookie('session', sessionToken, cookieOpts({ maxAge: 30 * 24 * 60 * 60 * 1000 }));

    // If a pending trial API key exists (from Stripe checkout before signup), link it now
    const pendingKey = req.cookies && req.cookies.pending_trial_key;
    if (pendingKey) {
      db.linkUserApiKey(userId, pendingKey);
      res.clearCookie('pending_trial_key', { path: '/' });
    }

    // If a tier was selected, create Stripe trial checkout and redirect there
    if (tier && process.env.STRIPE_SECRET_KEY) {
      const base = process.env.APP_URL || `http://localhost:${PORT}`;
      const { url } = await createTrialCheckoutSession({
        email: email,
        tier,
        successUrl: `${base}/billing/trial/success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${base}/dashboard`,
      });
      return res.json({ ok: true, username: trimmedUsername, checkoutUrl: url });
    }

    return res.json({ ok: true, username: trimmedUsername });
  } catch (err) {
    console.error('[auth/signup error]', err);
    return res.status(500).json({ error: 'Account creation failed. Please try again.' });
  }
});

/**
 * POST /auth/signin
 * Body: { username, password }
 * Verifies credentials, sets session cookie.
 */
app.post('/auth/signin', async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const user = db.getUserByUsername(username.trim());
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  // Block cancelled users — they must resubscribe before accessing the site
  if (user.api_key && process.env.STRIPE_SECRET_KEY) {
    const sub = lookupSubscription(user.api_key);
    if (sub && sub.status === 'cancelled') {
      const appUrl = process.env.APP_URL || '';
      return res.status(403).json({
        error: 'Your subscription has been cancelled. Please resubscribe to regain access.',
        resubscribeUrl: `${appUrl}/billing/checkout`,
      });
    }
  }

  const sessionToken = crypto.randomBytes(32).toString('hex');
  db.updateUserSession(user.id, sessionToken);

  res.cookie('session', sessionToken, cookieOpts({ maxAge: 30 * 24 * 60 * 60 * 1000 }));

  // Link pending trial key if present (user completed Stripe before signing in)
  const pendingKey = req.cookies && req.cookies.pending_trial_key;
  if (pendingKey && !user.api_key) {
    db.linkUserApiKey(user.id, pendingKey);
    res.clearCookie('pending_trial_key', { path: '/' });
  }

  return res.json({ ok: true, username: user.username });
});

/**
 * POST /auth/signout
 * Clears session cookie and invalidates session token.
 */
app.post('/auth/signout', (req, res) => {
  const sessionToken = req.cookies && req.cookies.session;
  if (sessionToken) {
    const user = db.getUserBySessionToken(sessionToken);
    if (user) db.updateUserSession(user.id, null);
  }
  res.clearCookie('session', { path: '/' });
  return res.json({ ok: true });
});

// ── Forgot / Reset Password ──────────────────────────────────────────────────

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * GET /auth/forgot-password
 * Page with email input to request a password reset link.
 */
app.get('/auth/forgot-password', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Forgot Password — OrbioLabs</title>
  <style>${authPageStyles}</style>
</head>
<body>
${authNavHtml}
<div class="auth-container">
  <h1>Reset your password</h1>
  <p class="subtitle">Enter the email address you used to sign up and we'll send you a reset link.</p>
  <form id="forgot-form" novalidate>
    <label for="email">Email</label>
    <input type="text" id="email" name="email" placeholder="you@example.com" required autocomplete="email" />
    <button type="submit" class="btn" id="forgot-btn">Send reset link</button>
  </form>
  <div id="form-error" class="form-error"></div>
  <div id="form-success" class="form-success"></div>
  <p class="alt-link">Remember your password? <a href="/signin">Sign in</a></p>
</div>
<script>
(function () {
  var form = document.getElementById('forgot-form');
  var btn = document.getElementById('forgot-btn');
  var errEl = document.getElementById('form-error');
  var successEl = document.getElementById('form-success');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var email = document.getElementById('email').value.trim();
    if (!email) return;
    btn.disabled = true;
    btn.textContent = 'Sending…';
    errEl.style.display = 'none';
    successEl.style.display = 'none';
    fetch('/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email })
    })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      btn.disabled = false;
      btn.textContent = 'Send reset link';
      successEl.textContent = 'If an account with that email exists, we sent a reset link. Check your inbox.';
      successEl.style.display = 'block';
    })
    .catch(function () {
      btn.disabled = false;
      btn.textContent = 'Send reset link';
      successEl.textContent = 'If an account with that email exists, we sent a reset link. Check your inbox.';
      successEl.style.display = 'block';
    });
  });
})();
</script>
${appPageAnalyticsSnippet('forgot-password')}
${consentBannerSnippet()}
</body>
</html>`);
});

/**
 * POST /auth/forgot-password
 * Body: { email }
 * Generates a reset token and sends a reset email. Always returns 200
 * to prevent email enumeration.
 */
app.post('/auth/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  if (!email || typeof email !== 'string') {
    return res.json({ ok: true }); // don't reveal whether email exists
  }
  const user = db.getUserByEmail(email.trim());
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + RESET_TOKEN_TTL_MS;
    db.setResetToken(user.id, token, expires);
    const base = process.env.APP_URL || 'http://localhost:' + PORT;
    const resetUrl = base + '/auth/reset-password?token=' + token;
    emailService.sendPasswordReset(user.email, { resetUrl }).catch((err) => {
      console.error('[auth/forgot-password] email send failed:', err.message);
    });
  }
  return res.json({ ok: true });
});

/**
 * GET /auth/reset-password?token=...
 * Page with new password form.
 */
app.get('/auth/reset-password', (req, res) => {
  const token = req.query.token || '';
  const user = token ? db.getUserByResetToken(token) : null;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (!user) {
    return res.send('<!DOCTYPE html>' +
'<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Invalid Link — OrbioLabs</title>' +
'<style>' + authPageStyles + '</style></head><body>' +
authNavHtml +
'<div class="auth-container">' +
'  <h1>Invalid or expired link</h1>' +
'  <p class="subtitle">This password reset link is invalid or has expired. Please request a new one.</p>' +
'  <a href="/auth/forgot-password" class="btn" style="display:block;text-align:center;text-decoration:none">Request new reset link</a>' +
'</div></body></html>');
  }
  res.send('<!DOCTYPE html>' +
'<html lang="en">' +
'<head>' +
'  <meta charset="UTF-8" />' +
'  <meta name="viewport" content="width=device-width, initial-scale=1" />' +
'  <title>Reset Password — OrbioLabs</title>' +
'  <style>' + authPageStyles + '</style>' +
'</head>' +
'<body>' +
authNavHtml +
'<div class="auth-container">' +
'  <h1>Set a new password</h1>' +
'  <p class="subtitle">Enter your new password below.</p>' +
'  <form id="reset-form" novalidate>' +
'    <input type="hidden" id="token" value="' + token.replace(/"/g, '&quot;') + '" />' +
'    <label for="password">New password</label>' +
'    <input type="password" id="password" name="password" placeholder="At least 8 characters" required autocomplete="new-password" />' +
'    <p class="field-hint">Must be at least 8 characters long.</p>' +
'    <button type="submit" class="btn" id="reset-btn">Reset password</button>' +
'  </form>' +
'  <div id="form-error" class="form-error"></div>' +
'  <div id="form-success" class="form-success"></div>' +
'</div>' +
'<script>' +
'(function () {' +
'  var form = document.getElementById("reset-form");' +
'  var btn = document.getElementById("reset-btn");' +
'  var errEl = document.getElementById("form-error");' +
'  var successEl = document.getElementById("form-success");' +
'  form.addEventListener("submit", function (e) {' +
'    e.preventDefault();' +
'    var password = document.getElementById("password").value;' +
'    var token = document.getElementById("token").value;' +
'    if (!password || password.length < 8) {' +
'      errEl.textContent = "Password must be at least 8 characters.";' +
'      errEl.style.display = "block";' +
'      return;' +
'    }' +
'    btn.disabled = true;' +
'    btn.textContent = "Resetting…";' +
'    errEl.style.display = "none";' +
'    successEl.style.display = "none";' +
'    fetch("/auth/reset-password", {' +
'      method: "POST",' +
'      headers: { "Content-Type": "application/json" },' +
'      body: JSON.stringify({ token: token, password: password })' +
'    })' +
'    .then(function (r) {' +
'      if (!r.ok) return r.json().then(function (d) { return Promise.reject(d); });' +
'      return r.json();' +
'    })' +
'    .then(function () {' +
'      successEl.textContent = "Password reset successfully! Redirecting to sign in…";' +
'      successEl.style.display = "block";' +
'      setTimeout(function () { window.location.href = "/signin"; }, 2000);' +
'    })' +
'    .catch(function (err) {' +
'      btn.disabled = false;' +
'      btn.textContent = "Reset password";' +
'      errEl.textContent = (err && err.error) ? err.error : "Reset failed. The link may have expired.";' +
'      errEl.style.display = "block";' +
'    });' +
'  });' +
'})();' +
'</script>' +
appPageAnalyticsSnippet('reset-password') +
consentBannerSnippet() +
'</body></html>');
});

/**
 * POST /auth/reset-password
 * Body: { token, password }
 * Validates the reset token and updates the password.
 */
app.post('/auth/reset-password', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) {
    return res.status(400).json({ error: 'Token and new password are required.' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  const user = db.getUserByResetToken(token);
  if (!user) {
    return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
  }
  try {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    db.updatePassword(user.id, passwordHash);
    // Invalidate existing sessions for security
    db.updateUserSession(user.id, null);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[auth/reset-password error]', err);
    return res.status(500).json({ error: 'Password reset failed. Please try again.' });
  }
});

/**
 * GET /dashboard
 * Authenticated user dashboard — shows account info, subscription status, audit tools.
 * Features tabbed navigation: Run Audit, My Reports, Account.
 */
app.get('/dashboard', (req, res) => {
  const sessionToken = req.cookies && req.cookies.session;
  if (!sessionToken) return res.redirect('/signin');
  const user = db.getUserBySessionToken(sessionToken);
  if (!user) return res.redirect('/signin');

  const sub = user.api_key ? lookupSubscription(user.api_key) : null;
  const hasActiveSub = sub && (sub.status === 'active' || sub.status === 'trialing' || sub.status === 'cancelling');

  // Redirect cancelled users to a resubscribe page instead of the full dashboard
  if (sub && sub.status === 'cancelled') {
    const appUrl = process.env.APP_URL || '';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Subscription Cancelled — OrbioLabs</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--brand:#3b82f6;--brand-dark:#2563eb;--bg:#0f172a;--surface:#1e293b;--border:#334155;--text:#f1f5f9;--muted:#94a3b8}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;flex-direction:column}
.top-nav{display:flex;align-items:center;justify-content:space-between;padding:16px 40px;border-bottom:1px solid var(--border)}
.logo{font-size:1.25rem;font-weight:800;letter-spacing:-0.5px;color:var(--text);text-decoration:none}
.logo span{color:var(--brand)}
.centre{flex:1;display:flex;align-items:center;justify-content:center;padding:32px 16px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:48px 40px;max-width:520px;width:100%;text-align:center}
.card h2{font-size:1.5rem;font-weight:700;margin-bottom:12px}
.card p{color:var(--muted);line-height:1.6;margin-bottom:28px}
.btn-resub{display:inline-block;background:var(--brand);color:#fff;font-size:1rem;font-weight:600;padding:14px 36px;border-radius:8px;text-decoration:none;transition:background 0.15s}
.btn-resub:hover{background:var(--brand-dark);text-decoration:none}
.signout-link{display:inline-block;margin-top:20px;font-size:0.85rem;color:var(--muted);text-decoration:none;cursor:pointer;background:none;border:none}
.signout-link:hover{color:var(--text)}
</style></head><body>
<nav class="top-nav"><a class="logo" href="/">Orbio<span>Labs</span></a></nav>
<div class="centre"><div class="card">
<h2>Subscription Cancelled</h2>
<p>Your subscription has ended and access to auditing tools is no longer available. Resubscribe to pick up where you left off.</p>
<a href="${appUrl}/billing/checkout" class="btn-resub">Resubscribe</a>
<br><button class="signout-link" onclick="fetch('/auth/signout',{method:'POST'}).then(function(){window.location.href='/'})">Sign out</button>
</div></div></body></html>`);
  }

  let subscriptionHtml = '';
  if (sub) {
    const plan = PLANS[sub.planTier] || PLANS.pro;
    subscriptionHtml = '<div class="card"><h2>Subscription</h2>';
    const statusDisplay = sub.status === 'cancelling' ? 'Cancelling at period end' : sub.status;
    subscriptionHtml += '<div class="status-row"><span class="status-label">Status</span><span class="status-value">' + statusDisplay + '</span></div>';
    subscriptionHtml += '<div class="status-row"><span class="status-label">Plan</span><span class="status-value">' + plan.name + '</span></div>';
    subscriptionHtml += '<div class="status-row"><span class="status-label">API Key</span><span class="status-value" style="font-family:monospace;font-size:0.8rem;word-break:break-all">' + sub.apiKey + '</span></div>';
    if (sub.status === 'cancelling') {
      subscriptionHtml += '<p style="color:#f59e0b;font-size:0.85rem;margin-top:12px">Your subscription will be cancelled at the end of your current billing period. You retain full access until then.</p>';
      subscriptionHtml += '<a href="/billing/portal?key=' + encodeURIComponent(sub.apiKey) + '" class="portal-link">Reactivate subscription</a>';
    } else {
      subscriptionHtml += '<a href="/billing/portal?key=' + encodeURIComponent(sub.apiKey) + '" class="portal-link">Manage subscription</a>';
      subscriptionHtml += '<button id="cancel-sub-btn" class="portal-link" style="background:#dc2626;margin-top:8px;border:none;cursor:pointer;font-size:1rem;color:#fff;width:100%;padding:12px;border-radius:8px;font-weight:700">'
        + (sub.status === 'trialing' ? 'Cancel Trial (Immediate)' : 'Cancel Subscription')
        + '</button>';
      subscriptionHtml += '<p id="cancel-msg" style="display:none;margin-top:8px;font-size:0.85rem;text-align:center"></p>';
    }
    subscriptionHtml += '</div>';
  } else {
    subscriptionHtml = '<div class="card"><h2>Subscription</h2><p style="color:var(--muted)">No active subscription yet.</p><a href="/#pricing" class="portal-link">Start a free trial</a></div>';
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Dashboard — OrbioLabs</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root { --brand: #3b82f6; --brand-dark: #2563eb; --bg: #0f172a; --surface: #1e293b; --border: #334155; --text: #f1f5f9; --muted: #94a3b8; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
    a { color: var(--brand); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .top-nav { display: flex; align-items: center; justify-content: space-between; padding: 16px 40px; border-bottom: 1px solid var(--border); }
    .logo { font-size: 1.25rem; font-weight: 800; letter-spacing: -0.5px; color: var(--text); text-decoration: none; }
    .logo span { color: var(--brand); }
    .nav-right { display: flex; align-items: center; gap: 16px; }
    .nav-user { color: var(--muted); font-size: 0.875rem; }
    .signout-btn { background: none; border: 1px solid var(--border); color: var(--muted); padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 0.875rem; }
    .signout-btn:hover { border-color: var(--muted); color: var(--text); }

    /* Tab navigation */
    .tab-nav { display: flex; gap: 0; border-bottom: 1px solid var(--border); padding: 0 40px; background: var(--surface); }
    .tab-btn { padding: 14px 24px; font-size: 0.9rem; font-weight: 600; color: var(--muted); background: none; border: none; cursor: pointer; border-bottom: 2px solid transparent; transition: color 0.2s, border-color 0.2s; }
    .tab-btn:hover { color: var(--text); }
    .tab-btn.active { color: var(--brand); border-bottom-color: var(--brand); }

    /* Tab content */
    .tab-content { display: none; }
    .tab-content.active { display: block; }

    .dashboard { max-width: 760px; margin: 32px auto; padding: 0 24px; }
    h1 { font-size: 1.5rem; font-weight: 800; margin-bottom: 20px; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 24px; margin-bottom: 20px; }
    .card h2 { font-size: 1.125rem; font-weight: 700; margin-bottom: 16px; }
    .status-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
    .status-row:last-of-type { border: none; }
    .status-label { color: var(--muted); }
    .status-value { font-weight: 600; }
    .portal-link { display: block; width: 100%; text-align: center; padding: 12px; background: var(--brand); color: #fff; border-radius: 8px; font-weight: 700; margin-top: 20px; text-decoration: none; }
    .portal-link:hover { background: var(--brand-dark); text-decoration: none; }

    /* Audit form */
    #audit-form { display: flex; gap: 10px; margin-bottom: 16px; }
    #audit-form input[type="url"] { flex: 1; padding: 12px 16px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 1rem; outline: none; }
    #audit-form input[type="url"]:focus { border-color: var(--brand); }
    #audit-form input[type="url"]::placeholder { color: var(--muted); }
    #audit-form button { padding: 12px 24px; background: var(--brand); color: #fff; border: none; border-radius: 8px; font-size: 1rem; font-weight: 700; cursor: pointer; white-space: nowrap; }
    #audit-form button:hover { background: var(--brand-dark); }
    #audit-form button:disabled { opacity: 0.6; cursor: default; }
    #audit-error { display: none; margin-top: 8px; font-size: 0.9rem; color: #f87171; font-weight: 600; }
    #audit-results { display: none; margin-top: 20px; }
    .score-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin-bottom: 20px; }
    .score-card { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 16px; text-align: center; }
    .score-value { font-size: 2rem; font-weight: 800; line-height: 1; }
    .score-label { font-size: 0.75rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }
    .score-good { color: #4ade80; }
    .score-mid { color: #facc15; }
    .score-bad { color: #f87171; }
    .report-links { display: flex; gap: 10px; margin-top: 16px; }
    .report-links a { flex: 1; text-align: center; padding: 10px; border-radius: 8px; font-weight: 600; font-size: 0.9rem; text-decoration: none; }
    .report-links .btn-primary { background: var(--brand); color: #fff; }
    .report-links .btn-outline { border: 1px solid var(--border); color: var(--text); }
    .issues-list { margin-top: 12px; }
    .issue-item { display: flex; align-items: flex-start; gap: 8px; padding: 6px 0; font-size: 0.85rem; color: var(--muted); }
    .issue-fail { color: #f87171; }
    .issue-pass { color: #4ade80; }

    /* Reports table */
    .reports-table { width: 100%; border-collapse: collapse; }
    .reports-table th { text-align: left; font-size: 0.8rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
    .reports-table td { padding: 12px; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
    .reports-table tr:last-child td { border-bottom: none; }
    .reports-table a { color: var(--brand); font-weight: 500; }
    .empty-state { text-align: center; padding: 48px 24px; color: var(--muted); }
    .empty-state p { margin-bottom: 16px; }
    .no-sub-cta { text-align: center; padding: 40px 24px; }
    .no-sub-cta h2 { font-size: 1.25rem; margin-bottom: 12px; }
    .no-sub-cta p { color: var(--muted); margin-bottom: 24px; }
    .cta-btn { display: inline-block; padding: 14px 32px; background: var(--brand); color: #fff; border-radius: 8px; font-weight: 700; text-decoration: none; }
    .cta-btn:hover { background: var(--brand-dark); text-decoration: none; }
  </style>
</head>
<body>
<div class="top-nav">
  <a href="/" style="text-decoration:none"><div class="logo">Orbio<span>Labs</span></div></a>
  <div class="nav-right">
    <span class="nav-user">${user.username}</span>
    <button class="signout-btn" onclick="fetch('/auth/signout',{method:'POST'}).then(function(){window.location.href='/signin'})">Sign out</button>
  </div>
</div>
<div class="tab-nav">
  <button class="tab-btn active" data-tab="audit">Run Audit</button>
  <button class="tab-btn" data-tab="reports">My Reports</button>
  <button class="tab-btn" data-tab="monitoring">Monitoring</button>
  <button class="tab-btn" data-tab="account">Account</button>
</div>
<div class="dashboard">
  <!-- Tab: Run Audit -->
  <div class="tab-content active" id="tab-audit">
    ${hasActiveSub ? `
    <div class="card">
      <h2>Run an Audit</h2>
      <p style="color:var(--muted);font-size:0.9rem;margin-bottom:16px">Enter a URL to get a full SEO, performance, and accessibility report.</p>
      <form id="audit-form" novalidate>
        <input type="url" name="url" placeholder="https://example.com" required />
        <button type="submit" id="audit-btn">Audit</button>
      </form>
      <div id="audit-error"></div>
      <div id="audit-results">
        <div class="score-grid" id="score-grid"></div>
        <div id="issues-container"></div>
        <div class="report-links" id="report-links"></div>
      </div>
    </div>
    ` : `
    <div class="no-sub-cta">
      <h2>Start auditing your websites</h2>
      <p>Get detailed SEO, performance, and accessibility reports. Start your 14-day free trial to begin.</p>
      <a href="/#pricing" class="cta-btn">Start free trial</a>
    </div>
    `}
  </div>

  <!-- Tab: My Reports -->
  <div class="tab-content" id="tab-reports">
    <div class="card">
      <h2>My Reports</h2>
      <div id="reports-list">
        <p style="color:var(--muted);font-size:0.9rem">Loading reports...</p>
      </div>
    </div>
  </div>

  <!-- Tab: Monitoring -->
  <div class="tab-content" id="tab-monitoring">
    ${hasActiveSub ? `
    <div class="card">
      <h2>Site Monitoring</h2>
      <p style="color:var(--muted);font-size:0.9rem;margin-bottom:16px">Track your sites over time. Get alerts when scores drop, issues appear, or competitors overtake you.</p>
      <div id="monitor-add" style="margin-bottom:20px">
        <div style="display:flex;gap:10px;margin-bottom:10px">
          <input type="url" id="monitor-url" placeholder="https://example.com" style="flex:1;padding:12px 16px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:1rem;outline:none" />
          <select id="monitor-freq" style="padding:12px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:0.9rem">
            <option value="daily">Daily</option>
            <option value="weekly" selected>Weekly</option>
            <option value="biweekly">Biweekly</option>
            <option value="monthly">Monthly</option>
          </select>
          <button id="monitor-add-btn" style="padding:12px 24px;background:var(--brand);color:#fff;border:none;border-radius:8px;font-size:1rem;font-weight:700;cursor:pointer;white-space:nowrap">Add Site</button>
        </div>
        <div id="monitor-comp" style="margin-bottom:8px">
          <input type="url" id="monitor-comp1" placeholder="Competitor URL 1 (optional)" style="width:100%;padding:8px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:0.85rem;margin-bottom:4px" />
          <input type="url" id="monitor-comp2" placeholder="Competitor URL 2 (optional)" style="width:100%;padding:8px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:0.85rem;margin-bottom:4px" />
          <input type="url" id="monitor-comp3" placeholder="Competitor URL 3 (optional)" style="width:100%;padding:8px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:0.85rem" />
        </div>
        <div id="monitor-error" style="display:none;color:#f87171;font-size:0.9rem;font-weight:600;margin-top:8px"></div>
      </div>
      <div id="monitored-sites-list"><p style="color:var(--muted);font-size:0.9rem">Loading...</p></div>
    </div>
    <div class="card" id="monitoring-detail-card" style="display:none">
      <h2 id="detail-site-title">Site Details</h2>
      <div id="detail-trends" style="margin-bottom:16px"></div>
      <div id="detail-snapshots"></div>
      <div style="margin-top:16px">
        <button id="generate-roadmap-btn" style="padding:12px 24px;background:#10b981;color:#fff;border:none;border-radius:8px;font-size:1rem;font-weight:700;cursor:pointer">Generate AI Roadmap</button>
      </div>
      <div id="roadmap-display" style="display:none;margin-top:20px"></div>
    </div>
    ` : `
    <div class="no-sub-cta">
      <h2>Monitor your sites 24/7</h2>
      <p>Track SEO changes, get alerts for score drops, and receive AI-powered improvement roadmaps. Available on the Pro plan.</p>
      <a href="/#pricing" class="cta-btn">Start free trial</a>
    </div>
    `}
  </div>

  <!-- Tab: Account -->
  <div class="tab-content" id="tab-account">
    <div class="card">
      <h2>Account</h2>
      <div class="status-row"><span class="status-label">Username</span><span class="status-value">${user.username}</span></div>
      <div class="status-row"><span class="status-label">Email</span><span class="status-value">${user.email || '—'}</span></div>
    </div>
    ${subscriptionHtml}
  </div>
</div>
<script>
(function(){
  // Tab switching
  var tabs = document.querySelectorAll('.tab-btn');
  var contents = document.querySelectorAll('.tab-content');
  tabs.forEach(function(tab){
    tab.addEventListener('click', function(){
      tabs.forEach(function(t){ t.classList.remove('active'); });
      contents.forEach(function(c){ c.classList.remove('active'); });
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      // Load reports on first visit to reports tab
      if(tab.dataset.tab === 'reports' && !window._reportsLoaded){
        window._reportsLoaded = true;
        loadReports();
      }
      if(tab.dataset.tab === 'monitoring' && !monitorLoaded && typeof loadMonitoredSites === 'function'){
        monitorLoaded = true;
        loadMonitoredSites();
      }
    });
  });

  // Load reports
  function loadReports(){
    var container = document.getElementById('reports-list');
    fetch('/api/my-reports')
      .then(function(r){ return r.json(); })
      .then(function(data){
        if(!data.reports || data.reports.length === 0){
          container.innerHTML = '<div class="empty-state"><p>No reports yet.</p><p>Run your first audit to see results here.</p></div>';
          return;
        }
        var html = '<table class="reports-table"><thead><tr><th>URL</th><th>Date</th><th>Actions</th></tr></thead><tbody>';
        data.reports.forEach(function(r){
          var d = new Date(r.createdAt);
          var dateStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
          var shortUrl = r.url.replace(/^https?:\\/\\//, '').slice(0, 40);
          html += '<tr><td title="' + r.url.replace(/"/g,'&quot;') + '">' + shortUrl + '</td><td style="white-space:nowrap;color:var(--muted)">' + dateStr + '</td><td><a href="/report/' + r.id + '" target="_blank">View</a></td></tr>';
        });
        html += '</tbody></table>';
        container.innerHTML = html;
      })
      .catch(function(){
        container.innerHTML = '<p style="color:#f87171">Failed to load reports.</p>';
      });
  }

  ${hasActiveSub ? `
  // Audit form
  var form = document.getElementById('audit-form');
  var btn = document.getElementById('audit-btn');
  var errEl = document.getElementById('audit-error');
  var resultsEl = document.getElementById('audit-results');
  function scoreClass(s){if(s>=80)return"score-good";if(s>=50)return"score-mid";return"score-bad";}
  function esc(s){var d=document.createElement("div");d.textContent=s;return d.innerHTML;}
  form.addEventListener('submit', function(e){
    e.preventDefault();
    var url = form.elements["url"].value.trim();
    if(!url) return;
    btn.disabled=true; btn.textContent="Auditing…";
    errEl.style.display="none"; resultsEl.style.display="none";
    var ac=typeof AbortController!=="undefined"?new AbortController():null;
    var to=setTimeout(function(){if(ac)ac.abort();},30000);
    fetch("/audit",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:url}),signal:ac?ac.signal:undefined})
    .then(function(r){return r.json()})
    .then(function(data){
      clearTimeout(to);
      btn.disabled=false; btn.textContent="Audit";
      if(data.error && !data.scores){errEl.textContent=data.detail||data.error;errEl.style.display="block";return;}
      var s=data.scores;
      document.getElementById("score-grid").innerHTML=
        [{l:"Overall",v:s.overall},{l:"SEO",v:s.seo},{l:"Performance",v:s.performance},{l:"Accessibility",v:s.accessibility}]
        .map(function(x){return '<div class="score-card"><div class="score-value '+scoreClass(x.v)+'">'+x.v+'</div><div class="score-label">'+x.l+'</div></div>'}).join("");
      var ic=document.getElementById("issues-container");
      var sections=[{t:"SEO",d:data.seo},{t:"Performance",d:data.performance},{t:"Accessibility",d:data.accessibility}];
      ic.innerHTML=sections.map(function(sec){
        var items="";
        if(sec.d.issues&&sec.d.issues.length)items+=sec.d.issues.map(function(i){return '<div class="issue-item"><span class="issue-fail">&#10007;</span> '+esc(i)+'</div>'}).join("");
        if(sec.d.passes&&sec.d.passes.length)items+=sec.d.passes.slice(0,3).map(function(p){return '<div class="issue-item"><span class="issue-pass">&#10003;</span> '+esc(p)+'</div>'}).join("");
        return '<div style="margin-bottom:12px"><h3 style="font-size:0.9rem;font-weight:700;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--border)">'+sec.t+" ("+sec.d.score+"/100)</h3>"+items+"</div>"
      }).join("");
      var rl=document.getElementById("report-links");
      rl.innerHTML=data.reportUrl?
        '<a href="'+data.reportUrl+'" target="_blank" class="btn-primary">View full report</a>'+
        (data.pdfUrl?'<a href="'+data.pdfUrl+'" class="btn-outline">Download PDF</a>':""):"";
      resultsEl.style.display="block";
      // Invalidate reports cache so next tab visit reloads
      window._reportsLoaded = false;
    })
    .catch(function(){clearTimeout(to);btn.disabled=false;btn.textContent="Audit";errEl.textContent="Something went wrong. Please try again.";errEl.style.display="block";});
  });
  ` : ''}

  // --- Monitoring Tab Logic ---
  ${hasActiveSub ? `
  var monitorLoaded = false;
  function loadMonitoredSites() {
    var container = document.getElementById('monitored-sites-list');
    fetch('/monitor/sites').then(function(r){ return r.json(); }).then(function(sites) {
      if (!Array.isArray(sites) || sites.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>No monitored sites yet.</p><p>Add a URL above to start tracking.</p></div>';
        return;
      }
      var html = '<table class="reports-table"><thead><tr><th>Site</th><th>Frequency</th><th>Score</th><th>Status</th><th></th></tr></thead><tbody>';
      sites.forEach(function(s) {
        var shortUrl = s.url.replace(/^https?:\\\\/\\\\//, '').slice(0, 35);
        var score = s.latestSnapshot ? s.latestSnapshot.overallScore : '—';
        var scoreClass = s.latestSnapshot ? (s.latestSnapshot.overallScore >= 80 ? 'score-good' : s.latestSnapshot.overallScore >= 50 ? 'score-mid' : 'score-bad') : '';
        var status = s.enabled ? '<span style="color:#4ade80">Active</span>' : '<span style="color:var(--muted)">Paused</span>';
        html += '<tr><td title="' + s.url.replace(/"/g,'&quot;') + '">' + shortUrl + '</td>';
        html += '<td style="color:var(--muted);text-transform:capitalize">' + s.frequency + '</td>';
        html += '<td><span class="' + scoreClass + '" style="font-weight:700">' + score + '</span></td>';
        html += '<td>' + status + '</td>';
        html += '<td style="white-space:nowrap"><a href="#" onclick="viewSiteDetail(\\'' + s.id + '\\');return false">Details</a> &nbsp; <a href="#" style="color:#f87171" onclick="deleteSite(\\'' + s.id + '\\');return false">Remove</a></td></tr>';
      });
      html += '</tbody></table>';
      container.innerHTML = html;
    }).catch(function() {
      container.innerHTML = '<p style="color:#f87171">Failed to load monitored sites.</p>';
    });
  }

  // Add site
  var addBtn = document.getElementById('monitor-add-btn');
  if (addBtn) {
    addBtn.addEventListener('click', function() {
      var url = document.getElementById('monitor-url').value.trim();
      var freq = document.getElementById('monitor-freq').value;
      var errEl = document.getElementById('monitor-error');
      if (!url) { errEl.textContent = 'Please enter a URL'; errEl.style.display = 'block'; return; }
      var competitors = [1,2,3].map(function(n) { return document.getElementById('monitor-comp' + n).value.trim(); }).filter(Boolean);
      addBtn.disabled = true; addBtn.textContent = 'Adding...';
      errEl.style.display = 'none';
      fetch('/monitor/sites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url, frequency: freq, competitorUrls: competitors })
      }).then(function(r) { return r.json().then(function(d) { return r.ok ? d : Promise.reject(d); }); })
        .then(function() {
          document.getElementById('monitor-url').value = '';
          [1,2,3].forEach(function(n) { document.getElementById('monitor-comp' + n).value = ''; });
          addBtn.disabled = false; addBtn.textContent = 'Add Site';
          loadMonitoredSites();
        })
        .catch(function(err) {
          errEl.textContent = (err && err.error) || 'Failed to add site';
          errEl.style.display = 'block';
          addBtn.disabled = false; addBtn.textContent = 'Add Site';
        });
    });
  }

  window.deleteSite = function(id) {
    if (!confirm('Remove this site from monitoring?')) return;
    fetch('/monitor/sites/' + id, { method: 'DELETE' }).then(function() { loadMonitoredSites(); });
  };

  window.viewSiteDetail = function(id) {
    var card = document.getElementById('monitoring-detail-card');
    card.style.display = 'block';
    document.getElementById('detail-trends').innerHTML = '<p style="color:var(--muted)">Loading trends...</p>';
    document.getElementById('detail-snapshots').innerHTML = '';
    document.getElementById('roadmap-display').style.display = 'none';

    // Load trends
    fetch('/monitor/sites/' + id + '/trends').then(function(r){ return r.json(); }).then(function(data) {
      document.getElementById('detail-site-title').textContent = data.url || 'Site Details';
      if (!data.trends || data.trends.length === 0) {
        document.getElementById('detail-trends').innerHTML = '<p style="color:var(--muted)">No trend data yet. Scores will appear after the first monitoring audit runs.</p>';
        return;
      }
      // Render simple sparkline-style trend display
      var html = '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px">';
      var latest = data.trends[data.trends.length - 1];
      [{l:'Overall',k:'overallScore'},{l:'SEO',k:'seoScore'},{l:'Performance',k:'performanceScore'},{l:'Accessibility',k:'accessibilityScore'}].forEach(function(cat) {
        var val = latest[cat.k];
        var cls = val >= 80 ? 'score-good' : val >= 50 ? 'score-mid' : 'score-bad';
        html += '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;text-align:center">';
        html += '<div class="' + cls + '" style="font-size:1.5rem;font-weight:800">' + val + '</div>';
        html += '<div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase">' + cat.l + '</div>';
        // Mini trend line
        if (data.trends.length > 1) {
          var vals = data.trends.map(function(t){ return t[cat.k]; });
          var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
          var range = max - min || 1;
          var points = vals.map(function(v, i) { return (i * 60 / (vals.length - 1)) + ',' + (30 - ((v - min) / range) * 28); }).join(' ');
          html += '<svg viewBox="0 0 60 32" style="width:100%;height:20px;margin-top:4px"><polyline points="' + points + '" fill="none" stroke="var(--brand)" stroke-width="1.5"/></svg>';
        }
        html += '</div>';
      });
      html += '</div>';
      document.getElementById('detail-trends').innerHTML = html;
    }).catch(function() {
      document.getElementById('detail-trends').innerHTML = '<p style="color:#f87171">Failed to load trends.</p>';
    });

    // Load history
    fetch('/monitor/sites/' + id + '/history?limit=10').then(function(r){ return r.json(); }).then(function(snapshots) {
      if (!Array.isArray(snapshots) || snapshots.length === 0) {
        document.getElementById('detail-snapshots').innerHTML = '<p style="color:var(--muted)">No audit history yet.</p>';
        return;
      }
      var html = '<h3 style="font-size:0.9rem;font-weight:700;margin-bottom:8px">Audit History</h3>';
      html += '<table class="reports-table"><thead><tr><th>Date</th><th>Overall</th><th>SEO</th><th>Perf</th><th>A11y</th></tr></thead><tbody>';
      snapshots.forEach(function(snap) {
        var d = new Date(snap.createdAt);
        html += '<tr><td style="color:var(--muted);white-space:nowrap">' + d.toLocaleDateString() + '</td>';
        html += '<td style="font-weight:700">' + snap.overallScore + '</td>';
        html += '<td>' + snap.seoScore + '</td><td>' + snap.performanceScore + '</td><td>' + snap.accessibilityScore + '</td></tr>';
      });
      html += '</tbody></table>';
      document.getElementById('detail-snapshots').innerHTML = html;
    }).catch(function() {});

    // Wire up roadmap generation
    var roadmapBtn = document.getElementById('generate-roadmap-btn');
    roadmapBtn.onclick = function() {
      roadmapBtn.disabled = true; roadmapBtn.textContent = 'Generating...';
      fetch('/roadmap/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId: id })
      }).then(function(r){ return r.json().then(function(d){ return r.ok ? d : Promise.reject(d); }); })
        .then(function(roadmap) {
          roadmapBtn.disabled = false; roadmapBtn.textContent = 'Generate AI Roadmap';
          var rm = roadmap.roadmapJson || roadmap;
          var html = '<h3 style="font-size:1rem;font-weight:700;margin-bottom:8px">AI SEO Roadmap</h3>';
          if (rm.summary) html += '<p style="color:var(--muted);font-size:0.9rem;margin-bottom:16px">' + rm.summary + '</p>';
          if (rm.phases) {
            rm.phases.forEach(function(phase) {
              html += '<div style="margin-bottom:16px"><h4 style="font-size:0.9rem;font-weight:700;color:var(--brand);margin-bottom:8px">' + phase.name + ' (' + phase.timeframe + ')</h4>';
              if (phase.actions) {
                phase.actions.forEach(function(action) {
                  html += '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px">';
                  html += '<div style="font-weight:600;margin-bottom:4px">' + action.title + '</div>';
                  if (action.reasoning) html += '<div style="font-size:0.8rem;color:var(--muted);margin-bottom:6px">' + action.reasoning + '</div>';
                  html += '<div style="display:flex;gap:12px;font-size:0.75rem;color:var(--muted)">';
                  if (action.effort_hours) html += '<span>Effort: ' + action.effort_hours + 'h</span>';
                  if (action.impact) html += '<span>Impact: ' + action.impact + '</span>';
                  if (action.category) html += '<span style="text-transform:capitalize">' + action.category + '</span>';
                  html += '</div></div>';
                });
              }
              html += '</div>';
            });
          }
          document.getElementById('roadmap-display').innerHTML = html;
          document.getElementById('roadmap-display').style.display = 'block';
        })
        .catch(function(err) {
          roadmapBtn.disabled = false; roadmapBtn.textContent = 'Generate AI Roadmap';
          alert((err && err.error) || 'Roadmap generation failed');
        });
    };
  };
  ` : ''}

  // Handle hash-based tab routing
  var hash = window.location.hash.replace('#','');
  if(hash && document.querySelector('[data-tab="'+hash+'"]')){
    document.querySelector('[data-tab="'+hash+'"]').click();
  }

  // Cancel subscription button
  var cancelBtn = document.getElementById('cancel-sub-btn');
  var cancelMsg = document.getElementById('cancel-msg');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', function() {
      if (!confirm('Are you sure you want to cancel your subscription?')) return;
      cancelBtn.disabled = true;
      cancelBtn.textContent = 'Cancelling…';
      fetch('/billing/cancel-subscription', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
        .then(function(r) { return r.json().then(function(d) { return r.ok ? d : Promise.reject(d); }); })
        .then(function(data) {
          cancelMsg.textContent = data.message;
          cancelMsg.style.color = '#10b981';
          cancelMsg.style.display = 'block';
          cancelBtn.style.display = 'none';
          if (data.immediate) { setTimeout(function() { window.location.reload(); }, 2000); }
          else { setTimeout(function() { window.location.reload(); }, 1500); }
        })
        .catch(function(err) {
          cancelMsg.textContent = (err && err.error) || 'Cancellation failed. Please try again.';
          cancelMsg.style.color = '#ef4444';
          cancelMsg.style.display = 'block';
          cancelBtn.disabled = false;
          cancelBtn.textContent = 'Cancel Subscription';
        });
    });
  }
})();
</script>
${appPageAnalyticsSnippet('dashboard')}
${consentBannerSnippet()}
</body>
</html>`);
});

// ── My Reports API ───────────────────────────────────────────────────────────

/**
 * GET /api/my-reports
 * Returns JSON array of the logged-in user's recent audit reports.
 */
app.get('/api/my-reports', (req, res) => {
  const sessionToken = req.cookies && req.cookies.session;
  if (!sessionToken) return res.status(401).json({ error: 'Not authenticated' });
  const user = db.getUserBySessionToken(sessionToken);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const reports = db.getReportsByUser(user.id);
  return res.json({ reports });
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
 * If the user has an active session (signed up before checkout), links the
 * subscription API key to their user account and redirects to dashboard.
 */
app.get('/billing/trial/success', async (req, res) => {
  let apiKey = null;
  let customerEmail = null;
  try {
    const result = await fulfillCheckoutSession(req.query.session_id);
    if (result && result.apiKey) {
      apiKey = result.apiKey;
    }
    if (result && result.email) {
      customerEmail = result.email;
    }
  } catch (err) {
    console.error('[billing/trial/success] session retrieval failed:', err.message);
  }

  // If the user has a session cookie, link the API key to their account
  const sessionToken = req.cookies && req.cookies.session;
  if (sessionToken && apiKey) {
    const user = db.getUserBySessionToken(sessionToken);
    if (user) {
      db.linkUserApiKey(user.id, apiKey);
      return res.redirect('/dashboard');
    }
  }

  // Look up existing user by email from Stripe session and auto-login
  if (apiKey && customerEmail) {
    const existingUser = db.getUserByEmail(customerEmail);
    if (existingUser) {
      db.linkUserApiKey(existingUser.id, apiKey);
      const newSessionToken = crypto.randomBytes(32).toString('hex');
      db.updateUserSession(existingUser.id, newSessionToken);
      res.cookie('session', newSessionToken, cookieOpts({ maxAge: 30 * 24 * 60 * 60 * 1000 }));
      return res.redirect('/dashboard');
    }
  }

  // No session and no email match: store the API key in a short-lived cookie
  // and redirect to signup so the user creates an account first.
  if (apiKey) {
    res.cookie('pending_trial_key', apiKey, cookieOpts({ maxAge: 30 * 60 * 1000, httpOnly: true }));
  }
  return res.redirect('/signup?trial_started=1');
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
  let apiKey = null;
  let customerEmail = null;
  try {
    const result = await fulfillCheckoutSession(req.query.session_id);
    if (result && result.apiKey) {
      apiKey = result.apiKey;
    }
    if (result && result.email) {
      customerEmail = result.email;
    }
  } catch (err) {
    console.error('[billing/success] session retrieval failed:', err.message);
  }

  // Link API key to logged-in user if they have a session
  const sessionToken = req.cookies && req.cookies.session;
  if (sessionToken && apiKey) {
    const user = db.getUserBySessionToken(sessionToken);
    if (user) {
      db.linkUserApiKey(user.id, apiKey);
      return res.redirect('/dashboard');
    }
  }

  // Look up existing user by email from Stripe session and auto-login
  if (apiKey && customerEmail) {
    const existingUser = db.getUserByEmail(customerEmail);
    if (existingUser) {
      db.linkUserApiKey(existingUser.id, apiKey);
      const newSessionToken = crypto.randomBytes(32).toString('hex');
      db.updateUserSession(existingUser.id, newSessionToken);
      res.cookie('session', newSessionToken, cookieOpts({ maxAge: 30 * 24 * 60 * 60 * 1000 }));
      return res.redirect('/dashboard');
    }
  }

  // Fallback for users without a session or matching account
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const apiKeyHtml = apiKey
    ? `<p>Your API key:</p><p><code>${apiKey}</code></p><p>Save this key — you'll need it to authenticate API requests.</p><p><a href="/signup">Create an account</a> to manage your subscription.</p>`
    : '<p>Your subscription is being activated. <a href="/signup">Create an account</a> to get started.</p>';
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
 * POST /billing/cancel-subscription
 * Cancels the user's subscription with policy-aware behaviour:
 *   - Trial users → immediate cancellation, access revoked now
 *   - Paid users  → cancel at end of current billing period
 * Accepts { apiKey } in body or resolves from session cookie.
 */
app.post('/billing/cancel-subscription', async (req, res) => {
  let apiKey = req.body && req.body.apiKey;

  // Fall back to session cookie
  if (!apiKey) {
    const sessionToken = req.cookies && req.cookies.session;
    if (sessionToken) {
      const user = db.getUserBySessionToken(sessionToken);
      if (user && user.api_key) apiKey = user.api_key;
    }
  }

  if (!apiKey) {
    return res.status(401).json({ error: 'Unauthorized. Sign in or provide an API key.' });
  }

  const sub = lookupSubscription(apiKey);
  if (!sub) {
    return res.status(404).json({ error: 'Subscription not found.' });
  }

  if (sub.status === 'cancelled') {
    return res.status(400).json({ error: 'Subscription is already cancelled.' });
  }
  if (sub.status === 'cancelling') {
    return res.status(400).json({ error: 'Subscription is already scheduled for cancellation at the end of your billing period.' });
  }

  try {
    const result = await cancelSubscription(apiKey);
    if (result.immediate) {
      return res.json({
        ok: true,
        message: 'Your trial has been cancelled and access has been revoked immediately.',
        immediate: true,
      });
    }
    const endDate = result.currentPeriodEnd
      ? new Date(result.currentPeriodEnd * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      : 'the end of your current billing period';
    return res.json({
      ok: true,
      message: `Your subscription will be cancelled at the end of your billing period (${endDate}). You retain full access until then.`,
      immediate: false,
      accessUntil: endDate,
    });
  } catch (err) {
    console.error('[billing/cancel-subscription error]', err);
    return res.status(500).json({ error: 'Cancellation failed. Please try again or contact support.', detail: err.message });
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
    // Resolve user ID from session for report history
    const _sessionToken = req.cookies && req.cookies.session;
    const _sessionUser = _sessionToken ? db.getUserBySessionToken(_sessionToken) : null;
    db.saveReportMeta({ id: reportId, url: targetUrl, storageKey, audit, userId: _sessionUser ? _sessionUser.id : null });

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

/**
 * POST /audit/site
 * Multi-page site crawl + audit. Crawls internal links and returns site-wide
 * structural analysis including orphan pages, duplicate content, and indexation gaps.
 * Body: { url: string, maxPages?: number }
 */
app.post('/audit/site', allowFreeTier, async (req, res) => {
  const { url, maxPages } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing required field: url' });
  }

  let targetUrl = url.trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }

  try {
    // Run single-page audit + site crawl in parallel
    const [audit, crawl] = await Promise.all([
      auditUrl(targetUrl),
      crawlSite(targetUrl, { maxPages: Math.min(maxPages || 25, 50) }),
    ]);

    // Track usage
    if (req.subscription?.apiKey) {
      db.incrementAuditCount(req.subscription.apiKey);
      db.incrementMonthlyAuditCount(req.subscription.apiKey);
    }
    trackServerEvent('audit_run', { format: 'site_crawl' }, req).catch(() => {});

    const trialInfo = req.subscription ? getTrialInfo(req.subscription) : null;
    return res.json({ audit, crawl, trial: trialInfo });
  } catch (err) {
    console.error('[site audit error]', err);
    return res.status(500).json({ error: 'Site audit failed', detail: err.message });
  }
});

/**
 * POST /audit/competitors
 * Competitor benchmarking. Compares the target domain against 3-5 competitors.
 * Body: { url: string, competitors: string[] }
 */
app.post('/audit/competitors', allowFreeTier, async (req, res) => {
  const { url, competitors } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing required field: url' });
  }
  if (!competitors || !Array.isArray(competitors) || competitors.length === 0) {
    return res.status(400).json({ error: 'Missing required field: competitors (array of domain URLs)' });
  }
  if (competitors.length > 5) {
    return res.status(400).json({ error: 'Maximum 5 competitor domains allowed' });
  }

  let targetUrl = url.trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }

  try {
    const result = await benchmarkCompetitors(targetUrl, competitors);

    if (req.subscription?.apiKey) {
      db.incrementAuditCount(req.subscription.apiKey);
      db.incrementMonthlyAuditCount(req.subscription.apiKey);
    }
    trackServerEvent('audit_run', { format: 'competitor_benchmark' }, req).catch(() => {});

    const trialInfo = req.subscription ? getTrialInfo(req.subscription) : null;
    return res.json({ ...result, trial: trialInfo });
  } catch (err) {
    console.error('[competitor benchmark error]', err);
    return res.status(500).json({ error: 'Competitor benchmark failed', detail: err.message });
  }
});

/**
 * Middleware: require Pro plan for Tier 2 features.
 * In dev mode (no Stripe), allows all requests through.
 */
function requireProPlan(req, res, next) {
  if (!process.env.STRIPE_SECRET_KEY) return next();
  const sub = req.subscription;
  if (!sub) return next();
  if (sub.planTier === 'starter') {
    const appUrl = process.env.APP_URL || '';
    return res.status(402).json({
      error: 'Pro plan required',
      detail: 'Keyword mapping, content gap analysis, and ROI insights are available on the Pro plan.',
      plan: 'starter',
      upgradeUrl: `${appUrl}/billing/checkout?tier=pro`,
    });
  }
  next();
}

/**
 * POST /audit/keywords
 * Keyword opportunity mapping. Surfaces pages ranking in positions 8-20
 * that are worth optimizing. Pro plan only.
 * Body: { url: string, maxKeywords?: number }
 */
app.post('/audit/keywords', requireActiveSubscription, requireProPlan, async (req, res) => {
  const { url, maxKeywords } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing required field: url' });
  }

  let targetUrl = url.trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }

  try {
    const result = await mapKeywordOpportunities(targetUrl, null, { maxKeywords });

    if (req.subscription?.apiKey) {
      db.incrementAuditCount(req.subscription.apiKey);
      db.incrementMonthlyAuditCount(req.subscription.apiKey);
    }
    trackServerEvent('audit_run', { format: 'keyword_mapping' }, req).catch(() => {});

    const trialInfo = req.subscription ? getTrialInfo(req.subscription) : null;
    return res.json({ ...result, trial: trialInfo });
  } catch (err) {
    console.error('[keyword mapping error]', err);
    return res.status(500).json({ error: 'Keyword mapping failed', detail: err.message });
  }
});

/**
 * POST /audit/content-gaps
 * Content gap analysis. Identifies topics competitors rank for that the
 * target site does not cover. Pro plan only.
 * Body: { url: string, competitors: string[], maxGaps?: number }
 */
app.post('/audit/content-gaps', requireActiveSubscription, requireProPlan, async (req, res) => {
  const { url, competitors, maxGaps } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing required field: url' });
  }
  if (!competitors || !Array.isArray(competitors) || competitors.length === 0) {
    return res.status(400).json({ error: 'Missing required field: competitors (array of domain URLs)' });
  }
  if (competitors.length > 5) {
    return res.status(400).json({ error: 'Maximum 5 competitor domains allowed' });
  }

  let targetUrl = url.trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }

  try {
    const result = await analyzeContentGaps(targetUrl, competitors, null, { maxGaps });

    if (req.subscription?.apiKey) {
      db.incrementAuditCount(req.subscription.apiKey);
      db.incrementMonthlyAuditCount(req.subscription.apiKey);
    }
    trackServerEvent('audit_run', { format: 'content_gap_analysis' }, req).catch(() => {});

    const trialInfo = req.subscription ? getTrialInfo(req.subscription) : null;
    return res.json({ ...result, trial: trialInfo });
  } catch (err) {
    console.error('[content gap analysis error]', err);
    return res.status(500).json({ error: 'Content gap analysis failed', detail: err.message });
  }
});

/**
 * POST /audit/full
 * Full audit: single-page audit + site crawl + competitor benchmarking.
 * Pro plan users also get: keyword mapping, content gap analysis, ROI framing.
 * Body: { url: string, competitors?: string[], maxPages?: number, format?: 'json'|'html', industry?: string }
 */
app.post('/audit/full', allowFreeTier, async (req, res) => {
  const { url, competitors = [], maxPages, format = 'json', industry } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing required field: url' });
  }

  let targetUrl = url.trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }

  // Determine if this user has Pro plan features
  const isProPlan = !process.env.STRIPE_SECRET_KEY || (req.subscription && req.subscription.planTier !== 'starter');

  try {
    const tasks = [
      auditUrl(targetUrl),
      crawlSite(targetUrl, { maxPages: Math.min(maxPages || 25, 50) }),
    ];
    if (competitors.length > 0) {
      tasks.push(benchmarkCompetitors(targetUrl, competitors.slice(0, 5)));
    }

    const results = await Promise.all(tasks);
    const audit = results[0];
    const crawl = results[1];
    const competitor = results[2] || null;

    // Tier 2: keyword mapping, content gap analysis, ROI framing (Pro plan only)
    let keywords = null;
    let contentGaps = null;
    let roi = null;

    if (isProPlan) {
      const tier2Tasks = [
        mapKeywordOpportunities(targetUrl, crawl).catch(err => {
          console.error('[full audit] keyword mapping error:', err.message);
          return null;
        }),
      ];
      if (competitors.length > 0) {
        tier2Tasks.push(
          analyzeContentGaps(targetUrl, competitors.slice(0, 5), crawl).catch(err => {
            console.error('[full audit] content gap error:', err.message);
            return null;
          })
        );
      }

      const tier2Results = await Promise.all(tier2Tasks);
      keywords = tier2Results[0];
      contentGaps = tier2Results[1] || null;

      // ROI framing wraps everything together
      roi = frameRoi(audit, { crawl, competitor, keywords, contentGaps }, { industry });
    }

    // Generate enhanced HTML report if requested
    if (format === 'html') {
      const html = generateHtml(audit, { crawl, competitor, keywords, contentGaps, roi });
      const reportId = uuidv4();
      const storageKey = await saveReport(reportId, html);
      const _sessionToken = req.cookies && req.cookies.session;
      const _sessionUser = _sessionToken ? db.getUserBySessionToken(_sessionToken) : null;
      db.saveReportMeta({ id: reportId, url: targetUrl, storageKey, audit, userId: _sessionUser ? _sessionUser.id : null });

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }

    if (req.subscription?.apiKey) {
      db.incrementAuditCount(req.subscription.apiKey);
      db.incrementMonthlyAuditCount(req.subscription.apiKey);
    }
    trackServerEvent('audit_run', { format: 'full_audit' }, req).catch(() => {});

    const trialInfo = req.subscription ? getTrialInfo(req.subscription) : null;
    return res.json({ audit, crawl, competitor, keywords, contentGaps, roi, trial: trialInfo });
  } catch (err) {
    console.error('[full audit error]', err);
    return res.status(500).json({ error: 'Full audit failed', detail: err.message });
  }
});

// ── Monitoring API (Pro plan required) ────────────────────────────────────────

/** Resolve user from session cookie — returns user row or null. */
function resolveSessionUser(req) {
  const sessionToken = req.cookies && req.cookies.session;
  if (!sessionToken) return null;
  return db.getUserBySessionToken(sessionToken) || null;
}

/** POST /monitor/sites — Create a monitored site */
app.post('/monitor/sites', requireActiveSubscription, requireProPlan, (req, res) => {
  const user = resolveSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  const { url, frequency, competitorUrls, notifyOn } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing required field: url' });
  }

  // Enforce per-user limit
  const count = db.countUserMonitoredSites(user.id);
  if (count >= MAX_SITES_PER_USER) {
    return res.status(400).json({
      error: `Maximum ${MAX_SITES_PER_USER} monitored sites allowed`,
      current: count,
    });
  }

  const validFreqs = ['daily', 'weekly', 'biweekly', 'monthly'];
  const freq = validFreqs.includes(frequency) ? frequency : 'weekly';
  const competitors = Array.isArray(competitorUrls) ? competitorUrls.slice(0, 3) : [];

  const id = uuidv4();
  db.createMonitoredSite({
    id,
    userId: user.id,
    url: url.trim(),
    frequency: freq,
    competitorUrls: competitors,
    notifyOn: notifyOn || undefined,
  });

  const site = db.getMonitoredSite(id);
  res.status(201).json(site);
});

/** GET /monitor/sites — List user's monitored sites */
app.get('/monitor/sites', requireActiveSubscription, requireProPlan, (req, res) => {
  const user = resolveSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  const sites = db.getMonitoredSitesByUser(user.id);
  // Attach latest snapshot summary to each site
  const enriched = sites.map(site => {
    const latest = db.getLatestSnapshot(site.id);
    return {
      ...site,
      latestSnapshot: latest ? {
        overallScore: latest.overallScore,
        seoScore: latest.seoScore,
        performanceScore: latest.performanceScore,
        accessibilityScore: latest.accessibilityScore,
        createdAt: latest.createdAt,
      } : null,
    };
  });
  res.json(enriched);
});

/** PATCH /monitor/sites/:id — Update a monitored site */
app.patch('/monitor/sites/:id', requireActiveSubscription, requireProPlan, (req, res) => {
  const user = resolveSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  const site = db.getMonitoredSite(req.params.id);
  if (!site || site.userId !== user.id) {
    return res.status(404).json({ error: 'Monitored site not found' });
  }

  const { frequency, competitorUrls, notifyOn, enabled } = req.body || {};
  const updated = db.updateMonitoredSite(req.params.id, { frequency, competitorUrls, notifyOn, enabled });
  res.json(updated);
});

/** DELETE /monitor/sites/:id — Remove a monitored site */
app.delete('/monitor/sites/:id', requireActiveSubscription, requireProPlan, (req, res) => {
  const user = resolveSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  const site = db.getMonitoredSite(req.params.id);
  if (!site || site.userId !== user.id) {
    return res.status(404).json({ error: 'Monitored site not found' });
  }

  db.deleteMonitoredSite(req.params.id);
  res.json({ deleted: true });
});

/** GET /monitor/sites/:id/history — Get audit snapshots for a site */
app.get('/monitor/sites/:id/history', requireActiveSubscription, requireProPlan, (req, res) => {
  const user = resolveSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  const site = db.getMonitoredSite(req.params.id);
  if (!site || site.userId !== user.id) {
    return res.status(404).json({ error: 'Monitored site not found' });
  }

  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const snapshots = db.getSnapshotsBySite(req.params.id, limit);
  res.json(snapshots);
});

/** GET /monitor/sites/:id/trends — Get score trends (chart-ready) */
app.get('/monitor/sites/:id/trends', requireActiveSubscription, requireProPlan, (req, res) => {
  const user = resolveSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  const site = db.getMonitoredSite(req.params.id);
  if (!site || site.userId !== user.id) {
    return res.status(404).json({ error: 'Monitored site not found' });
  }

  const trends = db.getTrendsBySite(req.params.id);
  res.json({ siteId: req.params.id, url: site.url, trends });
});

// ── Roadmap API (Pro plan required) ──────────────────────────────────────────

/** POST /roadmap/generate — Generate AI roadmap for a site */
app.post('/roadmap/generate', requireActiveSubscription, requireProPlan, async (req, res) => {
  const user = resolveSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  const { siteId, snapshotId, vertical } = req.body || {};
  if (!siteId) return res.status(400).json({ error: 'Missing required field: siteId' });

  const site = db.getMonitoredSite(siteId);
  if (!site || site.userId !== user.id) {
    return res.status(404).json({ error: 'Monitored site not found' });
  }

  // Rate limit: 1 roadmap per site per day
  const existingRoadmap = db.getLatestRoadmapBySite(siteId);
  if (existingRoadmap && (Date.now() - existingRoadmap.createdAt) < 24 * 60 * 60 * 1000) {
    return res.json(existingRoadmap);
  }

  // Get snapshot data
  const snapshot = snapshotId
    ? db.getSnapshot(snapshotId)
    : db.getLatestSnapshot(siteId);

  if (!snapshot) {
    return res.status(400).json({ error: 'No audit snapshot available. Run a monitoring audit first.' });
  }

  // Get trend data
  const trends = db.getTrendsBySite(siteId);

  try {
    const { generateRoadmap } = require('./roadmap');
    const roadmap = await generateRoadmap({
      url: site.url,
      snapshot,
      trends: trends.slice(-5),
      competitorScores: snapshot.competitorScores,
      vertical: vertical || null,
    });

    const roadmapId = uuidv4();
    db.saveRoadmap({
      id: roadmapId,
      userId: user.id,
      monitoredSiteId: siteId,
      snapshotId: snapshot.id,
      roadmapJson: roadmap,
      roadmapHtml: '', // TODO: render HTML in Phase 4
      vertical: roadmap.vertical || vertical,
    });

    res.status(201).json(db.getRoadmap(roadmapId));
  } catch (err) {
    console.error('[roadmap] Generation error:', err.message);
    res.status(500).json({ error: 'Roadmap generation failed', detail: err.message });
  }
});

/** GET /roadmap/:id — Get a generated roadmap */
app.get('/roadmap/:id', requireActiveSubscription, requireProPlan, (req, res) => {
  const user = resolveSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  const roadmap = db.getRoadmap(req.params.id);
  if (!roadmap || roadmap.userId !== user.id) {
    return res.status(404).json({ error: 'Roadmap not found' });
  }
  res.json(roadmap);
});

/** GET /roadmap/latest/:siteId — Get most recent roadmap for a monitored site */
app.get('/roadmap/latest/:siteId', requireActiveSubscription, requireProPlan, (req, res) => {
  const user = resolveSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  const site = db.getMonitoredSite(req.params.siteId);
  if (!site || site.userId !== user.id) {
    return res.status(404).json({ error: 'Monitored site not found' });
  }

  const roadmap = db.getLatestRoadmapBySite(req.params.siteId);
  if (!roadmap) {
    return res.status(404).json({ error: 'No roadmap generated yet' });
  }
  res.json(roadmap);
});

// ── Sentry error handler (must be after all routes, before other error handlers)
if (process.env.SENTRY_DSN) {
  app.use(Sentry.expressErrorHandler());
}

// ── Start ─────────────────────────────────────────────────────────────────────

// Start monitoring scheduler
startScheduler();

app.listen(PORT, () => {
  console.log(`OrbioLabs running on http://localhost:${PORT}`);
  console.log(`Try: curl -X POST http://localhost:${PORT}/audit -H 'Content-Type: application/json' -d '{"url":"https://example.com"}'`);
});

module.exports = app; // for testing
