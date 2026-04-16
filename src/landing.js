'use strict';

const { consentBannerSnippet } = require('./consent-banner');
const { landingAnalyticsSnippet } = require('./analytics');

/**
 * Generates the full orbiolab.com landing page HTML.
 * Includes email capture / waitlist form and GDPR consent banner.
 */
function generateLandingPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="OrbioLabs — Automated SEO, performance &amp; accessibility audits. Get actionable reports for any website in seconds." />
  <title>OrbioLabs — Automated Website Audits</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --brand: #3b82f6;
      --brand-dark: #2563eb;
      --bg: #0f172a;
      --surface: #1e293b;
      --border: #334155;
      --text: #f1f5f9;
      --muted: #94a3b8;
    }
    html { scroll-behavior: smooth; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
    }
    a { color: var(--brand); text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* ── Nav ────────────────────────────────────────────────────────────────── */
    nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 20px 40px;
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      background: var(--bg);
      z-index: 100;
    }
    .logo {
      font-size: 1.25rem;
      font-weight: 800;
      letter-spacing: -0.5px;
      color: var(--text);
    }
    .logo span { color: var(--brand); }
    nav .cta-nav {
      background: var(--brand);
      color: #fff;
      padding: 8px 20px;
      border-radius: 6px;
      font-weight: 600;
      font-size: 0.875rem;
      transition: background 0.15s;
    }
    nav .cta-nav:hover { background: var(--brand-dark); text-decoration: none; }
    nav .cta-nav-secondary {
      color: var(--muted);
      font-size: 0.875rem;
      margin-right: 16px;
    }
    nav .cta-nav-secondary:hover { color: var(--text); text-decoration: none; }

    /* ── Hero ───────────────────────────────────────────────────────────────── */
    .hero {
      max-width: 760px;
      margin: 80px auto 64px;
      padding: 0 24px;
      text-align: center;
    }
    .badge {
      display: inline-block;
      background: rgba(59,130,246,0.15);
      color: var(--brand);
      border: 1px solid rgba(59,130,246,0.3);
      border-radius: 99px;
      padding: 4px 14px;
      font-size: 0.8rem;
      font-weight: 600;
      letter-spacing: 0.5px;
      margin-bottom: 24px;
    }
    h1 {
      font-size: clamp(2rem, 5vw, 3.5rem);
      font-weight: 800;
      letter-spacing: -1px;
      line-height: 1.15;
      margin-bottom: 20px;
    }
    h1 em { font-style: normal; color: var(--brand); }
    .hero p {
      font-size: 1.125rem;
      color: var(--muted);
      max-width: 560px;
      margin: 0 auto 40px;
    }

    /* ── Audit form ─────────────────────────────────────────────────────────── */
    #audit-form {
      display: flex;
      gap: 10px;
      justify-content: center;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    #audit-form input[type="url"] {
      flex: 1;
      min-width: 240px;
      max-width: 420px;
      padding: 12px 16px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      font-size: 1rem;
      outline: none;
      transition: border-color 0.15s;
    }
    #audit-form input[type="url"]:focus { border-color: var(--brand); }
    #audit-form input[type="url"]::placeholder { color: var(--muted); }
    #audit-form button {
      padding: 12px 28px;
      background: var(--brand);
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.15s;
    }
    #audit-form button:hover { background: var(--brand-dark); }
    #audit-form button:disabled { opacity: 0.6; cursor: default; }
    .audit-note {
      font-size: 0.8rem;
      color: var(--muted);
    }
    #audit-error {
      display: none;
      margin-top: 12px;
      font-size: 0.9rem;
      color: #f87171;
      font-weight: 600;
    }

    /* ── Audit results ─────────────────────────────────────────────────────── */
    #audit-results {
      display: none;
      max-width: 760px;
      margin: 40px auto;
      padding: 0 24px;
    }
    .results-header {
      text-align: center;
      margin-bottom: 32px;
    }
    .results-header h2 {
      font-size: 1.5rem;
      font-weight: 800;
      margin-bottom: 4px;
    }
    .results-header .audited-url {
      color: var(--brand);
      font-size: 0.9rem;
      word-break: break-all;
    }
    .score-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 16px;
      margin-bottom: 32px;
    }
    .score-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      text-align: center;
    }
    .score-card .score-value {
      font-size: 2.5rem;
      font-weight: 800;
      line-height: 1;
    }
    .score-card .score-label {
      font-size: 0.8rem;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-top: 6px;
    }
    .score-good { color: #4ade80; }
    .score-mid { color: #facc15; }
    .score-bad { color: #f87171; }
    .issues-section {
      margin-bottom: 24px;
    }
    .issues-section h3 {
      font-size: 1rem;
      font-weight: 700;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }
    .issue-item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 8px 0;
      font-size: 0.875rem;
      color: var(--muted);
    }
    .issue-icon { flex-shrink: 0; }
    .issue-fail { color: #f87171; }
    .issue-pass { color: #4ade80; }
    .results-cta {
      text-align: center;
      margin-top: 32px;
      padding: 24px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
    }
    .results-cta p {
      color: var(--muted);
      font-size: 0.9rem;
      margin-bottom: 16px;
    }

    /* ── Waitlist form (kept for compatibility) ────────────────────────────── */
    #waitlist {
      display: flex;
      gap: 10px;
      justify-content: center;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    #waitlist input[type="email"] {
      flex: 1;
      min-width: 240px;
      max-width: 360px;
      padding: 12px 16px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      font-size: 1rem;
      outline: none;
      transition: border-color 0.15s;
    }
    #waitlist input[type="email"]:focus { border-color: var(--brand); }
    #waitlist input[type="email"]::placeholder { color: var(--muted); }
    #waitlist button {
      padding: 12px 28px;
      background: var(--brand);
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.15s;
    }
    #waitlist button:hover { background: var(--brand-dark); }
    #waitlist button:disabled { opacity: 0.6; cursor: default; }
    .waitlist-note {
      font-size: 0.8rem;
      color: var(--muted);
    }
    #waitlist-msg {
      display: none;
      margin-top: 12px;
      font-size: 0.95rem;
      color: #4ade80;
      font-weight: 600;
    }

    /* ── Social proof ───────────────────────────────────────────────────────── */
    .social-proof {
      text-align: center;
      color: var(--muted);
      font-size: 0.8rem;
      letter-spacing: 1px;
      text-transform: uppercase;
      margin: 64px 0 32px;
    }
    .trust-bar {
      display: flex;
      justify-content: center;
      gap: 40px;
      flex-wrap: wrap;
      padding: 0 24px;
    }
    .trust-item {
      text-align: center;
      color: var(--muted);
      font-size: 0.85rem;
    }
    .trust-item .num {
      display: block;
      font-size: 1.75rem;
      font-weight: 800;
      color: var(--text);
    }

    /* ── Features ───────────────────────────────────────────────────────────── */
    .features {
      max-width: 1000px;
      margin: 80px auto;
      padding: 0 24px;
    }
    .features h2 {
      text-align: center;
      font-size: 1.875rem;
      font-weight: 800;
      margin-bottom: 48px;
      letter-spacing: -0.5px;
    }
    .feature-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 24px;
    }
    .feature-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 28px;
    }
    .feature-card .icon {
      font-size: 1.75rem;
      margin-bottom: 12px;
    }
    .feature-card h3 {
      font-size: 1rem;
      font-weight: 700;
      margin-bottom: 8px;
    }
    .feature-card p {
      font-size: 0.875rem;
      color: var(--muted);
      line-height: 1.6;
    }

    /* ── Pricing ────────────────────────────────────────────────────────────── */
    .pricing {
      max-width: 860px;
      margin: 80px auto;
      padding: 0 24px;
      text-align: center;
    }
    .pricing h2 {
      font-size: 1.875rem;
      font-weight: 800;
      margin-bottom: 12px;
      letter-spacing: -0.5px;
    }
    .pricing .pricing-subtitle {
      color: var(--muted);
      font-size: 1rem;
      margin-bottom: 40px;
    }
    .pricing-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      align-items: start;
    }
    @media (max-width: 640px) {
      .pricing-grid { grid-template-columns: 1fr; }
    }
    .price-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 40px 32px;
      position: relative;
    }
    .price-card.featured {
      border-color: var(--brand);
      box-shadow: 0 0 0 1px var(--brand);
    }
    .popular-badge {
      position: absolute;
      top: -12px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--brand);
      color: #fff;
      font-size: 0.75rem;
      font-weight: 700;
      padding: 4px 16px;
      border-radius: 99px;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    .plan-name {
      font-size: 1.1rem;
      font-weight: 700;
      margin-bottom: 8px;
      color: var(--muted);
    }
    .trial-badge {
      display: inline-block;
      background: rgba(74,222,128,0.15);
      color: #4ade80;
      border: 1px solid rgba(74,222,128,0.3);
      border-radius: 99px;
      padding: 4px 14px;
      font-size: 0.8rem;
      font-weight: 700;
      letter-spacing: 0.5px;
      margin-bottom: 16px;
    }
    .price-amount {
      font-size: 3rem;
      font-weight: 800;
      letter-spacing: -2px;
    }
    .price-amount span { font-size: 1.25rem; vertical-align: top; margin-top: 10px; display: inline-block; }
    .price-period { color: var(--muted); font-size: 0.9rem; margin-bottom: 24px; }
    .price-features {
      list-style: none;
      text-align: left;
      margin-bottom: 32px;
    }
    .price-features li {
      padding: 8px 0;
      font-size: 0.9rem;
      border-bottom: 1px solid var(--border);
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .price-features li:last-child { border: none; }
    .price-features .check { color: #4ade80; font-weight: 700; }
    .price-features .x-mark { color: #64748b; font-weight: 700; }
    .btn-trial {
      display: block;
      width: 100%;
      padding: 14px;
      background: var(--brand);
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.15s;
      text-align: center;
      text-decoration: none;
      margin-bottom: 12px;
    }
    .btn-trial:hover { background: var(--brand-dark); text-decoration: none; }
    .btn-trial-outline {
      display: block;
      width: 100%;
      padding: 14px;
      background: transparent;
      color: var(--brand);
      border: 2px solid var(--brand);
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
      text-align: center;
      text-decoration: none;
      margin-bottom: 12px;
    }
    .btn-trial-outline:hover { background: var(--brand); color: #fff; text-decoration: none; }
    .btn-subscribe {
      display: block;
      width: 100%;
      padding: 14px;
      background: var(--brand);
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.15s;
      text-align: center;
      text-decoration: none;
    }
    .btn-subscribe:hover { background: var(--brand-dark); text-decoration: none; }
    .trial-note {
      font-size: 0.8rem;
      color: var(--muted);
      margin-top: 8px;
    }

    /* ── Footer ─────────────────────────────────────────────────────────────── */
    footer {
      border-top: 1px solid var(--border);
      padding: 32px 40px;
      text-align: center;
      color: var(--muted);
      font-size: 0.8rem;
    }
    footer a { color: var(--muted); }
    footer a:hover { color: var(--text); }

    @media (max-width: 640px) {
      nav { padding: 16px 20px; }
      .hero { margin: 48px auto 40px; }
    }
  </style>
</head>
<body>

<!-- ── Navigation ─────────────────────────────────────────────────────────── -->
<nav>
  <div class="logo">Orbio<span>Labs</span></div>
  <div>
    <a href="/signin" class="cta-nav-secondary">Sign in</a>
    <a href="#pricing" class="cta-nav">Start free trial</a>
  </div>
</nav>

<!-- ── Hero ───────────────────────────────────────────────────────────────── -->
<section class="hero" id="audit-section">
  <div class="badge">Try it free · No signup required</div>
  <h1>Automated audits for <em>SEO, performance &amp; accessibility</em></h1>
  <p>OrbioLabs scans any URL and delivers actionable, white-label reports in seconds. Built for agencies, freelancers, and dev teams.</p>

  <form id="audit-form" novalidate>
    <input type="url" name="url" placeholder="https://example.com" required autocomplete="url" />
    <button type="submit" id="audit-btn">Audit this site</button>
  </form>
  <div class="audit-note">Free — up to 3 audits per hour. No account needed.</div>
  <div id="audit-error"></div>
</section>

<!-- ── Audit results (populated by JS) ───────────────────────────────────── -->
<div id="audit-results">
  <div class="results-header">
    <h2>Audit Results</h2>
    <div class="audited-url" id="result-url"></div>
  </div>
  <div class="score-grid" id="score-grid"></div>
  <div id="issues-container"></div>
  <div class="results-cta">
    <p>Want unlimited audits, PDF exports, and API access?</p>
    <a href="#pricing" class="btn-trial">Start 14-day free trial — $0 today</a>
  </div>
</div>

<!-- ── Trust bar ──────────────────────────────────────────────────────────── -->
<div class="social-proof">Trusted by growing teams</div>
<div class="trust-bar">
  <div class="trust-item"><span class="num">60+</span>audit signals</div>
  <div class="trust-item"><span class="num">&lt;10s</span>per report</div>
  <div class="trust-item"><span class="num">PDF</span>white-label export</div>
  <div class="trust-item"><span class="num">14</span>day free trial</div>
</div>

<!-- ── Features ───────────────────────────────────────────────────────────── -->
<section class="features">
  <h2>Everything you need to audit websites at scale</h2>
  <div class="feature-grid">
    <div class="feature-card">
      <div class="icon">🔍</div>
      <h3>SEO analysis</h3>
      <p>Title tags, meta descriptions, canonical URLs, Open Graph, structured data, robots directives, sitemap validation, and more.</p>
    </div>
    <div class="feature-card">
      <div class="icon">⚡</div>
      <h3>Performance metrics</h3>
      <p>TTFB, page weight, compression, render-blocking resources, image optimisation hints, and CDN detection.</p>
    </div>
    <div class="feature-card">
      <div class="icon">♿</div>
      <h3>Accessibility checks</h3>
      <p>WCAG-aligned checks: alt text, heading hierarchy, form labels, colour contrast flags, ARIA roles, and keyboard navigability.</p>
    </div>
    <div class="feature-card">
      <div class="icon">📄</div>
      <h3>White-label PDF reports</h3>
      <p>Generate branded PDF reports with your agency name and logo. Send polished deliverables to clients in one click.</p>
    </div>
    <div class="feature-card">
      <div class="icon">🔗</div>
      <h3>Shareable report links</h3>
      <p>Every audit generates a permanent shareable link. No login required for recipients — just share the URL.</p>
    </div>
    <div class="feature-card">
      <div class="icon">🤖</div>
      <h3>API-first</h3>
      <p>Integrate OrbioLabs into your CI/CD pipeline or internal tools. Simple REST API with JSON responses.</p>
    </div>
  </div>
</section>

<!-- ── Pricing ─────────────────────────────────────────────────────────────── -->
<section class="pricing" id="pricing">
  <h2>Choose your plan</h2>
  <p class="pricing-subtitle">Start with a 14-day free trial on any plan. Cancel anytime.</p>
  <div class="pricing-grid">
    <!-- Starter -->
    <div class="price-card">
      <div class="plan-name">Starter</div>
      <div class="trial-badge">14-day free trial</div>
      <div class="price-amount"><span>$</span>9</div>
      <div class="price-period">per month &middot; cancel anytime</div>
      <ul class="price-features">
        <li><span class="check">✓</span> 5 audits per month</li>
        <li><span class="check">✓</span> SEO, performance &amp; accessibility</li>
        <li><span class="check">✓</span> Shareable report links</li>
        <li><span class="check">✓</span> Email delivery of reports</li>
        <li><span class="check">✓</span> 1 site monitored</li>
        <li><span class="check">✓</span> API access</li>
        <li><span class="x-mark">&mdash;</span> PDF export</li>
        <li><span class="x-mark">&mdash;</span> Scheduled audits</li>
      </ul>
      <a href="#" class="btn-trial-outline" data-tier="starter">Start free trial</a>
      <div class="trial-note">Credit card required &mdash; not charged for 14 days.</div>
    </div>
    <!-- Pro -->
    <div class="price-card featured">
      <div class="popular-badge">Most Popular</div>
      <div class="plan-name">Pro</div>
      <div class="trial-badge">14-day free trial</div>
      <div class="price-amount"><span>$</span>29</div>
      <div class="price-period">per month &middot; cancel anytime</div>
      <ul class="price-features">
        <li><span class="check">✓</span> Unlimited audits</li>
        <li><span class="check">✓</span> Full deep-dive reports</li>
        <li><span class="check">✓</span> Shareable report links</li>
        <li><span class="check">✓</span> White-label PDF export</li>
        <li><span class="check">✓</span> Up to 10 sites monitored</li>
        <li><span class="check">✓</span> Scheduled recurring audits</li>
        <li><span class="check">✓</span> Historical trend tracking</li>
        <li><span class="check">✓</span> Priority scanning</li>
      </ul>
      <a href="#" class="btn-trial" data-tier="pro">Start free trial</a>
      <div class="trial-note">Credit card required &mdash; not charged for 14 days.</div>
    </div>
  </div>
</section>

<!-- ── Footer ─────────────────────────────────────────────────────────────── -->
<footer>
  <p>&copy; 2026 Orbio Labs &mdash; <a href="/privacy">Privacy policy</a> &mdash; <a href="mailto:hello@orbiolab.com">hello@orbiolab.com</a></p>
</footer>

<!-- ── Audit + Trial JS ─────────────────────────────────────────────────────── -->
<script>
(function () {
  // ── Free audit form ───────────────────────────────────────────────────────
  var form = document.getElementById('audit-form');
  var btn  = document.getElementById('audit-btn');
  var errEl = document.getElementById('audit-error');
  var resultsEl = document.getElementById('audit-results');

  function scoreClass(s) {
    if (s >= 80) return 'score-good';
    if (s >= 50) return 'score-mid';
    return 'score-bad';
  }

  function renderResults(data) {
    if (data.error && !data.scores) {
      errEl.textContent = 'Could not audit: ' + data.error;
      errEl.style.display = 'block';
      return;
    }

    errEl.style.display = 'none';
    document.getElementById('result-url').textContent = data.url;

    var scores = data.scores;
    var grid = document.getElementById('score-grid');
    grid.innerHTML = [
      { label: 'Overall', value: scores.overall },
      { label: 'SEO', value: scores.seo },
      { label: 'Performance', value: scores.performance },
      { label: 'Accessibility', value: scores.accessibility }
    ].map(function (s) {
      return '<div class="score-card"><div class="score-value ' + scoreClass(s.value) + '">' + s.value + '</div><div class="score-label">' + s.label + '</div></div>';
    }).join('');

    var container = document.getElementById('issues-container');
    var sections = [
      { title: 'SEO', data: data.seo },
      { title: 'Performance', data: data.performance },
      { title: 'Accessibility', data: data.accessibility }
    ];
    container.innerHTML = sections.map(function (sec) {
      var items = '';
      if (sec.data.issues && sec.data.issues.length) {
        items += sec.data.issues.map(function (i) {
          return '<div class="issue-item"><span class="issue-icon issue-fail">&#10007;</span> ' + escHtml(i) + '</div>';
        }).join('');
      }
      if (sec.data.passes && sec.data.passes.length) {
        items += sec.data.passes.map(function (p) {
          return '<div class="issue-item"><span class="issue-icon issue-pass">&#10003;</span> ' + escHtml(p) + '</div>';
        }).join('');
      }
      return '<div class="issues-section"><h3>' + sec.title + ' (' + sec.data.score + '/100)</h3>' + items + '</div>';
    }).join('');

    resultsEl.style.display = 'block';
    resultsEl.scrollIntoView({ behavior: 'smooth' });
  }

  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var url = form.elements['url'].value.trim();
      if (!url) return;
      btn.disabled = true;
      btn.textContent = 'Auditing…';
      errEl.style.display = 'none';
      resultsEl.style.display = 'none';

      fetch('/audit/free', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url })
      })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        btn.disabled = false;
        btn.textContent = 'Audit this site';
        if (data.error && !data.scores) {
          errEl.textContent = data.detail || data.error;
          errEl.style.display = 'block';
          return;
        }
        renderResults(data);
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = 'Audit this site';
        errEl.textContent = 'Something went wrong. Please try again.';
        errEl.style.display = 'block';
      });
    });
  }

  // ── Pricing CTA — starts trial via Stripe ─────────────────────────────────
  var trialBtns = document.querySelectorAll('[data-tier]');
  trialBtns.forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      var tier = btn.getAttribute('data-tier') || 'starter';
      var email = prompt('Enter your email to start a 14-day free trial:');
      if (!email) return;
      var origText = btn.textContent;
      btn.textContent = 'Starting trial…';
      fetch('/billing/trial', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, tier: tier })
      })
      .then(function (r) { return r.ok ? r.json() : r.json().then(function (d) { return Promise.reject(d); }); })
      .then(function (data) {
        window.location.href = data.url;
      })
      .catch(function (err) {
        btn.textContent = origText;
        alert((err && err.error) ? err.error : 'Something went wrong. Please try again.');
      });
    });
  });
})();
</script>

<!-- ── Analytics (fires only after consent) ──────────────────────────────────── -->
${landingAnalyticsSnippet()}

${consentBannerSnippet()}
</body>
</html>`;
}

module.exports = { generateLandingPage };
