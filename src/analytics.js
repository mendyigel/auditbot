'use strict';

/**
 * Analytics module — Plausible Analytics integration.
 *
 * Plausible is privacy-first (no cookies, GDPR-compliant without consent
 * under most interpretations, but we respect the existing consent banner).
 *
 * Required env vars:
 *   PLAUSIBLE_DOMAIN   — e.g. "orbiolabs.com" (omit to disable analytics)
 *
 * Optional env vars:
 *   PLAUSIBLE_API_HOST — default "https://plausible.io" (override for self-hosted)
 *
 * Client-side events tracked on the landing page:
 *   pageview          — fired on load after consent
 *   cta_click         — nav or pricing CTA clicked (props: location)
 *   waitlist_submit   — email capture form submitted successfully
 *   subscribe_click   — pricing subscribe button clicked
 *
 * Server-side events (via Plausible Events API):
 *   audit_run         — fired on every POST /audit (props: format)
 *   pdf_export        — fired on every GET /report/:id/pdf
 *   subscription_start — fired when Stripe webhook confirms new subscription
 */

const PLAUSIBLE_DOMAIN   = process.env.PLAUSIBLE_DOMAIN   || '';
const PLAUSIBLE_API_HOST = process.env.PLAUSIBLE_API_HOST || 'https://plausible.io';

// ── Client-side snippets ──────────────────────────────────────────────────────

/**
 * Full analytics snippet for the landing page.
 * Loads Plausible on consent, sets up CTA + waitlist event tracking.
 */
function landingAnalyticsSnippet() {
  if (!PLAUSIBLE_DOMAIN) {
    return '<!-- analytics disabled: set PLAUSIBLE_DOMAIN to enable -->';
  }

  return `
<script>
(function () {
  // Stub — queues calls before the real script loads
  window.plausible = window.plausible || function () {
    (window.plausible.q = window.plausible.q || []).push(arguments);
  };

  function loadPlausible() {
    if (document.getElementById('plausible-script')) return;
    var s = document.createElement('script');
    s.id = 'plausible-script';
    s.defer = true;
    s.dataset.domain = '${PLAUSIBLE_DOMAIN}';
    s.dataset.api    = '${PLAUSIBLE_API_HOST}/api/event';
    // manual.js requires an explicit plausible('pageview') call
    s.src = '${PLAUSIBLE_API_HOST}/js/script.manual.js';
    s.onload = function () {
      window.plausible('pageview');
      // Flush any events queued before the script loaded
      var q = window.plausible.q || [];
      window.plausible.q = [];
      for (var i = 0; i < q.length; i++) {
        try { window.plausible.apply(null, q[i]); } catch (_) {}
      }
    };
    document.head.appendChild(s);
  }

  // ── Consent hook ──────────────────────────────────────────────────────────
  // Overrides the stub in landing.js — called by the consent banner module.
  window.onConsentResolved = function (granted) {
    if (granted) loadPlausible();
  };

  // ── Event tracking ────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    // Nav CTA
    var navCta = document.querySelector('nav .cta-nav');
    if (navCta) {
      navCta.addEventListener('click', function () {
        window.plausible('cta_click', { props: { location: 'nav' } });
      });
    }

    // Pricing subscribe button
    var subscribeBtn = document.querySelector('.btn-subscribe');
    if (subscribeBtn) {
      subscribeBtn.addEventListener('click', function () {
        window.plausible('subscribe_click', { props: { location: 'pricing' } });
      });
    }

    // Waitlist form — listen for the custom event dispatched on success
    document.addEventListener('waitlist:submitted', function () {
      window.plausible('waitlist_submit');
    });
  });
})();
</script>`;
}

/**
 * Lightweight snippet for app pages (billing/success, billing/cancel, reports).
 * Loads Plausible on consent and fires a pageview.
 */
function appPageAnalyticsSnippet(pageName) {
  if (!PLAUSIBLE_DOMAIN) return '';

  const pageNameJs = JSON.stringify(pageName || '');
  return `
<script>
(function () {
  window.plausible = window.plausible || function () {
    (window.plausible.q = window.plausible.q || []).push(arguments);
  };
  window.onConsentResolved = function (granted) {
    if (!granted) return;
    if (document.getElementById('plausible-script')) return;
    var s = document.createElement('script');
    s.id = 'plausible-script';
    s.defer = true;
    s.dataset.domain = '${PLAUSIBLE_DOMAIN}';
    s.dataset.api    = '${PLAUSIBLE_API_HOST}/api/event';
    s.src = '${PLAUSIBLE_API_HOST}/js/script.manual.js';
    s.onload = function () {
      window.plausible('pageview'${pageName ? `, { u: window.location.origin + '/' + ${pageNameJs} }` : ''});
    };
    document.head.appendChild(s);
  };
})();
</script>`;
}

// ── Server-side event tracking ────────────────────────────────────────────────

let _fetch;
function getFetch() {
  if (!_fetch) _fetch = require('node-fetch');
  return _fetch;
}

/**
 * Fire a server-side event to Plausible's Events API.
 *
 * @param {string} eventName  — e.g. 'audit_run', 'pdf_export'
 * @param {object} props      — custom properties (max 30 per event)
 * @param {object} req        — Express request (for User-Agent + IP forwarding)
 * @returns {Promise<void>}
 */
async function trackServerEvent(eventName, props, req) {
  if (!PLAUSIBLE_DOMAIN) return;

  const appUrl  = process.env.APP_URL || 'https://' + PLAUSIBLE_DOMAIN;
  const pageUrl = appUrl + (req ? req.path : '/');
  const ua      = (req && req.headers['user-agent']) || 'AuditBot/1.0';
  const ip      = (req && (req.headers['x-forwarded-for'] || req.socket?.remoteAddress)) || '127.0.0.1';

  const body = {
    name:   eventName,
    url:    pageUrl,
    domain: PLAUSIBLE_DOMAIN,
  };
  if (props && Object.keys(props).length > 0) {
    body.props = props;
  }

  try {
    const fetch = getFetch();
    const res = await fetch(`${PLAUSIBLE_API_HOST}/api/event`, {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        'User-Agent':      ua,
        'X-Forwarded-For': ip.split(',')[0].trim(),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok && res.status !== 202) {
      console.warn(`[analytics] Plausible rejected event "${eventName}": ${res.status}`);
    }
  } catch (err) {
    // Analytics failures must never break the main request flow
    console.warn(`[analytics] Failed to send event "${eventName}":`, err.message);
  }
}

module.exports = { landingAnalyticsSnippet, appPageAnalyticsSnippet, trackServerEvent, PLAUSIBLE_DOMAIN };
