'use strict';

const fetch = require('node-fetch');
const cheerio = require('cheerio');

/**
 * Competitor benchmarking module.
 *
 * Given a target domain and a list of competitor domains, fetches key SEO
 * signals for each and returns a comparative analysis covering:
 *   - Domain authority proxy (based on observable signals)
 *   - Content depth (page count estimate, word count, heading structure)
 *   - Technical SEO signals (meta tags, structured data, performance)
 *   - Keyword coverage proxy (unique H1/H2/title keywords)
 */

const USER_AGENT = 'OrbioLabs/1.0 (+https://orbiolab.com/bot) Mozilla/5.0 compatible';
const FETCH_TIMEOUT_MS = 12000;

async function benchmarkCompetitors(targetUrl, competitorUrls, options = {}) {
  const allUrls = [targetUrl, ...competitorUrls];
  const results = await Promise.allSettled(
    allUrls.map(url => analyzeCompetitor(url, options))
  );

  const analyses = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      analyses.push({ ...results[i].value, isTarget: i === 0 });
    } else {
      analyses.push({
        url: allUrls[i],
        domain: extractDomain(allUrls[i]),
        isTarget: i === 0,
        error: results[i].reason?.message || 'Fetch failed',
      });
    }
  }

  const target = analyses[0];
  const competitors = analyses.slice(1).filter(a => !a.error);

  // Build comparison summary
  const comparison = buildComparison(target, competitors);

  return {
    analyzedAt: new Date().toISOString(),
    target,
    competitors: analyses.slice(1),
    comparison,
  };
}

async function analyzeCompetitor(url, options = {}) {
  let targetUrl = url.trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }

  // Ensure we're fetching the homepage
  const parsed = new URL(targetUrl);
  const homepageUrl = `${parsed.protocol}//${parsed.hostname}`;
  const domain = parsed.hostname.replace(/^www\./, '');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || FETCH_TIMEOUT_MS);

  const startAt = Date.now();
  let response, html;
  try {
    response = await fetch(homepageUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    clearTimeout(timer);
    html = await response.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }

  const ttfbMs = Date.now() - startAt;
  const $ = cheerio.load(html);
  const pageSizeKb = Math.round(Buffer.byteLength(html, 'utf8') / 1024);

  // SEO signals
  const title = $('title').first().text().trim();
  const metaDescription = $('meta[name="description"]').attr('content') || '';
  const canonical = $('link[rel="canonical"]').attr('href') || '';
  const lang = $('html').attr('lang') || '';
  const viewport = $('meta[name="viewport"]').attr('content') || '';
  const ogTitle = $('meta[property="og:title"]').attr('content') || '';
  const ogImage = $('meta[property="og:image"]').attr('content') || '';

  // Headings
  const h1s = $('h1').map((_, el) => $(el).text().trim()).get();
  const h2s = $('h2').map((_, el) => $(el).text().trim()).get();
  const h3s = $('h3').map((_, el) => $(el).text().trim()).get();

  // Structured data
  const structuredDataTypes = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      if (data['@type']) structuredDataTypes.push(data['@type']);
    } catch (_e) { /* ignore */ }
  });

  // Links
  let internalLinks = 0, externalLinks = 0;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    try {
      const linkParsed = new URL(href, homepageUrl);
      if (linkParsed.hostname === parsed.hostname || linkParsed.hostname === 'www.' + parsed.hostname) {
        internalLinks++;
      } else {
        externalLinks++;
      }
    } catch (_e) { /* ignore */ }
  });

  // Word count
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const wordCount = bodyText ? bodyText.split(/\s+/).length : 0;

  // Keyword extraction from visible headings + title
  const allHeadingText = [...h1s, ...h2s, ...h3s, title].join(' ').toLowerCase();
  const keywords = extractKeywords(allHeadingText);

  // Compression
  const contentEncoding = response.headers.get('content-encoding') || '';
  const hasCompression = contentEncoding.includes('gzip') || contentEncoding.includes('br');

  // Security headers
  const hasHsts = !!response.headers.get('strict-transport-security');
  const isHttps = parsed.protocol === 'https:';

  // Compute a domain authority proxy score (0-100)
  // Based on observable on-page signals since we don't have API access
  const authoritySignals = computeAuthorityProxy({
    hasTitle: title.length > 0 && title.length <= 60,
    hasDescription: metaDescription.length >= 50 && metaDescription.length <= 160,
    hasCanonical: canonical.length > 0,
    hasLang: lang.length > 0,
    hasViewport: viewport.length > 0,
    hasOgTitle: ogTitle.length > 0,
    hasOgImage: ogImage.length > 0,
    hasStructuredData: structuredDataTypes.length > 0,
    hasCompression,
    isHttps,
    hasHsts,
    ttfbMs,
    wordCount,
    internalLinks,
    h1Count: h1s.length,
  });

  return {
    url: homepageUrl,
    domain,
    statusCode: response.status,
    ttfbMs,
    pageSizeKb,
    title,
    metaDescription: metaDescription.slice(0, 160),
    hasCanonical: canonical.length > 0,
    hasStructuredData: structuredDataTypes.length > 0,
    structuredDataTypes,
    hasCompression,
    isHttps,
    lang,
    h1Count: h1s.length,
    h2Count: h2s.length,
    wordCount,
    internalLinks,
    externalLinks,
    topKeywords: keywords.slice(0, 15),
    authorityProxy: authoritySignals,
  };
}

