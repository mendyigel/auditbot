'use strict';

/**
 * Transactional email service for AuditBot / OrbioLabs
 *
 * Uses Resend (https://resend.com) for delivery.
 * Falls back to a no-op console log if RESEND_API_KEY is not set.
 *
 * Required env vars:
 *   RESEND_API_KEY   — re_… from Resend dashboard
 *   EMAIL_FROM       — sender address (default: "OrbioLabs <onboarding@resend.dev>")
 *                      Set to "OrbioLabs <support@orbiolab.com>" once domain is verified in Resend
 *   APP_URL          — public base URL (default: https://orbiolab.com)
 */

const fetch = require('node-fetch');

const FROM    = process.env.EMAIL_FROM || 'OrbioLabs <onboarding@resend.dev>';
const APP_URL = process.env.APP_URL    || 'https://orbiolab.com';

// ── Brand constants ───────────────────────────────────────────────────────────

const B = {
  blue:     '#1A6BFF',
  dark:     '#0D0F14',
  offWhite: '#F5F6FA',
  slate:    '#6B7280',
  success:  '#10B981',
};

// ── Core send ─────────────────────────────────────────────────────────────────

async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[email] RESEND_API_KEY not set — skipping "${subject}" to ${to}`);
    return { skipped: true };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, to, subject, html }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('[email] Resend error:', JSON.stringify(data));
      return { error: data };
    }
    console.log(`[email] Sent "${subject}" to ${to} (id: ${data.id})`);
    return { id: data.id };
  } catch (err) {
    console.error('[email] Send failed:', err.message);
    return { error: err.message };
  }
}

// ── HTML building blocks ──────────────────────────────────────────────────────

function layout(content) {
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>OrbioLabs</title>
</head>
<body style="margin:0;padding:0;background:${B.offWhite};font-family:Inter,-apple-system,system-ui,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${B.offWhite};padding:40px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
        <tr>
          <td style="background:${B.dark};padding:24px 32px;border-radius:8px 8px 0 0;">
            <span style="font-size:22px;font-weight:700;color:#fff;letter-spacing:-0.02em;">
              Orbio<span style="color:${B.blue};">Labs</span>
            </span>
          </td>
        </tr>
        <tr>
          <td style="background:#fff;padding:40px 32px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;">
            ${content}
          </td>
        </tr>
        <tr>
          <td style="background:${B.offWhite};padding:20px 32px;border-radius:0 0 8px 8px;border:1px solid #e5e7eb;border-top:none;">
            <p style="margin:0;font-size:12px;color:${B.slate};line-height:1.6;">
              &copy; ${year} OrbioLabs &middot; Automated intelligence for web professionals.<br>
              <a href="${APP_URL}/unsubscribe" style="color:${B.slate};">Unsubscribe</a> &middot;
              <a href="${APP_URL}/privacy" style="color:${B.slate};">Privacy Policy</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

const h1 = (t) =>
  `<h1 style="margin:0 0 16px;font-size:28px;font-weight:700;color:${B.dark};line-height:1.2;">${t}</h1>`;

const p = (t) =>
  `<p style="margin:0 0 16px;font-size:16px;color:#374151;line-height:1.6;">${t}</p>`;

const btn = (label, href) =>
  `<a href="${href}" style="display:inline-block;background:${B.blue};color:#fff;font-weight:600;` +
  `font-size:15px;padding:12px 28px;border-radius:6px;text-decoration:none;margin:8px 0 16px;">${label}</a>`;

const hr = () =>
  `<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">`;

const codeBlock = (text) =>
  `<div style="background:${B.offWhite};border:1px solid #e5e7eb;border-radius:6px;` +
  `padding:16px 20px;margin:0 0 24px;font-family:'JetBrains Mono',monospace;` +
  `font-size:14px;color:${B.dark};word-break:break-all;">${text}</div>`;

// ── Email template functions ──────────────────────────────────────────────────

/**
 * 1. Welcome — sent immediately on account confirmation / checkout complete.
 */
