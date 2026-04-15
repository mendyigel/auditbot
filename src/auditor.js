'use strict';

const fetch = require('node-fetch');
const cheerio = require('cheerio');

/**
 * Core audit engine. Fetches a URL and returns structured SEO, performance,
 * and accessibility findings with a numeric score per category.
 */
async function auditUrl(url, options = {}) {
  const timeoutMs = options.timeoutMs || 15000;
  const startAt = Date.now();

  // ── Fetch ────────────────────────────────────────────────────────────────
  let response, html, fetchError;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'AuditBot/1.0 (+https://auditbot.io/bot) Mozilla/5.0 compatible',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    clearTimeout(timer);
    html = await response.text();
  } catch (err) {
    fetchError = err.message;
  }

  const ttfbMs = Date.now() - startAt;

  if (fetchError || !html) {
    return {
      url,
      error: fetchError || 'Empty response',
      auditedAt: new Date().toISOString(),
    };
  }

  const $ = cheerio.load(html);
  const finalUrl = response.url || url;
  const statusCode = response.status;
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const pageSizeBytes = Buffer.byteLength(html, 'utf8');

  // ── SEO ──────────────────────────────────────────────────────────────────
  const title = $('title').first().text().trim();
  const metaDescription = $('meta[name="description"]').attr('content') || '';
  const canonical = $('link[rel="canonical"]').attr('href') || '';
  const robotsMeta = $('meta[name="robots"]').attr('content') || '';
  const h1s = $('h1').map((_, el) => $(el).text().trim()).get();
  const h2s = $('h2').map((_, el) => $(el).text().trim()).get();
  const ogTitle = $('meta[property="og:title"]').attr('content') || '';
  const ogDescription = $('meta[property="og:description"]').attr('content') || '';
  const ogImage = $('meta[property="og:image"]').attr('content') || '';
  const twitterCard = $('meta[name="twitter:card"]').attr('content') || '';
  const lang = $('html').attr('lang') || '';
  const viewport = $('meta[name="viewport"]').attr('content') || '';

  // JSON-LD structured data
  const structuredData = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      structuredData.push(JSON.parse($(el).html()));
    } catch (_e) {
      // ignore malformed
    }
  });

  // Internal / external link count
  let internalLinks = 0, externalLinks = 0;
  const parsedBase = safeParseUrl(finalUrl);
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    const parsed = safeParseUrl(href, finalUrl);
    if (!parsed) return;
    if (parsedBase && parsed.hostname === parsedBase.hostname) {
      internalLinks++;
    } else {
      externalLinks++;
    }
  });

  const seoIssues = [];
  const seoPasses = [];

  checkItem(title.length > 0 && title.length <= 60, `Title tag (${title.length || 0} chars)`, seoIssues, seoPasses, 'Title missing or too long (>60 chars)');
  checkItem(metaDescription.length >= 50 && metaDescription.length <= 160, `Meta description (${metaDescription.length} chars)`, seoIssues, seoPasses, 'Meta description missing or out of 50–160 range');
  checkItem(h1s.length === 1, `H1 count (${h1s.length})`, seoIssues, seoPasses, 'Page should have exactly one H1');
  checkItem(canonical.length > 0, 'Canonical URL present', seoIssues, seoPasses, 'No canonical URL defined');
  checkItem(!robotsMeta.includes('noindex'), 'Page is indexable', seoIssues, seoPasses, 'Page has noindex directive');
  checkItem(lang.length > 0, 'HTML lang attribute', seoIssues, seoPasses, 'Missing lang attribute on <html>');
  checkItem(ogTitle.length > 0, 'Open Graph title', seoIssues, seoPasses, 'Missing og:title');
  checkItem(ogImage.length > 0, 'Open Graph image', seoIssues, seoPasses, 'Missing og:image');
  checkItem(structuredData.length > 0, 'Structured data (JSON-LD)', seoIssues, seoPasses, 'No JSON-LD structured data found');
  checkItem(viewport.length > 0, 'Viewport meta tag', seoIssues, seoPasses, 'Missing viewport meta (mobile-unfriendly)');

  const seoScore = pct(seoPasses.length, seoPasses.length + seoIssues.length);

  // ── Performance ───────────────────────────────────────────────────────────
  const perfIssues = [];
  const perfPasses = [];

  const pageSizeKb = pageSizeBytes / 1024;
  checkItem(pageSizeKb < 200, `HTML size (${pageSizeKb.toFixed(1)} KB)`, perfIssues, perfPasses, `HTML payload too large (${pageSizeKb.toFixed(1)} KB > 200 KB)`);
  checkItem(ttfbMs < 800, `TTFB (${ttfbMs} ms)`, perfIssues, perfPasses, `Slow time-to-first-byte: ${ttfbMs} ms (target <800 ms)`);
  checkItem(statusCode < 400, `HTTP status ${statusCode}`, perfIssues, perfPasses, `HTTP error status: ${statusCode}`);

  // Render-blocking hints
  const renderBlockingCss = $('link[rel="stylesheet"]:not([media="print"])').length;
  const renderBlockingJs = $('script:not([async]):not([defer]):not([type="application/ld+json"]):not([type="module"])').filter((_, el) => $(el).attr('src')).length;
  checkItem(renderBlockingJs === 0, `No render-blocking scripts (${renderBlockingJs} found)`, perfIssues, perfPasses, `${renderBlockingJs} render-blocking <script> tag(s) — add async/defer`);
  checkItem(renderBlockingCss <= 2, `Stylesheet count (${renderBlockingCss})`, perfIssues, perfPasses, `${renderBlockingCss} stylesheets may block rendering`);

  // Image optimization hints
  const imagesTotal = $('img').length;
  const imagesWithoutSrcset = $('img:not([srcset]):not([loading])').length;
  checkItem(imagesWithoutSrcset === 0, `Images lazy-loaded / responsive (${imagesTotal} total)`, perfIssues, perfPasses, `${imagesWithoutSrcset} image(s) missing srcset or loading="lazy"`);

  // Compression hint via response headers
  const contentEncoding = response.headers.get('content-encoding') || '';
  checkItem(contentEncoding.includes('gzip') || contentEncoding.includes('br'), 'Response compressed (gzip/brotli)', perfIssues, perfPasses, 'Response not compressed — enable gzip or brotli on the server');

  const perfScore = pct(perfPasses.length, perfPasses.length + perfIssues.length);

  // ── Accessibility ─────────────────────────────────────────────────────────
  const a11yIssues = [];
  const a11yPasses = [];

  // Images with alt text
  const imgs = $('img');
  const imgsNoAlt = imgs.filter((_, el) => !$(el).attr('alt') && !$(el).attr('role')).length;
  checkItem(imgsNoAlt === 0, `Images with alt text (${imgs.length - imgsNoAlt}/${imgs.length})`, a11yIssues, a11yPasses, `${imgsNoAlt} image(s) missing alt attribute`);

  // Form labels
  const inputs = $('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"])');
  let unlabelledInputs = 0;
  inputs.each((_, el) => {
    const id = $(el).attr('id');
    const ariaLabel = $(el).attr('aria-label');
    const ariaLabelledBy = $(el).attr('aria-labelledby');
    const hasLabel = id && $(`label[for="${id}"]`).length > 0;
    if (!hasLabel && !ariaLabel && !ariaLabelledBy) unlabelledInputs++;
  });
  checkItem(unlabelledInputs === 0, `Form inputs labelled (${inputs.length - unlabelledInputs}/${inputs.length})`, a11yIssues, a11yPasses, `${unlabelledInputs} form input(s) missing label or aria-label`);

  // Heading order (no skipping levels)
  const headingLevels = [];
  $('h1,h2,h3,h4,h5,h6').each((_, el) => headingLevels.push(parseInt(el.tagName.slice(1))));
  let headingOrderOk = true;
  for (let i = 1; i < headingLevels.length; i++) {
    if (headingLevels[i] - headingLevels[i - 1] > 1) { headingOrderOk = false; break; }
  }
  checkItem(headingOrderOk, 'Heading hierarchy (no skipped levels)', a11yIssues, a11yPasses, 'Heading levels are skipped (e.g. H1 → H3)');

  // Skip navigation link
  const skipLink = $('a[href="#main"], a[href="#content"], a[href="#maincontent"]').length > 0
    || $('a').filter((_, el) => /skip.*(nav|content|main)/i.test($(el).text())).length > 0;
  checkItem(skipLink, 'Skip navigation link', a11yIssues, a11yPasses, 'No skip-navigation link detected');

  // ARIA landmark roles
  const hasMain = $('main, [role="main"]').length > 0;
  checkItem(hasMain, 'Main landmark (<main> or role="main")', a11yIssues, a11yPasses, 'No <main> landmark — screen readers cannot skip to content');

  // Language attribute (also in SEO — double-credit here)
  checkItem(lang.length > 0, 'HTML lang declared', a11yIssues, a11yPasses, 'Missing lang attribute — screen readers cannot select voice');

  // Buttons with accessible names
  const btns = $('button');
  const btnsNoName = btns.filter((_, el) => {
    const text = $(el).text().trim();
    const ariaLabel = $(el).attr('aria-label');
    const ariaLabelledBy = $(el).attr('aria-labelledby');
    const title = $(el).attr('title');
    return !text && !ariaLabel && !ariaLabelledBy && !title;
  }).length;
  checkItem(btnsNoName === 0, `Buttons have accessible names (${btns.length - btnsNoName}/${btns.length})`, a11yIssues, a11yPasses, `${btnsNoName} button(s) have no visible or accessible name`);

  const a11yScore = pct(a11yPasses.length, a11yPasses.length + a11yIssues.length);

  // ── Aggregate score ───────────────────────────────────────────────────────
  const overallScore = Math.round((seoScore + perfScore + a11yScore) / 3);

  return {
    url: finalUrl,
    auditedAt: new Date().toISOString(),
    statusCode,
    ttfbMs,
    pageSizeKb: +pageSizeKb.toFixed(1),
    scores: {
      overall: overallScore,
      seo: seoScore,
      performance: perfScore,
      accessibility: a11yScore,
    },
    seo: {
      score: seoScore,
      title,
      metaDescription,
      canonical,
      robotsMeta,
      h1s,
      h2s: h2s.slice(0, 10),
      ogTitle,
      ogDescription,
      ogImage,
      twitterCard,
      lang,
      viewport,
      structuredDataTypes: structuredData.map(d => d['@type'] || '(unknown)'),
      internalLinks,
      externalLinks,
      passes: seoPasses,
      issues: seoIssues,
    },
    performance: {
      score: perfScore,
      ttfbMs,
      pageSizeKb: +pageSizeKb.toFixed(1),
      renderBlockingJs,
      renderBlockingCss,
      imagesTotal,
      imagesWithoutSrcset,
      contentEncoding,
      passes: perfPasses,
      issues: perfIssues,
    },
    accessibility: {
      score: a11yScore,
      lang,
      imgsNoAlt,
      unlabelledInputs,
      headingOrderOk,
      hasMain,
      skipLink,
      btnsNoName,
      passes: a11yPasses,
      issues: a11yIssues,
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function checkItem(passing, label, issues, passes, failMessage) {
  if (passing) {
    passes.push(label);
  } else {
    issues.push(failMessage);
  }
}

function pct(pass, total) {
  if (total === 0) return 100;
  return Math.round((pass / total) * 100);
}

function safeParseUrl(href, base) {
  try {
    return new URL(href, base);
  } catch (_) {
    return null;
  }
}

module.exports = { auditUrl };