function computeAuthorityProxy(signals) {
  let score = 0;
  let maxScore = 0;

  const checks = [
    { name: 'Title tag optimized', pass: signals.hasTitle, weight: 8 },
    { name: 'Meta description present', pass: signals.hasDescription, weight: 7 },
    { name: 'Canonical URL set', pass: signals.hasCanonical, weight: 6 },
    { name: 'Language declared', pass: signals.hasLang, weight: 4 },
    { name: 'Mobile viewport set', pass: signals.hasViewport, weight: 8 },
    { name: 'Open Graph tags', pass: signals.hasOgTitle && signals.hasOgImage, weight: 5 },
    { name: 'Structured data', pass: signals.hasStructuredData, weight: 7 },
    { name: 'Response compression', pass: signals.hasCompression, weight: 6 },
    { name: 'HTTPS', pass: signals.isHttps, weight: 10 },
    { name: 'HSTS header', pass: signals.hasHsts, weight: 4 },
    { name: 'Fast server response', pass: signals.ttfbMs < 800, weight: 8 },
    { name: 'Substantive content', pass: signals.wordCount > 300, weight: 7 },
    { name: 'Internal linking', pass: signals.internalLinks >= 10, weight: 6 },
    { name: 'Single H1', pass: signals.h1Count === 1, weight: 5 },
  ];

  for (const check of checks) {
    maxScore += check.weight;
    if (check.pass) score += check.weight;
  }

  return {
    score: Math.round((score / maxScore) * 100),
    checks: checks.map(c => ({ name: c.name, pass: c.pass })),
  };
}

function extractKeywords(text) {
  const stopwords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
    'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'this', 'that', 'these', 'those',
    'it', 'its', 'i', 'we', 'you', 'your', 'our', 'my', 'his', 'her',
    'not', 'no', 'all', 'each', 'every', 'both', 'few', 'more', 'most',
    'other', 'some', 'such', 'than', 'too', 'very', 'just', 'about',
    'up', 'out', 'so', 'if', 'when', 'what', 'how', 'who', 'which',
    'get', 'new', 'one', 'two', 'also', 'into', 'over', 'after',
  ]);

  const words = text
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopwords.has(w));

  const freq = {};
  for (const w of words) {
    freq[w] = (freq[w] || 0) + 1;
  }

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .map(([word, count]) => ({ word, count }));
}

function extractDomain(url) {
  try {
    return new URL(url.includes('://') ? url : 'https://' + url).hostname.replace(/^www\./, '');
  } catch (_) {
    return url;
  }
}

