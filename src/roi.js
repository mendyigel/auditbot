'use strict';

/**
 * ROI framing module.
 *
 * Translates every audit recommendation into estimated traffic and revenue
 * impact. Instead of "add an H1 tag", the report says "adding this landing
 * page could capture ~X monthly searches worth ~$Y/month."
 *
 * Uses industry-standard CTR curves, conversion rate benchmarks, and
 * search volume estimates to produce actionable business-oriented framing.
 */

// Google organic CTR by position (based on Advanced Web Ranking / Sistrix studies)
const CTR_BY_POSITION = {
  1: 0.316, 2: 0.241, 3: 0.186, 4: 0.101, 5: 0.075,
  6: 0.056, 7: 0.044, 8: 0.034, 9: 0.028, 10: 0.024,
  11: 0.015, 12: 0.013, 13: 0.011, 14: 0.010, 15: 0.009,
  16: 0.008, 17: 0.007, 18: 0.006, 19: 0.005, 20: 0.005,
};

// Average organic conversion rate benchmarks by industry
const INDUSTRY_CONVERSION_RATES = {
  ecommerce: 0.029,
  saas: 0.031,
  finance: 0.051,
  healthcare: 0.033,
  education: 0.028,
  realestate: 0.024,
  travel: 0.021,
  default: 0.025,
};

// Average order value / lead value by industry (USD)
const INDUSTRY_VALUES = {
  ecommerce: 85,
  saas: 120,
  finance: 200,
  healthcare: 150,
  education: 60,
  realestate: 300,
  travel: 180,
  default: 100,
};

/**
 * Frame all audit findings with ROI estimates.
 *
 * @param {object} audit - The single-page audit result
 * @param {object} [extras] - { crawl, competitor, keywords, contentGaps }
 * @param {object} [options] - { industry, avgOrderValue, conversionRate }
 * @returns {object} ROI-framed insights
 */
function frameRoi(audit, extras, options = {}) {
  const industry = options.industry || detectIndustry(audit);
  const conversionRate = options.conversionRate || INDUSTRY_CONVERSION_RATES[industry] || INDUSTRY_CONVERSION_RATES.default;
  const avgValue = options.avgOrderValue || INDUSTRY_VALUES[industry] || INDUSTRY_VALUES.default;

  const result = {
    industry,
    conversionRate,
    avgValue,
    recommendations: [],
    summary: null,
  };

  // Frame SEO issues
  if (audit.seo) {
    result.recommendations.push(...frameSeoIssues(audit.seo, conversionRate, avgValue));
  }

  // Frame performance issues
  if (audit.performance) {
    result.recommendations.push(...framePerfIssues(audit.performance, conversionRate, avgValue));
  }

  // Frame accessibility issues
  if (audit.accessibility) {
    result.recommendations.push(...frameA11yIssues(audit.accessibility, conversionRate, avgValue));
  }

  // Frame crawl issues
  if (extras?.crawl) {
    result.recommendations.push(...frameCrawlIssues(extras.crawl, conversionRate, avgValue));
  }

  // Frame keyword opportunities
  if (extras?.keywords?.opportunities) {
    result.recommendations.push(...frameKeywordOpportunities(extras.keywords, conversionRate, avgValue));
  }

  // Frame content gaps
  if (extras?.contentGaps?.gaps) {
    result.recommendations.push(...frameContentGaps(extras.contentGaps, conversionRate, avgValue));
  }

  // Sort by estimated monthly value (descending)
  result.recommendations.sort((a, b) => b.estimatedMonthlyValue - a.estimatedMonthlyValue);

  // Build executive summary
  const totalMonthlyTraffic = result.recommendations.reduce((s, r) => s + (r.estimatedMonthlyTraffic || 0), 0);
  const totalMonthlyValue = result.recommendations.reduce((s, r) => s + (r.estimatedMonthlyValue || 0), 0);
  const totalAnnualValue = totalMonthlyValue * 12;

  result.summary = {
    totalRecommendations: result.recommendations.length,
    totalEstimatedMonthlyTrafficGain: Math.round(totalMonthlyTraffic),
    totalEstimatedMonthlyValue: Math.round(totalMonthlyValue),
    totalEstimatedAnnualValue: Math.round(totalAnnualValue),
    topRecommendation: result.recommendations[0] || null,
    quickWins: result.recommendations.filter(r => r.effort === 'low' && r.estimatedMonthlyValue > 0).length,
    executiveSummary: buildExecutiveSummary(result.recommendations, totalMonthlyTraffic, totalAnnualValue),
  };

  return result;
}

