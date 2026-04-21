'use strict';

const fetch = require('node-fetch');
const cheerio = require('cheerio');

/**
 * Keyword opportunity mapping module.
 *
 * Surfaces pages ranking in positions 8-20 ("striking distance") that are
 * worth optimizing. Uses DataForSEO API when configured, otherwise falls
 * back to heuristic keyword extraction from crawl data.
 *
 * Env vars (optional):
 *   DATAFORSEO_LOGIN    — DataForSEO API login
 *   DATAFORSEO_PASSWORD — DataForSEO API password
 */

const USER_AGENT = 'OrbioLabs/1.0 (+https://orbiolab.com/bot) Mozilla/5.0 compatible';
const FETCH_TIMEOUT_MS = 12000;

// Google CTR curve by position (approximate, based on industry studies)
const CTR_BY_POSITION = {
  1: 0.316, 2: 0.241, 3: 0.186, 4: 0.101, 5: 0.075,
  6: 0.056, 7: 0.044, 8: 0.034, 9: 0.028, 10: 0.024,
  11: 0.015, 12: 0.013, 13: 0.011, 14: 0.010, 15: 0.009,
  16: 0.008, 17: 0.007, 18: 0.006, 19: 0.005, 20: 0.005,
};

/**
 * Map keyword opportunities for a domain.
 *
 * @param {string} targetUrl - The site URL to analyze
 * @param {object} [crawlData] - Optional crawl result from crawler.js
 * @param {object} [options] - { maxKeywords, locationCode, languageCode }
 * @returns {object} Keyword opportunity map
 */
async function mapKeywordOpportunities(targetUrl, crawlData, options = {}) {
  const domain = extractDomain(targetUrl);
  const hasApiAccess = !!(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);

  let opportunities;
  if (hasApiAccess) {
    opportunities = await fetchDataForSeoOpportunities(domain, options);
  } else {
    opportunities = await buildHeuristicOpportunities(targetUrl, crawlData, options);
  }

  // Sort by estimated traffic gain (descending)
  opportunities.sort((a, b) => b.estimatedMonthlyTrafficGain - a.estimatedMonthlyTrafficGain);

  const maxKeywords = options.maxKeywords || 50;
  const topOpportunities = opportunities.slice(0, maxKeywords);

  // Compute aggregate stats
  const totalEstimatedGain = topOpportunities.reduce((s, o) => s + o.estimatedMonthlyTrafficGain, 0);
  const strikingDistanceCount = topOpportunities.filter(o => o.currentPosition >= 8 && o.currentPosition <= 20).length;
  const quickWinCount = topOpportunities.filter(o => o.currentPosition >= 8 && o.currentPosition <= 12).length;

  return {
    analyzedAt: new Date().toISOString(),
    domain,
    dataSource: hasApiAccess ? 'dataforseo' : 'heuristic',
    totalOpportunities: opportunities.length,
    strikingDistanceCount,
    quickWinCount,
    totalEstimatedMonthlyTrafficGain: Math.round(totalEstimatedGain),
    opportunities: topOpportunities,
  };
}

/**
 * Fetch real ranking + volume data from DataForSEO.
 */
