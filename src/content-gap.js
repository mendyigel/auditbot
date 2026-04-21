'use strict';

const fetch = require('node-fetch');
const cheerio = require('cheerio');

/**
 * Content gap analysis module.
 *
 * Identifies topics and keywords that competitors rank for but the target
 * site does not cover. Drives content strategy recommendations by surfacing
 * gaps that represent real traffic opportunities.
 *
 * Works in two modes:
 *   1. DataForSEO mode — fetches actual ranking data for both target and competitors
 *   2. Heuristic mode — deep HTML analysis of competitor pages to extract topic coverage
 */

const USER_AGENT = 'OrbioLabs/1.0 (+https://orbiolab.com/bot) Mozilla/5.0 compatible';
const FETCH_TIMEOUT_MS = 12000;

/**
 * Analyze content gaps between target and competitor domains.
 *
 * @param {string} targetUrl - Target site URL
 * @param {string[]} competitorUrls - 1-5 competitor URLs
 * @param {object} [targetCrawl] - Optional crawl data for target site
 * @param {object} [options] - { maxGaps, locationCode, languageCode }
 * @returns {object} Content gap analysis
 */
async function analyzeContentGaps(targetUrl, competitorUrls, targetCrawl, options = {}) {
  const targetDomain = extractDomain(targetUrl);
  const competitorDomains = competitorUrls.map(u => extractDomain(u));
  const hasApiAccess = !!(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);

  let gaps;
  if (hasApiAccess) {
    gaps = await fetchApiContentGaps(targetDomain, competitorDomains, options);
  } else {
    gaps = await buildHeuristicContentGaps(targetUrl, competitorUrls, targetCrawl, options);
  }

  const maxGaps = options.maxGaps || 30;
  gaps.sort((a, b) => b.opportunityScore - a.opportunityScore);
  const topGaps = gaps.slice(0, maxGaps);

  // Categorize gaps
  const categories = categorizeGaps(topGaps);

  // Compute aggregate stats
  const totalEstimatedTraffic = topGaps.reduce((s, g) => s + (g.estimatedMonthlyTraffic || 0), 0);
  const easyWins = topGaps.filter(g => g.difficulty === 'easy' || g.difficulty === 'moderate').length;

  return {
    analyzedAt: new Date().toISOString(),
    targetDomain,
    competitorDomains,
    dataSource: hasApiAccess ? 'dataforseo' : 'heuristic',
    totalGapsFound: gaps.length,
    topGapsReturned: topGaps.length,
    easyWins,
    totalEstimatedMonthlyTraffic: Math.round(totalEstimatedTraffic),
    categories,
    gaps: topGaps,
  };
}

/**
 * Use DataForSEO's domain intersection to find keywords competitors rank for
 * but the target does not.
 */