// ── SEO issue framing ──────────────────────────────────────────────────────

function frameSeoIssues(seo, conversionRate, avgValue) {
  const recs = [];

  for (const issue of seo.issues || []) {
    const rec = frameSingleIssue(issue, 'seo', conversionRate, avgValue);
    if (rec) recs.push(rec);
  }

  return recs;
}

function framePerfIssues(perf, conversionRate, avgValue) {
  const recs = [];

  for (const issue of perf.issues || []) {
    const rec = frameSingleIssue(issue, 'performance', conversionRate, avgValue);
    if (rec) recs.push(rec);
  }

  return recs;
}

function frameA11yIssues(a11y, conversionRate, avgValue) {
  const recs = [];

  for (const issue of a11y.issues || []) {
    const rec = frameSingleIssue(issue, 'accessibility', conversionRate, avgValue);
    if (rec) recs.push(rec);
  }

  return recs;
}

const ISSUE_IMPACT_MAP = {
  // SEO issues
  'missing title': { trafficMultiplier: 0.15, effort: 'low', rankBoost: 5 },
  'title too long': { trafficMultiplier: 0.03, effort: 'low', rankBoost: 1 },
  'title too short': { trafficMultiplier: 0.03, effort: 'low', rankBoost: 1 },
  'missing meta description': { trafficMultiplier: 0.08, effort: 'low', rankBoost: 2 },
  'meta description too long': { trafficMultiplier: 0.02, effort: 'low', rankBoost: 1 },
  'meta description too short': { trafficMultiplier: 0.02, effort: 'low', rankBoost: 1 },
  'missing h1': { trafficMultiplier: 0.10, effort: 'low', rankBoost: 3 },
  'multiple h1': { trafficMultiplier: 0.05, effort: 'low', rankBoost: 2 },
  'missing canonical': { trafficMultiplier: 0.06, effort: 'low', rankBoost: 2 },
  'noindex': { trafficMultiplier: 0.25, effort: 'low', rankBoost: 10 },
  'missing lang': { trafficMultiplier: 0.02, effort: 'low', rankBoost: 1 },
  'missing open graph': { trafficMultiplier: 0.04, effort: 'low', rankBoost: 1 },
  'missing structured data': { trafficMultiplier: 0.07, effort: 'medium', rankBoost: 2 },
  'missing viewport': { trafficMultiplier: 0.08, effort: 'low', rankBoost: 3 },
  // Performance issues
  'slow server': { trafficMultiplier: 0.10, effort: 'high', rankBoost: 3 },
  'large page': { trafficMultiplier: 0.05, effort: 'medium', rankBoost: 2 },
  'render-blocking': { trafficMultiplier: 0.06, effort: 'medium', rankBoost: 2 },
  'no compression': { trafficMultiplier: 0.04, effort: 'low', rankBoost: 1 },
  'missing lazy loading': { trafficMultiplier: 0.03, effort: 'medium', rankBoost: 1 },
  // Accessibility
  'missing alt text': { trafficMultiplier: 0.04, effort: 'low', rankBoost: 1 },
  'missing form labels': { trafficMultiplier: 0.02, effort: 'low', rankBoost: 0 },
  'heading hierarchy': { trafficMultiplier: 0.03, effort: 'low', rankBoost: 1 },
  'missing skip nav': { trafficMultiplier: 0.01, effort: 'low', rankBoost: 0 },
  'missing main landmark': { trafficMultiplier: 0.01, effort: 'low', rankBoost: 0 },
};

function frameSingleIssue(issueText, category, conversionRate, avgValue) {
  const issueLower = (typeof issueText === 'string' ? issueText : '').toLowerCase();

  // Find matching impact profile
  let impact = null;
  let matchKey = '';
  for (const [key, val] of Object.entries(ISSUE_IMPACT_MAP)) {
    if (issueLower.includes(key)) {
      impact = val;
      matchKey = key;
      break;
    }
  }

  if (!impact) {
    // Default framing for unrecognized issues
    impact = { trafficMultiplier: 0.02, effort: 'medium', rankBoost: 1 };
  }

  // Estimate baseline monthly organic traffic (conservative: 500 visits/month for an average page)
  const baselineTraffic = 500;
  const trafficGain = Math.round(baselineTraffic * impact.trafficMultiplier);
  const conversions = trafficGain * conversionRate;
  const monthlyValue = Math.round(conversions * avgValue);

  return {
    issue: issueText,
    category,
    effort: impact.effort,
    estimatedRankImprovement: impact.rankBoost,
    estimatedMonthlyTraffic: trafficGain,
    estimatedMonthlyConversions: Math.round(conversions * 100) / 100,
    estimatedMonthlyValue: monthlyValue,
    estimatedAnnualValue: monthlyValue * 12,
    roiFrame: buildIssueRoiFrame(issueText, trafficGain, monthlyValue, impact),
  };
}

