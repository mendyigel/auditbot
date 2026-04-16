'use strict';

/**
 * GDPR-compliant cookie consent banner module.
 *
 * Provides a self-contained HTML/CSS/JS snippet that can be injected into
 * any server-rendered HTML page. Features:
 *   - Shows on first visit only
 *   - Accept / Decline buttons (no pre-ticked boxes)
 *   - Preference persisted in localStorage under key 'orbio_cookie_consent'
 *   - Analytics scripts blocked until explicit Accept
 *   - Exposes window.__consentGiven() helper for conditional analytics init
 */

const CONSENT_KEY = 'orbio_cookie_consent';

/**
 * Returns the inline <style> block for the consent banner.
 */
function consentBannerStyle() {
  return `
<style id="consent-banner-style">
  #consent-banner {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 9999;
    background: #1a1a2e;
    color: #e2e8f0;
    padding: 16px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 0.875rem;
    box-shadow: 0 -2px 12px rgba(0,0,0,0.3);
    flex-wrap: wrap;
  }
  #consent-banner p {
    margin: 0;
    flex: 1;
    min-width: 200px;
    line-height: 1.5;
  }
  #consent-banner a {
    color: #63b3ed;
    text-decoration: underline;
  }
  #consent-banner .consent-actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }
  #consent-banner button {
    padding: 8px 20px;
    border-radius: 6px;
    border: none;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 600;
    transition: opacity 0.15s;
  }
  #consent-banner button:hover { opacity: 0.85; }
  #consent-btn-accept {
    background: #3b82f6;
    color: #fff;
  }
  #consent-btn-decline {
    background: transparent;
    color: #a0aec0;
    border: 1px solid #4a5568 !important;
  }
  @media (max-width: 480px) {
    #consent-banner { flex-direction: column; align-items: flex-start; }
  }
</style>`;
}

/**
 * Returns the inline <div> HTML for the consent banner.
 */
function consentBannerHtml() {
  return `
<div id="consent-banner" role="dialog" aria-label="Cookie consent" aria-live="polite" style="display:none">
  <p>
    We use cookies and analytics to improve your experience. By clicking "Accept", you consent to
    analytics cookies. You can decline without affecting core functionality.
    <a href="/privacy" target="_blank" rel="noopener">Privacy policy</a>
  </p>
  <div class="consent-actions">
    <button id="consent-btn-decline" type="button">Decline</button>
    <button id="consent-btn-accept" type="button">Accept</button>
  </div>
</div>`;
}

/**
 * Returns the inline <script> block that drives the consent banner logic.
 *
 * The script:
 *   1. Reads localStorage on load.
 *   2. Shows the banner only if no preference is stored.
 *   3. On Accept/Decline, stores preference and fires window.onConsentResolved(granted).
 *   4. Exposes window.__consentGiven() → boolean for analytics scripts to gate on.
 *   5. If consent was previously accepted, fires window.onConsentResolved(true) immediately
 *      so analytics can self-init on subsequent page loads.
 */
function consentBannerScript() {
  return `
<script id="consent-banner-script">
(function () {
  var KEY = '${CONSENT_KEY}';
  var stored = localStorage.getItem(KEY);

  // Public helper — returns true if user has accepted analytics cookies.
  window.__consentGiven = function () {
    return localStorage.getItem(KEY) === 'accepted';
  };

  function fireCb(granted) {
    if (typeof window.onConsentResolved === 'function') {
      window.onConsentResolved(granted);
    }
  }

  function hide() {
    var el = document.getElementById('consent-banner');
    if (el) el.style.display = 'none';
  }

  function show() {
    var el = document.getElementById('consent-banner');
    if (el) el.style.display = '';
  }

  function accept() {
    localStorage.setItem(KEY, 'accepted');
    hide();
    fireCb(true);
  }

  function decline() {
    localStorage.setItem(KEY, 'declined');
    hide();
    fireCb(false);
  }

  // Wire buttons once DOM is ready.
  function init() {
    var btnAccept  = document.getElementById('consent-btn-accept');
    var btnDecline = document.getElementById('consent-btn-decline');
    if (btnAccept)  btnAccept.addEventListener('click',  accept);
    if (btnDecline) btnDecline.addEventListener('click', decline);

    if (stored === 'accepted') {
      // Already accepted — fire immediately, keep banner hidden.
      fireCb(true);
    } else if (stored === 'declined') {
      // Already declined — keep banner hidden.
    } else {
      // First visit — show banner.
      show();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
</script>`;
}

/**
 * Returns the complete consent banner snippet (style + html + script) ready
 * to inject just before </body>.
 */
function consentBannerSnippet() {
  return consentBannerStyle() + consentBannerHtml() + consentBannerScript();
}

module.exports = { consentBannerSnippet, consentBannerStyle, consentBannerHtml, consentBannerScript, CONSENT_KEY };