function tplWelcome({ apiKey }) {
  const snippet =
    `curl -X POST ${APP_URL}/audit \\<br>` +
    `&nbsp;&nbsp;-H "Content-Type: application/json" \\<br>` +
    `&nbsp;&nbsp;-H "Authorization: Bearer ${apiKey}" \\<br>` +
    `&nbsp;&nbsp;-d '{"url":"https://yoursite.com"}'`;

  return {
    subject: 'Your OrbioLabs API key is ready',
    html: layout(`
      ${h1('Welcome to OrbioLabs')}
      ${p('Your subscription is active. Here&rsquo;s your API key &mdash; keep it safe:')}
      ${codeBlock(apiKey)}
      ${p('Run your first audit:')}
      <pre style="background:#0f172a;color:#e2e8f0;padding:16px;border-radius:6px;font-size:13px;overflow-x:auto;margin:0 0 24px;line-height:1.6;">${snippet}</pre>
      ${p('OrbioLabs checks SEO, performance (Core Web Vitals), and accessibility &mdash; and returns a shareable report link in seconds.')}
      ${btn('View API Docs', `${APP_URL}/api`)}
      ${hr()}
      ${p('<strong>3 things to do first:</strong><br>1. Run an audit on your own site<br>2. Download the PDF report for a client<br>3. Share the report link &mdash; it works without any account')}
    `),
  };
}

/**
 * 2. Trial day 3 — no audit run yet.
 */
function tplTrialDay3() {
  return {
    subject: 'Your first audit is waiting — takes 30 seconds',
    html: layout(`
      ${h1('Have you run your first audit yet?')}
      ${p("You&rsquo;re 3 days in and we haven&rsquo;t seen an audit from you yet. Here&rsquo;s the fastest path to your first report:")}
      ${btn('Run an Audit Now', `${APP_URL}/`)}
      ${hr()}
      <p style="margin:0 0 12px;font-size:15px;font-weight:600;color:${B.dark};">What OrbioLabs checks in &lt;30 seconds:</p>
      <table cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 24px;">
        <tr><td style="padding:8px 0;border-bottom:1px solid #f3f4f6;">
          <span style="color:${B.success};font-weight:700;margin-right:8px;">&#10003;</span>
          <span style="font-size:15px;color:#374151;"><strong>SEO</strong> &mdash; title tags, meta, canonicals, H1s, alt text, structured data</span>
        </td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #f3f4f6;">
          <span style="color:${B.success};font-weight:700;margin-right:8px;">&#10003;</span>
          <span style="font-size:15px;color:#374151;"><strong>Performance</strong> &mdash; Core Web Vitals, LCP, CLS, render-blocking resources</span>
        </td></tr>
        <tr><td style="padding:8px 0;">
          <span style="color:${B.success};font-weight:700;margin-right:8px;">&#10003;</span>
          <span style="font-size:15px;color:#374151;"><strong>Accessibility</strong> &mdash; WCAG 2.1 AA: contrast, ARIA, keyboard nav, image alt</span>
        </td></tr>
      </table>
      ${p('Each report is shareable via link and exportable as a white-label PDF.')}
    `),
  };
}

/**
 * 3. Trial day 10 — 4 days left.
 */
function tplTrialDay10() {
  return {
    subject: '4 days left on your OrbioLabs trial',
    html: layout(`
      ${h1('4 days left on your trial')}
      ${p('Your 14-day trial ends in 4 days. After that, your API key will stop working unless you upgrade.')}
      ${btn('Upgrade Now &mdash; from $9/month', `${APP_URL}/billing/checkout`)}
      ${hr()}
      ${p('<strong>What you keep with a paid plan:</strong><br>&bull; Unlimited audits<br>&bull; Unlimited PDF exports<br>&bull; 90-day report storage (vs. 7-day trial)<br>&bull; Scheduled recurring audits<br>&bull; Multi-site dashboard<br>&bull; API access')}
      ${p('Questions? Reply to this email &mdash; we read every one.')}
    `),
  };
}

/**
 * 4. Trial day 13 — final warning.
 */
function tplTrialDay13() {
  return {
    subject: 'Last chance — your OrbioLabs trial expires tomorrow',
    html: layout(`
      ${h1('Your trial ends tomorrow')}
      ${p('This is your last reminder. Your OrbioLabs trial expires tomorrow. After that, your API key will stop working and past reports become read-only.')}
      ${btn('Upgrade Before It Expires', `${APP_URL}/billing/checkout`)}
      ${hr()}
      ${p('Not ready to commit? Cancel anytime during the trial &mdash; no charge if you cancel before tomorrow.')}
      ${p('Upgrade now and keep everything running without interruption.')}
    `),
  };
}

/**
 * 5. Trial expired — day 14, no payment.
 */
function tplTrialExpired() {
  return {
    subject: 'Your OrbioLabs trial has ended — reactivate now',
    html: layout(`
      ${h1('Your trial has ended')}
      ${p('Your 14-day OrbioLabs trial expired today. Your API key is now paused &mdash; past reports are still accessible for 30 days.')}
      ${btn('Reactivate &mdash; from $9/month', `${APP_URL}/billing/checkout`)}
      ${hr()}
      ${p('Reactivate and pick up exactly where you left off. Your report history and API key are restored immediately.')}
      ${p('This offer expires in 30 days, after which your data will be deleted.')}
    `),
  };
}