function buildIssueRoiFrame(issue, trafficGain, monthlyValue, impact) {
  if (trafficGain === 0 && monthlyValue === 0) {
    return `Fixing this improves user experience and code quality but has minimal direct traffic impact.`;
  }

  const effortLabel = impact.effort === 'low' ? '< 1 hour' : impact.effort === 'medium' ? '1-4 hours' : '4+ hours';
  const parts = [];

  if (trafficGain > 0) {
    parts.push(`could recover ~${trafficGain} monthly visits`);
  }
  if (monthlyValue > 0) {
    parts.push(`worth ~$${monthlyValue}/mo ($${monthlyValue * 12}/yr)`);
  }
  parts.push(`estimated effort: ${effortLabel}`);

  return `Fixing this ${parts.join(', ')}.`;
}

// ── Crawl issue framing ────────────────────────────────────────────────────

function frameCrawlIssues(crawl, conversionRate, avgValue) {
  const recs = [];

  if (crawl.orphanPages && crawl.orphanPages.length > 0) {
    const count = crawl.orphanPages.length;
    const trafficPerPage = 80;
    const totalTraffic = count * trafficPerPage;
    const monthlyValue = Math.round(totalTraffic * conversionRate * avgValue);

    recs.push({
      issue: `${count} orphan page(s) — no internal links pointing to them`,
      category: 'crawl',
      effort: 'low',
      estimatedRankImprovement: 3,
      estimatedMonthlyTraffic: totalTraffic,
      estimatedMonthlyConversions: Math.round(totalTraffic * conversionRate * 100) / 100,
      estimatedMonthlyValue: monthlyValue,
      estimatedAnnualValue: monthlyValue * 12,
      roiFrame: `Adding internal links to ${count} orphan page(s) could recover ~${totalTraffic} monthly visits worth ~$${monthlyValue}/mo. These pages are invisible to search engines right now.`,
    });
  }

  if (crawl.indexationIssues && crawl.indexationIssues.length > 0) {
    const count = crawl.indexationIssues.length;
    const trafficPerPage = 150;
    const totalTraffic = count * trafficPerPage;
    const monthlyValue = Math.round(totalTraffic * conversionRate * avgValue);

    recs.push({
      issue: `${count} page(s) with indexation problems (noindex, missing canonical, HTTP errors)`,
      category: 'crawl',
      effort: 'medium',
      estimatedRankImprovement: 5,
      estimatedMonthlyTraffic: totalTraffic,
      estimatedMonthlyConversions: Math.round(totalTraffic * conversionRate * 100) / 100,
      estimatedMonthlyValue: monthlyValue,
      estimatedAnnualValue: monthlyValue * 12,
      roiFrame: `Fixing indexation on ${count} page(s) could unlock ~${totalTraffic} monthly visits worth ~$${monthlyValue}/mo. These pages are blocked from appearing in search results entirely.`,
    });
  }

  if (crawl.duplicateTitles && crawl.duplicateTitles.length > 0) {
    const count = crawl.duplicateTitles.length;
    const trafficGain = count * 40;
    const monthlyValue = Math.round(trafficGain * conversionRate * avgValue);

    recs.push({
      issue: `${count} duplicate title tag(s) causing keyword cannibalization`,
      category: 'crawl',
      effort: 'low',
      estimatedRankImprovement: 2,
      estimatedMonthlyTraffic: trafficGain,
      estimatedMonthlyConversions: Math.round(trafficGain * conversionRate * 100) / 100,
      estimatedMonthlyValue: monthlyValue,
      estimatedAnnualValue: monthlyValue * 12,
      roiFrame: `Unique title tags for ${count} page(s) could add ~${trafficGain} monthly visits worth ~$${monthlyValue}/mo by eliminating keyword cannibalization.`,
    });
  }

  if (crawl.thinContentPages && crawl.thinContentPages.length > 0) {
    const count = crawl.thinContentPages.length;
    const trafficGain = count * 60;
    const monthlyValue = Math.round(trafficGain * conversionRate * avgValue);

    recs.push({
      issue: `${count} thin content page(s) (<300 words)`,
      category: 'crawl',
      effort: 'high',
      estimatedRankImprovement: 3,
      estimatedMonthlyTraffic: trafficGain,
      estimatedMonthlyConversions: Math.round(trafficGain * conversionRate * 100) / 100,
      estimatedMonthlyValue: monthlyValue,
      estimatedAnnualValue: monthlyValue * 12,
      roiFrame: `Expanding ${count} thin page(s) to 800+ words could add ~${trafficGain} monthly visits worth ~$${monthlyValue}/mo.`,
    });
  }

  return recs;
}