async function fetchApiContentGaps(targetDomain, competitorDomains, options = {}) {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  const auth = Buffer.from(`${login}:${password}`).toString('base64');
  const locationCode = options.locationCode || 2840;
  const languageCode = options.languageCode || 'en';

  const gaps = [];

  for (const compDomain of competitorDomains.slice(0, 5)) {
    try {
      const body = [{
        target1: compDomain,
        target2: targetDomain,
        location_code: locationCode,
        language_code: languageCode,
        intersections: {
          [compDomain]: true,
          [targetDomain]: false,
        },
        limit: 100,
        order_by: ['keyword_data.keyword_info.search_volume,desc'],
      }];

      const resp = await fetch('https://api.dataforseo.com/v3/dataforseo_labs/google/domain_intersection/live', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const data = await resp.json();

      if (data.tasks && data.tasks[0]?.result?.[0]?.items) {
        for (const item of data.tasks[0].result[0].items) {
          const kw = item.keyword_data;
          if (!kw?.keyword || !kw?.keyword_info?.search_volume) continue;

          const vol = kw.keyword_info.search_volume;
          const cpc = kw.keyword_info.cpc || 0;
          const competition = kw.keyword_info.competition || 0;
          const compPosition = item.first_domain_serp_element?.serp_item?.rank_group || 20;

          gaps.push({
            keyword: kw.keyword,
            searchVolume: vol,
            competitorDomain: compDomain,
            competitorPosition: compPosition,
            competition,
            cpc,
            estimatedMonthlyTraffic: estimateTrafficFromVolume(vol, compPosition),
            estimatedMonthlyValue: Math.round(estimateTrafficFromVolume(vol, compPosition) * (cpc || 0.5)),
            difficulty: classifyGapDifficulty(vol, competition, compPosition),
            opportunityScore: computeOpportunityScore(vol, competition, compPosition, cpc),
            contentRecommendation: recommendContent(kw.keyword, vol, competition),
          });
        }
      }
    } catch (err) {
      console.error(`[content-gap] DataForSEO error for ${compDomain}:`, err.message);
    }
  }

  // Deduplicate by keyword (keep highest opportunity score)
  return deduplicateGaps(gaps);
}

/**
 * Build content gaps from HTML analysis when no API access is available.
 * Deep-crawls competitor homepages and compares topic coverage.
 */
async function buildHeuristicContentGaps(targetUrl, competitorUrls, targetCrawl, options = {}) {
  // Extract target topics from crawl or quick fetch
  const targetTopics = await extractSiteTopics(targetUrl, targetCrawl);
  const targetTopicSet = new Set(targetTopics.map(t => t.topic.toLowerCase()));

  // Extract competitor topics
  const competitorTopicResults = await Promise.allSettled(
    competitorUrls.slice(0, 5).map(url => extractSiteTopics(url, null))
  );

  const gaps = [];

  for (let i = 0; i < competitorTopicResults.length; i++) {
    if (competitorTopicResults[i].status !== 'fulfilled') continue;

    const compTopics = competitorTopicResults[i].value;
    const compDomain = extractDomain(competitorUrls[i]);

    for (const topic of compTopics) {
      const topicKey = topic.topic.toLowerCase();
      if (targetTopicSet.has(topicKey)) continue;

      // Check if this topic is close to any existing target topic
      const isSimilar = [...targetTopicSet].some(t => topicOverlap(t, topicKey) > 0.6);
      if (isSimilar) continue;

      const estimatedVolume = estimateTopicVolume(topic);
      const competition = 0.5; // default heuristic
      const compPosition = estimateCompetitorPosition(topic);

      gaps.push({
        keyword: topic.topic,
        searchVolume: estimatedVolume,
        competitorDomain: compDomain,
        competitorPosition: compPosition,
        competition,
        cpc: estimateTopicCpc(topic),
        estimatedMonthlyTraffic: estimateTrafficFromVolume(estimatedVolume, compPosition),
        estimatedMonthlyValue: Math.round(estimateTrafficFromVolume(estimatedVolume, compPosition) * estimateTopicCpc(topic)),
        difficulty: classifyGapDifficulty(estimatedVolume, competition, compPosition),
        opportunityScore: computeOpportunityScore(estimatedVolume, competition, compPosition, estimateTopicCpc(topic)),
        contentRecommendation: recommendContent(topic.topic, estimatedVolume, competition),
        sourceContext: topic.context,
        isEstimate: true,
      });
    }
  }

  return deduplicateGaps(gaps);
}

/**
 * Extract topics from a site via crawling or existing crawl data.
 */
async function extractSiteTopics(url, crawlData) {
  const topics = [];

  if (crawlData && crawlData.pages) {
    for (const page of crawlData.pages) {
      addPageTopics(topics, page.title, page.h1, page.metaDescription, page.url);
    }
    return topics;
  }

  // Fetch homepage + up to 10 internal pages
  try {
    const { crawlSite } = require('./crawler');
    const quickCrawl = await crawlSite(url, { maxPages: 10 });
    for (const page of quickCrawl.pages || []) {
      addPageTopics(topics, page.title, page.h1, page.metaDescription, page.url);
    }
  } catch (err) {
    // Fallback: just fetch homepage
    try {
      const resp = await fetchPage(url);
      if (resp) {
        addPageTopics(topics, resp.title, resp.h1, resp.metaDescription, url);
      }
    } catch (_) { /* ignore */ }
  }

  return topics;
}

function addPageTopics(topics, title, h1, description, url) {
  const seen = new Set(topics.map(t => t.topic.toLowerCase()));

  const candidates = [
    ...(title ? extractTopicPhrases(title) : []),
    ...(h1 ? extractTopicPhrases(h1) : []),
    ...(description ? extractTopicPhrases(description) : []),
  ];

  for (const phrase of candidates) {
    const key = phrase.toLowerCase();
    if (!seen.has(key) && phrase.split(/\s+/).length >= 2) {
      seen.add(key);
      topics.push({
        topic: phrase,
        context: `Found in ${url}`,
        fromTitle: title && title.toLowerCase().includes(key),
        fromH1: h1 && h1.toLowerCase().includes(key),
      });
    }
  }
}

/**
 * Extract topic phrases from text.
 */
function extractTopicPhrases(text) {
  if (!text) return [];
  const stopwords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
    'has', 'have', 'had', 'this', 'that', 'it', 'its', 'we', 'you', 'your',
    'our', 'my', 'his', 'her', 'not', 'no', 'all', 'very', 'just', 'home',
  ]);

  const segments = text
    .replace(/[|–—·•]/g, ' | ')
    .split(/[|,;:()[\]{}]/)
    .map(s => s.trim())
    .filter(s => s.length > 3);

  const phrases = [];
  for (const segment of segments) {
    const words = segment.toLowerCase().split(/\s+/).filter(w => w.length > 1 && !/^\d+$/.test(w));
    while (words.length > 0 && stopwords.has(words[0])) words.shift();
    while (words.length > 0 && stopwords.has(words[words.length - 1])) words.pop();

    if (words.length >= 2 && words.length <= 5) {
      phrases.push(words.join(' '));
    }
  }

  return [...new Set(phrases)];
}

async function fetchPage(url) {
  let targetUrl = url.trim();
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(targetUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT },
    });
    clearTimeout(timer);
    const html = await response.text();
    const $ = cheerio.load(html);
    return {
      title: $('title').first().text().trim(),
      h1: $('h1').first().text().trim(),
      metaDescription: $('meta[name="description"]').attr('content') || '',
    };
  } catch (err) {
    clearTimeout(timer);
    return null;
  }
}