/**
 * 6. Payment receipt — on Stripe subscription created.
 */
function tplPaymentReceipt({ amount = '$29.00', plan = 'OrbioLabs Monthly' } = {}) {
  const date = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
  const row = (label, val) =>
    `<tr>
      <td style="font-size:14px;color:${B.slate};padding:8px 0;border-bottom:1px solid #f3f4f6;">${label}</td>
      <td style="font-size:14px;color:${B.dark};font-weight:600;text-align:right;padding:8px 0;border-bottom:1px solid #f3f4f6;">${val}</td>
    </tr>`;

  return {
    subject: 'Payment confirmed — OrbioLabs receipt',
    html: layout(`
      ${h1('Payment confirmed')}
      ${p('Thanks for subscribing to OrbioLabs.')}
      <table cellpadding="0" cellspacing="0" style="width:100%;background:${B.offWhite};border-radius:6px;padding:4px 16px;margin:0 0 24px;">
        ${row('Plan', plan)}
        ${row('Amount', amount)}
        ${row('Date', date)}
      </table>
      ${p('Your subscription renews monthly. Manage or cancel anytime.')}
      ${btn('Manage Subscription', `${APP_URL}/billing/portal`)}
    `),
  };
}

/**
 * 7. Cancellation confirmation.
 */
function tplCancellation() {
  return {
    subject: 'Your OrbioLabs subscription has been cancelled',
    html: layout(`
      ${h1('Subscription cancelled')}
      ${p("Your OrbioLabs subscription has been cancelled. You won&rsquo;t be charged again.")}
      ${p('Your access continues until the end of your current billing period. After that, your API key will stop working and your data will be retained for 30 days before deletion.')}
      ${hr()}
      ${p('Changed your mind? Resubscribe anytime &mdash; your report history will be restored.')}
      ${btn('Resubscribe', `${APP_URL}/billing/checkout`)}
      ${p("Thanks for trying OrbioLabs. If there&rsquo;s anything we could have done better, reply to this email &mdash; we read every response.")}
    `),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

async function sendWelcome(to, opts)          { return sendEmail({ to, ...tplWelcome(opts) }); }
async function sendTrialDay3(to)              { return sendEmail({ to, ...tplTrialDay3() }); }
async function sendTrialDay10(to)             { return sendEmail({ to, ...tplTrialDay10() }); }
async function sendTrialDay13(to)             { return sendEmail({ to, ...tplTrialDay13() }); }
async function sendTrialExpired(to)           { return sendEmail({ to, ...tplTrialExpired() }); }
async function sendPaymentReceipt(to, opts)   { return sendEmail({ to, ...tplPaymentReceipt(opts) }); }
async function sendCancellation(to)           { return sendEmail({ to, ...tplCancellation() }); }

async function sendPasswordReset(to, { resetUrl }) {
  return sendEmail({
    to,
    subject: 'Reset your OrbioLabs password',
    html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:${B.dark};color:${B.offWhite};border-radius:12px">
<h1 style="font-size:1.5rem;margin:0 0 16px;color:${B.offWhite}">Password Reset</h1>
<p style="color:${B.slate};font-size:0.95rem;line-height:1.6;margin:0 0 24px">
We received a request to reset your OrbioLabs password. Click the button below to choose a new password. This link expires in 1 hour.</p>
<a href="${resetUrl}" style="display:inline-block;padding:14px 32px;background:${B.blue};color:#fff;border-radius:8px;font-weight:700;font-size:1rem;text-decoration:none">Reset password</a>
<p style="color:${B.slate};font-size:0.85rem;line-height:1.6;margin:24px 0 0">
If you didn't request this, you can safely ignore this email. Your password won't change.</p>
<hr style="border:none;border-top:1px solid #334155;margin:24px 0" />
<p style="color:${B.slate};font-size:0.8rem;margin:0">OrbioLabs &mdash; <a href="${APP_URL}" style="color:${B.blue}">orbiolab.com</a></p>
</div>`,
  });
}

function getStatus() {
  return {
    configured: !!process.env.RESEND_API_KEY,
    from: FROM,
    appUrl: APP_URL,
  };
}

async function sendTest(to) {
  return sendEmail({
    to,
    subject: 'OrbioLabs Email Test',
    html: '<p>This is a test email from OrbioLabs. If you received this, email delivery is working.</p>',
  });
}

module.exports = {
  sendWelcome,
  sendTrialDay3,
  sendTrialDay10,
  sendTrialDay13,
  sendTrialExpired,
  sendPaymentReceipt,
  sendCancellation,
  sendPasswordReset,
  getStatus,
  sendTest,
};