// ── Keyword opportunity framing ────────────────────────────────────────────

function frameKeywordOpportunities(keywordsResult, conversionRate, avgValue) {
  const recs = [];

  // Group quick wins (position 8-12) and medium opportunities (13-20)
  const quickWins = (keywordsResult.opportunities || []).filter(o => o.currentPosition >= 8 && o.currentPosition <= 12);
  const mediumOpps = (keywordsResult.opportunities || []).filter(o => o.currentPosition >= 13 && o.currentPosition <= 20);

  if (quickWins.length > 0) {
    const totalTraffic = quickWins.reduce((s, o) => s + o.estimatedMonthlyTrafficGain, 0);
    const monthlyValue = Math.round(totalTraffic * conversionRate * avgValue);
    const topKeywords = quickWins.slice(0, 5).map(o => `"${o.keyword}"`).join(', ');

    recs.push({
      issue: `${quickWins.length} keyword(s) in striking distance (positions 8-12)`,
      category: 'keywords',
      effort: 'medium',
      estimatedRankImprovement: 5,
      estimatedMonthlyTraffic: Math.round(totalTraffic),
      estimatedMonthlyConversions: Math.round(totalTraffic * conversionRate * 100) / 100,
      estimatedMonthlyValue: monthlyValue,
      estimatedAnnualValue: monthlyValue * 12,
      roiFrame: `Optimizing ${quickWins.length} keyword(s) already on page 1-2 (${topKeywords}) could add ~${Math.round(totalTraffic)} monthly visits worth ~$${monthlyValue}/mo. These need minor on-page improvements to break into the top 5.`,
      keywords: quickWins.slice(0, 10).map(o => ({ keyword: o.keyword, position: o.currentPosition, volume: o.searchVolume })),
    });
  }

  if (mediumOpps.length > 0) {
    const totalTraffic = mediumOpps.reduce((s, o) => s + o.estimatedMonthlyTrafficGain, 0);
    const monthlyValue = Math.round(totalTraffic * conversionRate * avgValue);

    recs.push({
      issue: `${mediumOpps.length} keyword(s) on page 2 (positions 13-20) with growth potential`,
      category: 'keywords',
      effort: 'high',
      estimatedRankImprovement: 8,
      estimatedMonthlyTraffic: Math.round(totalTraffic),
      estimatedMonthlyConversions: Math.round(totalTraffic * conversionRate * 100) / 100,
      estimatedMonthlyValue: monthlyValue,
      estimatedAnnualValue: monthlyValue * 12,
      roiFrame: `Moving ${mediumOpps.length} page-2 keyword(s) to page 1 could add ~${Math.round(totalTraffic)} monthly visits worth ~$${monthlyValue}/mo. Requires content expansion and link building.`,
      keywords: mediumOpps.slice(0, 10).map(o => ({ keyword: o.keyword, position: o.currentPosition, volume: o.searchVolume })),
    });
  }

  return recs;
}

// ── Content gap framing ────────────────────────────────────────────────────

