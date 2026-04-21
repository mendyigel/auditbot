'use strict';

const fetch = require('node-fetch');
const cheerio = require('cheerio');

/**
 * Multi-page crawler.
 *
 * Crawls a site starting from a given URL, following internal links up to a
 * configurable depth/page limit. Returns a site-wide structural analysis:
 *   - page inventory with per-page metadata
 *   - internal link graph
 *   - orphan pages (pages with no inbound internal links)
 *   - duplicate content detection (duplicate titles / meta descriptions)
 *   - indexation gaps (pages blocked by robots or missing canonical)
 */

const DEFAULT_MAX_PAGES = 25;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_CONCURRENCY = 3;
const USER_AGENT = 'OrbioLabs/1.0 (+https://orbiolab.com/bot) Mozilla/5.0 compatible';

async function crawlSite(startUrl, options = {}) {
  const maxPages = options.maxPages || DEFAULT_MAX_PAGES;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const concurrency = options.concurrency || DEFAULT_CONCURRENCY;

  const baseUrl = new URL(startUrl);
  const baseHostname = baseUrl.hostname;

  // State
  const visited = new Map();   // url -> page info
  const queue = [normalizeUrl(startUrl)];
  const inboundLinks = {};     // url -> Set of source urls
  const outboundLinks = {};    // url -> [dest urls]
  const errors = [];

  while (queue.length > 0 && visited.size < maxPages) {
    const batch = queue.splice(0, concurrency);
    const results = await Promise.allSettled(
      batch.map(url => crawlPage(url, baseHostname, timeoutMs))
    );

    for (let i = 0; i < results.length; i++) {
      const url = batch[i];
      if (visited.has(url)) continue;

      if (results[i].status === 'rejected') {
        errors.push({ url, error: results[i].reason?.message || 'Unknown error' });
        visited.set(url, { url, error: true });
        continue;
      }

      const page = results[i].value;
      visited.set(url, page);
      outboundLinks[url] = page.internalLinkUrls || [];

      for (const linked of page.internalLinkUrls || []) {
        const norm = normalizeUrl(linked);
        if (!inboundLinks[norm]) inboundLinks[norm] = new Set();
        inboundLinks[norm].add(url);

        if (!visited.has(norm) && !queue.includes(norm) && visited.size + queue.length < maxPages) {
          queue.push(norm);
        }
      }
    }
  }

  // Build analysis
  const pages = [];
  for (const [url, info] of visited) {
    if (info.error) continue;
    pages.push({
      url,
      title: info.title,
      metaDescription: info.metaDescription,
      statusCode: info.statusCode,
      canonical: info.canonical,
      robotsMeta: info.robotsMeta,
      h1: info.h1,
      wordCount: info.wordCount,
      internalLinkCount: (outboundLinks[url] || []).length,
      inboundLinkCount: (inboundLinks[url] ? inboundLinks[url].size : 0),
    });
  }

  // Orphan pages: crawled pages with 0 inbound internal links (except start page)
  const startNorm = normalizeUrl(startUrl);
  const orphanPages = pages.filter(
    p => p.url !== startNorm && (!inboundLinks[p.url] || inboundLinks[p.url].size === 0)
  );

  // Duplicate titles
  const titleMap = {};
  for (const p of pages) {
    if (p.title && p.title.length > 0) {
      const key = p.title.toLowerCase().trim();
      if (!titleMap[key]) titleMap[key] = [];
      titleMap[key].push(p.url);
    }
  }
  const duplicateTitles = Object.entries(titleMap)
    .filter(([, urls]) => urls.length > 1)
    .map(([title, urls]) => ({ title, urls }));

  // Duplicate meta descriptions
  const descMap = {};
  for (const p of pages) {
    if (p.metaDescription && p.metaDescription.length > 0) {
      const key = p.metaDescription.toLowerCase().trim();
      if (!descMap[key]) descMap[key] = [];
      descMap[key].push(p.url);
    }
  }
  const duplicateDescriptions = Object.entries(descMap)
    .filter(([, urls]) => urls.length > 1)
    .map(([description, urls]) => ({ description: description.slice(0, 100) + '...', urls }));

  // Indexation gaps
  const indexationIssues = [];
  for (const p of pages) {
    const issues = [];
    if (p.robotsMeta && p.robotsMeta.includes('noindex')) {
      issues.push('noindex directive');
    }
    if (!p.canonical) {
      issues.push('missing canonical');
    }
    if (p.statusCode >= 400) {
      issues.push(`HTTP ${p.statusCode}`);
    }
    if (issues.length > 0) {
      indexationIssues.push({ url: p.url, issues });
    }
  }

  // Missing titles / descriptions
  const missingTitles = pages.filter(p => !p.title || p.title.length === 0).map(p => p.url);
  const missingDescriptions = pages.filter(p => !p.metaDescription || p.metaDescription.length === 0).map(p => p.url);

  // Thin content pages (< 300 words)
  const thinContentPages = pages
    .filter(p => p.wordCount < 300)
    .map(p => ({ url: p.url, wordCount: p.wordCount }));

  return {
    crawledAt: new Date().toISOString(),
    startUrl: startNorm,
    pagesCrawled: pages.length,
    pagesErrored: errors.length,
    maxPagesLimit: maxPages,
    pages,
    orphanPages,
    duplicateTitles,
    duplicateDescriptions,
    indexationIssues,
    missingTitles,
    missingDescriptions,
    thinContentPages,
    errors,
    linkGraph: {
      nodes: pages.map(p => p.url),
      edges: Object.entries(outboundLinks).flatMap(([from, tos]) =>
        tos.map(to => ({ from, to }))
      ),
    },
  };
}

async function crawlPage(url, baseHostname, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response, html;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    clearTimeout(timer);

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      return { url, statusCode: response.status, title: '', metaDescription: '', canonical: '', robotsMeta: '', h1: '', wordCount: 0, internalLinkUrls: [] };
    }

    html = await response.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }

  const $ = cheerio.load(html);
  const title = $('title').first().text().trim();
  const metaDescription = $('meta[name="description"]').attr('content') || '';
  const canonical = $('link[rel="canonical"]').attr('href') || '';
  const robotsMeta = $('meta[name="robots"]').attr('content') || '';
  const h1 = $('h1').first().text().trim();

  // Word count from visible text
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const wordCount = bodyText ? bodyText.split(/\s+/).length : 0;

  // Collect internal links
  const internalLinkUrls = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return;
    try {
      const parsed = new URL(href, url);
      if (parsed.hostname === baseHostname && parsed.protocol.startsWith('http')) {
        internalLinkUrls.push(normalizeUrl(parsed.href));
      }
    } catch (_e) { /* ignore malformed */ }
  });

  return {
    url,
    statusCode: response.status,
    title,
    metaDescription,
    canonical,
    robotsMeta,
    h1,
    wordCount,
    internalLinkUrls: [...new Set(internalLinkUrls)],
  };
}

function normalizeUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    // Remove trailing slash, fragment, and common tracking params
    u.hash = '';
    u.searchParams.delete('utm_source');
    u.searchParams.delete('utm_medium');
    u.searchParams.delete('utm_campaign');
    u.searchParams.delete('utm_content');
    u.searchParams.delete('utm_term');
    let path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.protocol}//${u.hostname}${path}${u.search}`;
  } catch (_) {
    return urlStr;
  }
}

module.exports = { crawlSite };