async function fetchDataForSeoOpportunities(domain, options = {}) {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  const auth = Buffer.from(`${login}:${password}`).toString('base64');
  const locationCode = options.locationCode || 2840; // US
  const languageCode = options.languageCode || 'en';

  // Step 1: Get ranked keywords for the domain
  const rankedKeywordsBody = [{
    target: domain,
    location_code: locationCode,
    language_code: languageCode,
    filters: [
      ['ranked_serp_element.serp_item.rank_group', '>=', 4],
      'and',
      ['ranked_serp_element.serp_item.rank_group', '<=', 30],
    ],
    limit: 200,
    order_by: ['ranked_serp_element.serp_item.rank_group,asc'],
  }];

  let rankedKeywords = [];
  try {
    const resp = await fetch('https://api.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(rankedKeywordsBody),
    });
    const data = await resp.json();

    if (data.tasks && data.tasks[0] && data.tasks[0].result) {
      const items = data.tasks[0].result[0]?.items || [];
      rankedKeywords = items.map(item => ({
        keyword: item.keyword_data?.keyword || '',
        searchVolume: item.keyword_data?.keyword_info?.search_volume || 0,
        currentPosition: item.ranked_serp_element?.serp_item?.rank_group || 0,
        url: item.ranked_serp_element?.serp_item?.url || '',
        competition: item.keyword_data?.keyword_info?.competition || 0,
        cpc: item.keyword_data?.keyword_info?.cpc || 0,
      }));
    }
  } catch (err) {
    console.error('[keywords] DataForSEO ranked_keywords error:', err.message);
  }

  // Build opportunities from ranked keywords
  return rankedKeywords
    .filter(kw => kw.keyword && kw.searchVolume > 0 && kw.currentPosition >= 4)
    .map(kw => {
      const targetPosition = Math.max(1, kw.currentPosition - estimateRankImprovement(kw));
      const currentCtr = CTR_BY_POSITION[Math.min(kw.currentPosition, 20)] || 0.005;
      const targetCtr = CTR_BY_POSITION[targetPosition] || CTR_BY_POSITION[1];
      const currentTraffic = Math.round(kw.searchVolume * currentCtr);
      const potentialTraffic = Math.round(kw.searchVolume * targetCtr);

      return {
        keyword: kw.keyword,
        url: kw.url,
        searchVolume: kw.searchVolume,
        currentPosition: kw.currentPosition,
        targetPosition,
        currentMonthlyTraffic: currentTraffic,
        potentialMonthlyTraffic: potentialTraffic,
        estimatedMonthlyTrafficGain: potentialTraffic - currentTraffic,
        competition: kw.competition,
        cpc: kw.cpc,
        estimatedMonthlyValueGain: Math.round((potentialTraffic - currentTraffic) * (kw.cpc || 0.5)),
        difficulty: classifyDifficulty(kw.currentPosition, kw.competition),
        action: suggestAction(kw.currentPosition, kw.url),
      };
    });
}

/**
 * Build heuristic opportunities from crawl data when no API is available.
 * Extracts keywords from page titles/headings and estimates search volumes
 * using word-length and topic-based heuristics.
 */
async function buildHeuristicOpportunities(targetUrl, crawlData, options = {}) {
  const pages = crawlData?.pages || [];

  // If no crawl data provided, do a quick crawl of a few pages
  if (pages.length === 0) {
    try {
      const { crawlSite } = require('./crawler');
      const quickCrawl = await crawlSite(targetUrl, { maxPages: 15 });
      pages.push(...(quickCrawl.pages || []));
    } catch (err) {
      console.error('[keywords] Quick crawl failed:', err.message);
    }
  }

  // Extract keyword candidates from each page
  const opportunities = [];
  for (const page of pages) {
    const keywords = extractPageKeywords(page);
    for (const kw of keywords) {
      // Estimate a heuristic search volume based on keyword characteristics
      const estimatedVolume = estimateSearchVolume(kw.phrase);
      // Assign a heuristic position based on page signals
      const estimatedPosition = estimateCurrentPosition(page, kw);

      if (estimatedPosition >= 8 && estimatedPosition <= 30 && estimatedVolume > 50) {
        const targetPosition = Math.max(1, estimatedPosition - estimateRankImprovement({ currentPosition: estimatedPosition, competition: 0.5 }));
        const currentCtr = CTR_BY_POSITION[Math.min(estimatedPosition, 20)] || 0.005;
        const targetCtr = CTR_BY_POSITION[targetPosition] || CTR_BY_POSITION[1];
        const currentTraffic = Math.round(estimatedVolume * currentCtr);
        const potentialTraffic = Math.round(estimatedVolume * targetCtr);

        opportunities.push({
          keyword: kw.phrase,
          url: page.url,
          searchVolume: estimatedVolume,
          currentPosition: estimatedPosition,
          targetPosition,
          currentMonthlyTraffic: currentTraffic,
          potentialMonthlyTraffic: potentialTraffic,
          estimatedMonthlyTrafficGain: potentialTraffic - currentTraffic,
          competition: 0.5,
          cpc: estimateAvgCpc(kw.phrase),
          estimatedMonthlyValueGain: Math.round((potentialTraffic - currentTraffic) * estimateAvgCpc(kw.phrase)),
          difficulty: classifyDifficulty(estimatedPosition, 0.5),
          action: suggestAction(estimatedPosition, page.url),
          isEstimate: true,
        });
      }
    }
  }

  // Deduplicate by keyword (keep highest traffic gain)
  const seen = new Map();
  for (const opp of opportunities) {
    const key = opp.keyword.toLowerCase();
    if (!seen.has(key) || seen.get(key).estimatedMonthlyTrafficGain < opp.estimatedMonthlyTrafficGain) {
      seen.set(key, opp);
    }
  }

  return [...seen.values()];
}