function frameContentGaps(contentGapsResult, conversionRate, avgValue) {
  const recs = [];
  const gaps = contentGapsResult.gaps || [];

  if (gaps.length === 0) return recs;

  const easyGaps = gaps.filter(g => g.difficulty === 'easy' || g.difficulty === 'moderate');
  const hardGaps = gaps.filter(g => g.difficulty === 'challenging' || g.difficulty === 'hard');

  if (easyGaps.length > 0) {
    const totalTraffic = easyGaps.reduce((s, g) => s + (g.estimatedMonthlyTraffic || 0), 0);
    const monthlyValue = Math.round(totalTraffic * conversionRate * avgValue);
    const topKeywords = easyGaps.slice(0, 5).map(g => `"${g.keyword}"`).join(', ');

    recs.push({
      issue: `${easyGaps.length} low-competition content gap(s) your competitors rank for`,
      category: 'content-gaps',
      effort: 'medium',
      estimatedRankImprovement: null,
      estimatedMonthlyTraffic: Math.round(totalTraffic),
      estimatedMonthlyConversions: Math.round(totalTraffic * conversionRate * 100) / 100,
      estimatedMonthlyValue: monthlyValue,
      estimatedAnnualValue: monthlyValue * 12,
      roiFrame: `Creating content for ${easyGaps.length} gap(s) (${topKeywords}) could capture ~${Math.round(totalTraffic)} monthly visits worth ~$${monthlyValue}/mo that currently go to competitors.`,
      gaps: easyGaps.slice(0, 10).map(g => ({ keyword: g.keyword, volume: g.searchVolume, competitor: g.competitorDomain })),
    });
  }

  if (hardGaps.length > 0) {
    const totalTraffic = hardGaps.reduce((s, g) => s + (g.estimatedMonthlyTraffic || 0), 0);
    const monthlyValue = Math.round(totalTraffic * conversionRate * avgValue);

    recs.push({
      issue: `${hardGaps.length} competitive content gap(s) — high-value but requiring investment`,
      category: 'content-gaps',
      effort: 'high',
      estimatedRankImprovement: null,
      estimatedMonthlyTraffic: Math.round(totalTraffic),
      estimatedMonthlyConversions: Math.round(totalTraffic * conversionRate * 100) / 100,
      estimatedMonthlyValue: monthlyValue,
      estimatedAnnualValue: monthlyValue * 12,
      roiFrame: `Targeting ${hardGaps.length} competitive topic(s) could capture ~${Math.round(totalTraffic)} monthly visits worth ~$${monthlyValue}/mo, but requires comprehensive content + link building.`,
      gaps: hardGaps.slice(0, 10).map(g => ({ keyword: g.keyword, volume: g.searchVolume, competitor: g.competitorDomain })),
    });
  }

  return recs;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function detectIndustry(audit) {
  const text = [audit.url || '', audit.seo?.title || '', audit.seo?.metaDescription || ''].join(' ').toLowerCase();

  const patterns = {
    ecommerce: /shop|store|buy|cart|product|price|shipping|checkout/,
    saas: /software|saas|platform|dashboard|api|integration|pricing plan/,
    finance: /bank|finance|loan|mortgage|invest|insurance|credit/,
    healthcare: /health|medical|doctor|patient|clinic|hospital|therapy/,
    education: /learn|course|education|school|university|training|student/,
    realestate: /real estate|property|homes|listing|apartment|rent/,
    travel: /travel|hotel|flight|booking|destination|vacation|tour/,
  };

  for (const [industry, pattern] of Object.entries(patterns)) {
    if (pattern.test(text)) return industry;
  }

  return 'default';
}

function buildExecutiveSummary(recommendations, totalMonthlyTraffic, totalAnnualValue) {
  const quickWins = recommendations.filter(r => r.effort === 'low');
  const quickWinValue = quickWins.reduce((s, r) => s + r.estimatedMonthlyValue, 0);
  const quickWinTraffic = quickWins.reduce((s, r) => s + r.estimatedMonthlyTraffic, 0);

  const parts = [];

  if (totalAnnualValue > 0) {
    parts.push(`We identified ${recommendations.length} improvement(s) with a combined estimated annual value of ~$${Math.round(totalAnnualValue).toLocaleString()}.`);
  }

  if (quickWins.length > 0 && quickWinValue > 0) {
    parts.push(`${quickWins.length} quick win(s) require minimal effort and could add ~${Math.round(quickWinTraffic)} monthly visits worth ~$${Math.round(quickWinValue)}/mo.`);
  }

  if (totalMonthlyTraffic > 500) {
    parts.push(`The total addressable traffic opportunity is ~${Math.round(totalMonthlyTraffic)} additional monthly organic visits.`);
  }

  return parts.join(' ') || 'No significant traffic opportunities identified at this time.';
}

module.exports = { frameRoi, CTR_BY_POSITION, INDUSTRY_CONVERSION_RATES, INDUSTRY_VALUES };