// ── Scoring helpers ────────────────────────────────────────────────────────

const CTR_BY_POSITION = {
  1: 0.316, 2: 0.241, 3: 0.186, 4: 0.101, 5: 0.075,
  6: 0.056, 7: 0.044, 8: 0.034, 9: 0.028, 10: 0.024,
  11: 0.015, 12: 0.013, 13: 0.011, 14: 0.010, 15: 0.009,
};

function estimateTrafficFromVolume(volume, position) {
  const ctr = CTR_BY_POSITION[Math.min(position, 15)] || 0.008;
  return Math.round(volume * ctr);
}

function computeOpportunityScore(volume, competition, compPosition, cpc) {
  // High volume + low competition + competitor ranking well + high CPC = big opportunity
  const volumeScore = Math.min(volume / 1000, 10);
  const competitionScore = (1 - competition) * 10;
  const positionScore = compPosition <= 5 ? 8 : compPosition <= 10 ? 6 : 4;
  const valueScore = Math.min(cpc * 2, 10);
  return Math.round(volumeScore * 3 + competitionScore * 2 + positionScore * 2 + valueScore * 1);
}

function classifyGapDifficulty(volume, competition, compPosition) {
  if (competition < 0.3 && volume < 1000) return 'easy';
  if (competition < 0.5 && compPosition > 5) return 'moderate';
  if (competition < 0.7) return 'challenging';
  return 'hard';
}

function recommendContent(keyword, volume, competition) {
  const words = keyword.split(/\s+/);
  if (competition < 0.3 && volume < 500) {
    return `Create a focused blog post targeting "${keyword}". Low competition makes this an easy win with minimal effort.`;
  }
  if (competition < 0.5) {
    return `Create a comprehensive guide or landing page for "${keyword}" with 1500+ words, FAQ section, and internal links from related pages.`;
  }
  if (words.length >= 4) {
    return `Create a detailed long-form piece targeting "${keyword}" as part of a content cluster. Support with 3-5 related articles linking to this hub.`;
  }
  return `Build a pillar page for "${keyword}" with supporting cluster content. This is competitive — invest in depth, original data, and outreach for backlinks.`;
}

function estimateTopicVolume(topic) {
  const words = topic.topic.split(/\s+/);
  let base = words.length <= 2 ? 1800 : words.length === 3 ? 720 : 320;

  if (topic.fromTitle && topic.fromH1) base *= 1.3;

  // Hash-based variance
  const hash = simpleHash(topic.topic);
  base *= 0.5 + (hash % 100) / 100;
  return Math.round(Math.max(50, base));
}

function estimateCompetitorPosition(topic) {
  // If topic is from title+H1, competitor is probably ranking well
  if (topic.fromTitle && topic.fromH1) return 5;
  if (topic.fromTitle) return 8;
  return 12;
}

function estimateTopicCpc(topic) {
  const words = topic.topic.toLowerCase().split(/\s+/);
  const highValue = ['software', 'platform', 'solution', 'enterprise', 'consulting', 'agency', 'service'];
  if (words.some(w => highValue.includes(w))) return 3.50;
  return 1.00;
}

function topicOverlap(a, b) {
  const wordsA = new Set(a.split(/\s+/));
  const wordsB = new Set(b.split(/\s+/));
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  return intersection / Math.max(wordsA.size, wordsB.size);
}

function deduplicateGaps(gaps) {
  const seen = new Map();
  for (const gap of gaps) {
    const key = gap.keyword.toLowerCase();
    if (!seen.has(key) || seen.get(key).opportunityScore < gap.opportunityScore) {
      seen.set(key, gap);
    }
  }
  return [...seen.values()];
}

function categorizeGaps(gaps) {
  const categories = {};
  for (const gap of gaps) {
    const words = gap.keyword.toLowerCase().split(/\s+/);
    // Simple topic categorization
    let category = 'general';
    const categoryKeywords = {
      'product': ['software', 'tool', 'app', 'platform', 'product', 'solution', 'feature'],
      'how-to': ['how', 'guide', 'tutorial', 'learn', 'tips', 'steps', 'setup'],
      'comparison': ['vs', 'versus', 'compare', 'comparison', 'alternative', 'best', 'top'],
      'industry': ['industry', 'market', 'trend', 'report', 'statistics', 'data', 'research'],
      'pricing': ['price', 'pricing', 'cost', 'plan', 'free', 'trial', 'discount'],
    };

    for (const [cat, kws] of Object.entries(categoryKeywords)) {
      if (words.some(w => kws.includes(w))) {
        category = cat;
        break;
      }
    }

    if (!categories[category]) {
      categories[category] = { count: 0, totalTraffic: 0, keywords: [] };
    }
    categories[category].count++;
    categories[category].totalTraffic += gap.estimatedMonthlyTraffic || 0;
    categories[category].keywords.push(gap.keyword);
  }

  return categories;
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

module.exports = { analyzeContentGaps };