/**
 * Extract keyword phrases from a crawled page's metadata.
 */
function extractPageKeywords(page) {
  const keywords = [];
  const seen = new Set();

  const sources = [
    { text: page.title || '', weight: 3 },
    { text: page.h1 || '', weight: 3 },
    { text: page.metaDescription || '', weight: 2 },
  ];

  for (const { text, weight } of sources) {
    const phrases = extractPhrases(text);
    for (const phrase of phrases) {
      const key = phrase.toLowerCase();
      if (!seen.has(key) && phrase.split(/\s+/).length >= 2 && phrase.split(/\s+/).length <= 5) {
        seen.add(key);
        keywords.push({ phrase, weight });
      }
    }
  }

  return keywords;
}

/**
 * Extract meaningful multi-word phrases from text.
 */
function extractPhrases(text) {
  if (!text) return [];
  const stopwords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
    'has', 'have', 'had', 'this', 'that', 'it', 'its', 'we', 'you', 'your',
    'our', 'my', 'his', 'her', 'not', 'no', 'all', 'very', 'just', '|', '-',
  ]);

  // Split on punctuation and common separators
  const segments = text
    .replace(/[|–—·•]/g, ' | ')
    .split(/[|,;:()[\]{}]/)
    .map(s => s.trim())
    .filter(s => s.length > 3);

  const phrases = [];
  for (const segment of segments) {
    const words = segment.toLowerCase().split(/\s+/).filter(w => w.length > 1);
    // Remove leading/trailing stopwords
    while (words.length > 0 && stopwords.has(words[0])) words.shift();
    while (words.length > 0 && stopwords.has(words[words.length - 1])) words.pop();

    if (words.length >= 2 && words.length <= 5) {
      phrases.push(words.join(' '));
    }
    // Also try bigrams and trigrams from longer segments
    if (words.length > 3) {
      for (let i = 0; i <= words.length - 2; i++) {
        const bigram = words.slice(i, i + 2).filter(w => !stopwords.has(w));
        if (bigram.length === 2) phrases.push(bigram.join(' '));
      }
      for (let i = 0; i <= words.length - 3; i++) {
        const trigram = words.slice(i, i + 3).filter(w => !stopwords.has(w));
        if (trigram.length >= 2) phrases.push(trigram.join(' '));
      }
    }
  }

  return [...new Set(phrases)];
}

/**
 * Heuristic search volume estimate based on keyword characteristics.
 * Returns estimated monthly searches.
 */
