'use strict';

/**
 * roadmap.js — AI-generated SEO roadmap using Claude API.
 *
 * Generates prioritized 30/60/90-day SEO action plans tailored to
 * the site's vertical, current state, and competitive landscape.
 */

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.ROADMAP_MODEL || 'claude-haiku-4-5-20251001';

/**
 * Generate an AI-powered SEO roadmap.
 *
 * @param {Object} opts
 * @param {string} opts.url - Site URL
 * @param {Object} opts.snapshot - Latest audit snapshot
 * @param {Array} opts.trends - Last 5 trend data points
 * @param {Object} opts.competitorScores - Competitor benchmark data
 * @param {string|null} opts.vertical - Industry vertical
 * @returns {Object} Structured roadmap JSON
 */
async function generateRoadmap({ url, snapshot, trends = [], competitorScores = {}, vertical = null }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  // Fallback to heuristic roadmap if API key not configured
  if (!apiKey) {
    console.log('[roadmap] ANTHROPIC_API_KEY not set — using heuristic roadmap');
    return generateHeuristicRoadmap({ url, snapshot, trends, competitorScores, vertical });
  }

  const client = new Anthropic({ apiKey });

  const trendSummary = trends.length > 0
    ? trends.map((t, i) => `  ${i + 1}. Overall: ${t.overallScore}, SEO: ${t.seoScore}, Perf: ${t.performanceScore}, A11y: ${t.accessibilityScore}`).join('\n')
    : '  No historical data available yet.';

  const competitorSummary = Object.keys(competitorScores).length > 0
    ? Object.entries(competitorScores).map(([compUrl, scores]) =>
        `  ${compUrl}: SEO=${scores.seo}, Perf=${scores.performance}, A11y=${scores.accessibility}`
      ).join('\n')
    : '  No competitor data.';

  const issuesSummary = (snapshot.issues || []).slice(0, 20)
    .map(issue => `  - [${issue.severity || 'info'}] ${issue.title || issue.message || JSON.stringify(issue)}`)
    .join('\n');

  const prompt = `You are an expert SEO consultant. Based on the following audit data for ${url}, generate a prioritized 30/60/90-day SEO action plan.

## Current Scores
- SEO: ${snapshot.seoScore}/100
- Performance: ${snapshot.performanceScore}/100
- Accessibility: ${snapshot.accessibilityScore}/100
- Overall: ${snapshot.overallScore}/100

## Top Issues Found
${issuesSummary || '  No issues detected.'}

## Historical Trends
${trendSummary}

## Competitor Benchmarks
${competitorSummary}

${vertical ? `## Industry Vertical: ${vertical}` : ''}

## Rules
- Prioritize by estimated traffic impact (highest ROI first)
- Group actions by phase: Quick Wins (30d), Foundation (60d), Growth (90d)
- Each action needs: title, description, estimated effort (hours), expected impact (high/medium/low), category (seo/performance/accessibility/content)
- Be specific and actionable — reference actual issues found
- Consider the competitive landscape

Respond with ONLY valid JSON matching this structure:
{
  "summary": "High-level assessment string",
  "vertical": "detected vertical",
  "phases": [
    {
      "name": "Quick Wins",
      "timeframe": "30 days",
      "actions": [
        {
          "title": "Action title",
          "category": "seo",
          "effort_hours": 2,
          "impact": "high",
          "reasoning": "Why this matters",
          "steps": ["Step 1", "Step 2"]
        }
      ]
    }
  ],
  "estimated_total_impact": {
    "monthly_traffic_gain": 0,
    "summary": "Impact summary"
  }
}`;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text || '';
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[roadmap] Could not parse JSON from Claude response');
      return generateHeuristicRoadmap({ url, snapshot, trends, competitorScores, vertical });
    }

    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('[roadmap] Claude API error:', err.message);
    return generateHeuristicRoadmap({ url, snapshot, trends, competitorScores, vertical });
  }
}

/**
 * Fallback heuristic roadmap when Claude API is unavailable.
 */
function generateHeuristicRoadmap({ url, snapshot, vertical }) {
  const actions = [];

  // Quick wins based on scores
  if (snapshot.seoScore < 70) {
    actions.push({
      title: 'Fix critical SEO issues',
      category: 'seo',
      effort_hours: 4,
      impact: 'high',
      reasoning: `SEO score is ${snapshot.seoScore}/100 — addressing critical issues will have immediate impact.`,
      steps: ['Review meta tags on all pages', 'Add missing alt attributes', 'Fix broken links', 'Ensure proper heading hierarchy'],
    });
  }

  if (snapshot.performanceScore < 70) {
    actions.push({
      title: 'Optimize page load performance',
      category: 'performance',
      effort_hours: 6,
      impact: 'high',
      reasoning: `Performance score is ${snapshot.performanceScore}/100 — slow pages hurt both UX and SEO rankings.`,
      steps: ['Compress and optimize images', 'Enable browser caching', 'Minify CSS and JavaScript', 'Consider lazy loading for below-fold content'],
    });
  }

  if (snapshot.accessibilityScore < 70) {
    actions.push({
      title: 'Address accessibility gaps',
      category: 'accessibility',
      effort_hours: 4,
      impact: 'medium',
      reasoning: `Accessibility score is ${snapshot.accessibilityScore}/100 — improving accessibility broadens your audience and improves SEO.`,
      steps: ['Add ARIA labels to interactive elements', 'Ensure sufficient color contrast', 'Add form labels', 'Test keyboard navigation'],
    });
  }

  // Always suggest content work
  actions.push({
    title: 'Develop content strategy',
    category: 'content',
    effort_hours: 8,
    impact: 'medium',
    reasoning: 'Consistent, quality content is the foundation of long-term SEO growth.',
    steps: ['Identify top 10 keywords for your vertical', 'Create content calendar', 'Optimize existing high-traffic pages', 'Plan new content targeting long-tail keywords'],
  });

  return {
    summary: `Site ${url} scores ${snapshot.overallScore}/100 overall. ${snapshot.overallScore < 60 ? 'Significant improvements needed across multiple areas.' : snapshot.overallScore < 80 ? 'Good foundation with room for optimization.' : 'Strong performance — focus on maintaining and expanding.'}`,
    vertical: vertical || 'general',
    phases: [
      {
        name: 'Quick Wins',
        timeframe: '30 days',
        actions: actions.filter(a => a.impact === 'high'),
      },
      {
        name: 'Foundation',
        timeframe: '60 days',
        actions: actions.filter(a => a.impact === 'medium'),
      },
      {
        name: 'Growth',
        timeframe: '90 days',
        actions: [{
          title: 'Expand content and link building',
          category: 'content',
          effort_hours: 16,
          impact: 'high',
          reasoning: 'After fixing fundamentals, growth comes from content authority and backlinks.',
          steps: ['Guest posting on industry blogs', 'Create linkable assets (tools, studies)', 'Monitor competitor content strategies', 'Build relationships with industry sites'],
        }],
      },
    ],
    estimated_total_impact: {
      monthly_traffic_gain: Math.round(snapshot.overallScore < 60 ? 500 : snapshot.overallScore < 80 ? 250 : 100),
      summary: 'Estimated based on current scores and typical improvement patterns.',
    },
  };
}

module.exports = { generateRoadmap };