function buildComparison(target, competitors) {
  if (!target || target.error || competitors.length === 0) {
    return { summary: 'Insufficient data for comparison.', strengths: [], weaknesses: [], opportunities: [] };
  }

  const strengths = [];
  const weaknesses = [];
  const opportunities = [];

  // Authority proxy comparison
  const targetAuth = target.authorityProxy?.score || 0;
  const avgCompAuth = avg(competitors.map(c => c.authorityProxy?.score || 0));
  if (targetAuth > avgCompAuth + 5) {
    strengths.push(`Your site's technical SEO score (${targetAuth}) is above the competitor average (${Math.round(avgCompAuth)}).`);
  } else if (targetAuth < avgCompAuth - 5) {
    weaknesses.push(`Your site's technical SEO score (${targetAuth}) is below the competitor average (${Math.round(avgCompAuth)}). Focus on the failing checks above.`);
  }

  // TTFB comparison
  const targetTtfb = target.ttfbMs || 0;
  const avgCompTtfb = avg(competitors.map(c => c.ttfbMs || 0));
  if (targetTtfb < avgCompTtfb * 0.8) {
    strengths.push(`Your server is faster (${targetTtfb}ms TTFB) than the competitor average (${Math.round(avgCompTtfb)}ms).`);
  } else if (targetTtfb > avgCompTtfb * 1.2) {
    weaknesses.push(`Your server is slower (${targetTtfb}ms TTFB) than the competitor average (${Math.round(avgCompTtfb)}ms). Consider a CDN or server optimization.`);
  }

  // Content depth
  const targetWords = target.wordCount || 0;
  const avgCompWords = avg(competitors.map(c => c.wordCount || 0));
  if (targetWords < avgCompWords * 0.7 && avgCompWords > 300) {
    weaknesses.push(`Your homepage has less content (${targetWords} words) than competitors (avg ${Math.round(avgCompWords)} words). Consider adding more substantive content.`);
  } else if (targetWords > avgCompWords * 1.3) {
    strengths.push(`Your homepage has more content (${targetWords} words) than competitors (avg ${Math.round(avgCompWords)} words).`);
  }

  // Internal linking
  const targetLinks = target.internalLinks || 0;
  const avgCompLinks = avg(competitors.map(c => c.internalLinks || 0));
  if (targetLinks < avgCompLinks * 0.5 && avgCompLinks > 5) {
    weaknesses.push(`Your homepage has fewer internal links (${targetLinks}) than competitors (avg ${Math.round(avgCompLinks)}). Internal linking helps distribute page authority.`);
  }

  // Structured data
  if (!target.hasStructuredData && competitors.some(c => c.hasStructuredData)) {
    opportunities.push('Competitors use structured data (JSON-LD) — adding it could enable rich search results for your site.');
  }

  // Keyword gap
  const targetKeywords = new Set((target.topKeywords || []).map(k => k.word));
  const competitorKeywords = new Set();
  for (const comp of competitors) {
    for (const kw of (comp.topKeywords || [])) {
      if (!targetKeywords.has(kw.word)) {
        competitorKeywords.add(kw.word);
      }
    }
  }
  const keywordGap = [...competitorKeywords].slice(0, 20);
  if (keywordGap.length > 0) {
    opportunities.push(`Keywords found in competitor headings but not yours: ${keywordGap.slice(0, 10).join(', ')}. Consider creating content targeting these terms.`);
  }

  // HTTPS
  if (!target.isHttps && competitors.some(c => c.isHttps)) {
    weaknesses.push('Competitors use HTTPS but your site does not. Migrate to HTTPS for security and SEO benefits.');
  }

  const summary = generateComparisonSummary(target, competitors, strengths, weaknesses);

  return {
    summary,
    strengths,
    weaknesses,
    opportunities,
    keywordGap,
  };
}

function generateComparisonSummary(target, competitors, strengths, weaknesses) {
  const competitorCount = competitors.length;
  const targetAuth = target.authorityProxy?.score || 0;
  const betterThan = competitors.filter(c => (c.authorityProxy?.score || 0) < targetAuth).length;

  if (weaknesses.length === 0 && strengths.length > 0) {
    return `Your site outperforms ${betterThan} of ${competitorCount} competitors on key technical SEO signals. Keep it up!`;
  }
  if (weaknesses.length > strengths.length) {
    return `Your site trails competitors in ${weaknesses.length} areas. Addressing these gaps could significantly improve your search visibility.`;
  }
  return `Your site is competitive with ${competitorCount} analyzed competitors, with ${strengths.length} strength(s) and ${weaknesses.length} area(s) to improve.`;
}

function avg(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((sum, v) => sum + v, 0) / arr.length;
}

module.exports = { benchmarkCompetitors };