function estimateSearchVolume(keyword) {
  const words = keyword.split(/\s+/);
  const wordCount = words.length;

  // Base volume by word count (longer-tail = lower volume)
  let base;
  if (wordCount <= 2) base = 2400;
  else if (wordCount === 3) base = 880;
  else if (wordCount === 4) base = 390;
  else base = 170;

  // Boost for commercial/transactional intent words
  const commercialWords = ['buy', 'best', 'top', 'review', 'compare', 'price', 'cost', 'cheap', 'deal', 'discount', 'free', 'software', 'tool', 'service', 'agency', 'company', 'platform', 'app'];
  const hasCommercial = words.some(w => commercialWords.includes(w));
  if (hasCommercial) base *= 1.4;

  // Reduce for very niche/technical terms
  const nicheWords = ['api', 'sdk', 'integration', 'middleware', 'webhook', 'schema', 'deployment'];
  const hasNiche = words.some(w => nicheWords.includes(w));
  if (hasNiche) base *= 0.4;

  // Add some variance based on keyword hash
  const hash = simpleHash(keyword);
  const variance = 0.5 + (hash % 100) / 100; // 0.5x to 1.5x
  base *= variance;

  return Math.round(Math.max(50, base));
}

/**
 * Estimate current ranking position based on page signals.
 */
function estimateCurrentPosition(page, keyword) {
  let score = 15; // default mid-range position

  // Strong title match → likely ranking better
  if (page.title && page.title.toLowerCase().includes(keyword.phrase.toLowerCase())) {
    score -= 4;
  }

  // H1 match
  if (page.h1 && page.h1.toLowerCase().includes(keyword.phrase.toLowerCase())) {
    score -= 2;
  }

  // Good word count signals content depth
  if (page.wordCount > 1000) score -= 2;
  else if (page.wordCount > 500) score -= 1;

  // Good internal linking signals authority
  if (page.inboundLinkCount > 5) score -= 1;
  if (page.internalLinkCount > 10) score -= 1;

  // Clamp to striking distance range
  return Math.max(4, Math.min(30, score));
}

/**
 * Estimate average CPC for a keyword phrase.
 */
function estimateAvgCpc(keyword) {
  const words = keyword.split(/\s+/);
  const highValueWords = ['software', 'insurance', 'lawyer', 'attorney', 'mortgage', 'loan', 'enterprise', 'saas', 'crm', 'erp', 'consulting', 'agency'];
  const medValueWords = ['service', 'company', 'platform', 'tool', 'review', 'best', 'top', 'compare', 'buy', 'hire'];

  if (words.some(w => highValueWords.includes(w))) return 4.50;
  if (words.some(w => medValueWords.includes(w))) return 2.00;
  return 0.80;
}

/**
 * Estimate realistic rank improvement based on current position and competition.
 */
function estimateRankImprovement(kw) {
  const pos = kw.currentPosition;
  const competition = kw.competition || 0.5;

  // Easier to move up from position 8-12 (page 1 bottom / page 2 top)
  if (pos >= 8 && pos <= 12) return Math.round(3 + (1 - competition) * 4);
  if (pos >= 13 && pos <= 20) return Math.round(4 + (1 - competition) * 5);
  if (pos > 20) return Math.round(5 + (1 - competition) * 6);
  return Math.round(2 + (1 - competition) * 2); // positions 4-7
}

function classifyDifficulty(position, competition) {
  if (position <= 10 && competition < 0.4) return 'easy';
  if (position <= 15 && competition < 0.6) return 'moderate';
  if (position <= 20 && competition < 0.8) return 'challenging';
  return 'hard';
}

function suggestAction(position, url) {
  if (position >= 8 && position <= 12) {
    return 'Quick win — optimize title tag, add internal links, and expand content to push into top 5.';
  }
  if (position >= 13 && position <= 20) {
    return 'Build out content depth, add FAQ schema, and acquire 2-3 quality backlinks.';
  }
  if (position > 20) {
    return 'Create comprehensive pillar content targeting this keyword cluster with supporting internal links.';
  }
  return 'Fine-tune on-page signals and build topical authority with supporting content.';
}

function extractDomain(url) {
  try {
    return new URL(url.includes('://') ? url : 'https://' + url).hostname.replace(/^www\./, '');
  } catch (_) {
    return url;
  }
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

module.exports = { mapKeywordOpportunities, CTR_BY_POSITION };
