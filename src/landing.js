'use strict';

const { consentBannerSnippet } = require('./consent-banner');
const { landingAnalyticsSnippet } = require('./analytics');

/**
 * Generates the full orbiolabs.com landing page HTML.
 * Includes email capture / waitlist form and GDPR consent banner.
 */
function generateLandingPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="AuditBot — Automated SEO, performance &amp; accessibility audits. Get actionable reports for any website in seconds." />
  <title>AuditBot by Orbio Labs — Automated Website Audits</title>
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

    /* ── Waitlist form ──────────────────────────────────────────────────────── */
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
      max-width: 480px;
      margin: 80px auto;
      padding: 0 24px;
      text-align: center;
    }
    .pricing h2 {
      font-size: 1.875rem;
      font-weight: 800;
      margin-bottom: 32px;
      letter-spacing: -0.5px;
    }
    .price-card {
      background: var(--surface);
      border: 1px solid var(--brand);
      border-radius: 16px;
      padding: 40px 32px;
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
  <a href="#waitlist-section" class="cta-nav">Join Waitlist</a>
</nav>

<!-- ── Hero ───────────────────────────────────────────────────────────────── -->
<section class="hero" id="waitlist-section">
  <div class="badge">Now in early access</div>
  <h1>Automated audits for <em>SEO, performance &amp; accessibility</em></h1>
  <p>AuditBot scans any URL and delivers actionable, white-label reports in seconds. Built for agencies, freelancers, and dev teams.</p>

  <form id="waitlist" action="/waitlist" method="POST" novalidate>
    <input type="email" name="email" placeholder="you@company.com" required autocomplete="email" />
    <button type="submit" id="waitlist-btn">Get early access</button>
  </form>
  <div class="waitlist-note">No spam. Early access — $29/mo at launch.</div>
  <div id="waitlist-msg">You're on the list! We'll be in touch soon.</div>
</section>

<!-- ── Trust bar ──────────────────────────────────────────────────────────── -->
<div class="social-proof">Trusted by growing teams</div>
<div class="trust-bar">
  <div class="trust-item"><span class="num">60+</span>audit signals</div>
  <div class="trust-item"><span class="num">&lt;10s</span>per report</div>
  <div class="trust-item"><span class="num">PDF</span>white-label export</div>
  <div class="trust-item"><span class="num">$29</span>/month flat</div>
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
      <p>Integrate AuditBot into your CI/CD pipeline or internal tools. Simple REST API with JSON responses.</p>
    </div>
  </div>
</section>

<!-- ── Pricing ─────────────────────────────────────────────────────────────── -->
<section class="pricing">
  <h2>Simple, flat pricing</h2>
  <div class="price-card">
    <div class="price-amount"><span>$</span>29</div>
    <div class="price-period">per month · cancel anytime</div>
    <ul class="price-features">
      <li><span class="check">✓</span> Unlimited audits</li>
      <li><span class="check">✓</span> Full API access</li>
      <li><span class="check">✓</span> White-label PDF reports</li>
      <li><span class="check">✓</span> Shareable report links</li>
      <li><span class="check">✓</span> 30-day report retention</li>
      <li><span class="check">✓</span> Email support</li>
    </ul>
    <a href="/billing/checkout" class="btn-subscribe">Subscribe now</a>
  </div>
</section>

<!-- ── Footer ─────────────────────────────────────────────────────────────── -->
<footer>
  <p>&copy; 2026 Orbio Labs &mdash; <a href="/privacy">Privacy policy</a> &mdash; <a href="mailto:hello@orbiolabs.com">hello@orbiolabs.com</a></p>
</footer>

<!-- ── Waitlist form JS ──────────────────────────────────────────────────────── -->
<script>
(function () {
  var form = document.getElementById('waitlist');
  var btn  = document.getElementById('waitlist-btn');
  var msg  = document.getElementById('waitlist-msg');
  if (!form) return;
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var email = form.elements['email'].value.trim();
    if (!email) return;
    btn.disabled = true;
    btn.textContent = 'Joining…';
    fetch('/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email })
    })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r); })
    .then(function () {
      form.style.display = 'none';
      msg.style.display = 'block';
      // Notify analytics module
      document.dispatchEvent(new CustomEvent('waitlist:submitted'));
    })
    .catch(function () {
      btn.disabled = false;
      btn.textContent = 'Get early access';
      alert('Something went wrong. Please try again.');
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
