'use strict';

/**
 * Interpretation layer for audit reports.
 *
 * Adds plain-English explanations, severity labels, ranked fix lists,
 * and benchmark comparisons for every audit finding.
 */

// ── Severity levels ──────────────────────────────────────────────────────────

const SEVERITY = { CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };

// ── Score benchmarks (based on HTTPArchive / CrUX public data) ───────────────

const BENCHMARKS = {
  seo: { median: 82, top25: 95, label: 'SEO' },
  performance: { median: 55, top25: 80, label: 'Performance' },
  accessibility: { median: 68, top25: 90, label: 'Accessibility' },
  overall: { median: 65, top25: 85, label: 'Overall' },
};

// ── Score interpretation ─────────────────────────────────────────────────────

function interpretScore(category, score) {
  const bench = BENCHMARKS[category];
  if (!bench) return null;

  let comparison;
  if (score >= bench.top25) {
    comparison = `Your ${bench.label} score of ${score} is in the top 25% of websites (above ${bench.top25}).`;
  } else if (score >= bench.median) {
    comparison = `Your ${bench.label} score of ${score} is above the median of ${bench.median} but below the top 25% mark of ${bench.top25}.`;
  } else {
    const pctBelow = Math.round(((bench.median - score) / bench.median) * 100);
    comparison = `Your ${bench.label} score of ${score} is below the median of ${bench.median} for most websites — roughly ${pctBelow}% lower than average.`;
  }

  let advice;
  if (score >= 80) {
    advice = 'This area is in good shape. Focus on maintaining it.';
  } else if (score >= 50) {
    advice = 'There are clear opportunities to improve. Addressing the issues below would have a noticeable impact.';
  } else {
    advice = 'This area needs urgent attention. Visitors and search engines are likely being negatively affected right now.';
  }

  return { score, comparison, advice };
}

// ── Metric interpretations ───────────────────────────────────────────────────

function interpretMetrics(audit) {
  const interpretations = {};

  // TTFB
  const ttfb = audit.ttfbMs;
  if (ttfb < 200) {
    interpretations.ttfb = `Your server responds in ${ttfb}ms — that's excellent. Under 200ms means your server and hosting are fast.`;
  } else if (ttfb < 800) {
    interpretations.ttfb = `Your server responds in ${ttfb}ms — that's acceptable but not great. Aim for under 200ms for a snappy experience. Consider server-side caching or a CDN.`;
  } else {
    interpretations.ttfb = `Your server takes ${ttfb}ms to respond. That's slow — users are waiting almost ${(ttfb / 1000).toFixed(1)} seconds before the page even starts loading. This likely means a slow server, no caching, or missing CDN.`;
  }

  // Page size
  const sizeKb = audit.pageSizeKb;
  if (sizeKb < 100) {
    interpretations.pageSize = `Your HTML is ${sizeKb} KB — lean and fast. This helps pages load quickly, especially on mobile.`;
  } else if (sizeKb < 200) {
    interpretations.pageSize = `Your HTML is ${sizeKb} KB — within the acceptable range but could be trimmed. Consider minifying HTML and removing unused code.`;
  } else {
    interpretations.pageSize = `Your HTML is ${sizeKb} KB — that's heavy. Pages over 200 KB take noticeably longer to download, especially on slower connections. Minify your HTML and remove inline assets.`;
  }

  // Render-blocking resources
  const perf = audit.performance;
  if (perf.renderBlockingJs > 0) {
    interpretations.renderBlockingJs = `${perf.renderBlockingJs} script(s) block your page from rendering. Every blocking script adds delay — the browser must download and execute each one before showing content. Add async or defer attributes.`;
  }
  if (perf.renderBlockingCss > 2) {
    interpretations.renderBlockingCss = `${perf.renderBlockingCss} stylesheets are blocking rendering. While CSS is render-blocking by nature, too many separate files slow things down. Consider combining stylesheets or inlining critical CSS.`;
  }

  // Images
  if (perf.imagesWithoutSrcset > 0) {
    interpretations.images = `${perf.imagesWithoutSrcset} of ${perf.imagesTotal} images lack srcset or lazy loading. This means mobile users download full-size desktop images, and images below the fold load immediately — both waste bandwidth and slow the page.`;
  }

  // Compression
  if (!perf.contentEncoding || (!perf.contentEncoding.includes('gzip') && !perf.contentEncoding.includes('br'))) {
    interpretations.compression = `Your server is not compressing responses. Enabling gzip or brotli typically reduces transfer size by 60-80%, making pages load significantly faster.`;
  }

  return interpretations;
}

// ── Severity classification for each check ───────────────────────────────────

const ISSUE_SEVERITY_MAP = {
  // SEO issues
  'Title missing or too long': SEVERITY.HIGH,
  'Meta description missing or out of 50–160 range': SEVERITY.HIGH,
  'Page should have exactly one H1': SEVERITY.MEDIUM,
  'No canonical URL defined': SEVERITY.HIGH,
  'Page has noindex directive': SEVERITY.CRITICAL,
  'Missing lang attribute on <html>': SEVERITY.MEDIUM,
  'Missing og:title': SEVERITY.LOW,
  'Missing og:image': SEVERITY.LOW,
  'No JSON-LD structured data found': SEVERITY.LOW,
  'Missing viewport meta (mobile-unfriendly)': SEVERITY.CRITICAL,

  // Performance issues
  'HTML payload too large': SEVERITY.MEDIUM,
  'Slow time-to-first-byte': SEVERITY.HIGH,
  'HTTP error status': SEVERITY.CRITICAL,
  'render-blocking <script>': SEVERITY.HIGH,
  'stylesheets may block rendering': SEVERITY.MEDIUM,
  'image(s) missing srcset or loading="lazy"': SEVERITY.MEDIUM,
  'Response not compressed': SEVERITY.HIGH,

  // Accessibility issues
  'image(s) missing alt attribute': SEVERITY.HIGH,
  'form input(s) missing label or aria-label': SEVERITY.HIGH,
  'Heading levels are skipped': SEVERITY.MEDIUM,
  'No skip-navigation link detected': SEVERITY.LOW,
  'No <main> landmark': SEVERITY.MEDIUM,
  'Missing lang attribute — screen readers cannot select voice': SEVERITY.MEDIUM,
  'button(s) have no visible or accessible name': SEVERITY.HIGH,
};

function classifySeverity(issueText) {
  for (const [pattern, severity] of Object.entries(ISSUE_SEVERITY_MAP)) {
    if (issueText.includes(pattern)) return severity;
  }
  return SEVERITY.MEDIUM; // default
}

// ── Impact and effort scoring for fix prioritization ─────────────────────────

const FIX_DETAILS = {
  'noindex directive': {
    title: 'Remove noindex directive',
    impact: 10, effort: 1, effortLabel: 'Quick fix (< 10 min)',
    why: 'Your page is invisible to search engines. Removing noindex is a one-line change that immediately makes you discoverable.',
  },
  'Missing viewport meta': {
    title: 'Add viewport meta tag',
    impact: 10, effort: 1, effortLabel: 'Quick fix (< 10 min)',
    why: 'Without a viewport tag, your site looks broken on mobile. Google penalizes non-mobile-friendly sites in search results.',
  },
  'HTTP error status': {
    title: 'Fix HTTP error response',
    impact: 10, effort: 3, effortLabel: 'Significant (> 1 hour)',
    why: 'Your page returns an error status code. Search engines will not index it and users see an error page.',
  },
  'Response not compressed': {
    title: 'Enable gzip or brotli compression',
    impact: 8, effort: 1, effortLabel: 'Quick fix (< 10 min)',
    why: 'Compression reduces transfer size by 60-80%. This is usually a single server config change with major speed gains.',
  },
  'Slow time-to-first-byte': {
    title: 'Improve server response time (TTFB)',
    impact: 8, effort: 3, effortLabel: 'Significant (> 1 hour)',
    why: 'A slow server delays everything. Consider caching, a CDN, or upgrading hosting.',
  },
  'Title missing or too long': {
    title: 'Fix page title tag',
    impact: 8, effort: 1, effortLabel: 'Quick fix (< 10 min)',
    why: 'The title tag is the most important on-page SEO element. It appears in search results and browser tabs.',
  },
  'Meta description missing': {
    title: 'Add or fix meta description',
    impact: 7, effort: 1, effortLabel: 'Quick fix (< 10 min)',
    why: 'A good meta description improves click-through rates from search results. Without one, Google picks random page text.',
  },
  'No canonical URL': {
    title: 'Set a canonical URL',
    impact: 7, effort: 1, effortLabel: 'Quick fix (< 10 min)',
    why: 'Without a canonical URL, search engines may treat duplicate pages as separate, diluting your ranking.',
  },
  'render-blocking <script>': {
    title: 'Defer render-blocking scripts',
    impact: 7, effort: 1, effortLabel: 'Quick fix (< 10 min)',
    why: 'Render-blocking scripts delay page display. Adding async or defer lets the page show content while scripts load.',
  },
  'image(s) missing alt attribute': {
    title: 'Add alt text to images',
    impact: 7, effort: 2, effortLabel: 'Medium (< 1 hour)',
    why: 'Alt text is essential for screen reader users and helps search engines understand your images.',
  },
  'form input(s) missing label': {
    title: 'Label all form inputs',
    impact: 7, effort: 2, effortLabel: 'Medium (< 1 hour)',
    why: 'Unlabelled form fields are unusable for screen reader users and violate WCAG accessibility standards.',
  },
  'button(s) have no visible or accessible name': {
    title: 'Add accessible names to buttons',
    impact: 7, effort: 1, effortLabel: 'Quick fix (< 10 min)',
    why: 'Unnamed buttons are meaningless to screen reader users. Add visible text or aria-label.',
  },
  'exactly one H1': {
    title: 'Fix H1 heading structure',
    impact: 5, effort: 1, effortLabel: 'Quick fix (< 10 min)',
    why: 'Having exactly one H1 helps search engines understand your page topic. Multiple or missing H1s confuse ranking signals.',
  },
  'HTML payload too large': {
    title: 'Reduce HTML payload size',
    impact: 5, effort: 2, effortLabel: 'Medium (< 1 hour)',
    why: 'Large HTML slows initial page load, especially on mobile networks. Minify and remove unused inline content.',
  },
  'image(s) missing srcset or loading="lazy"': {
    title: 'Optimize images with srcset and lazy loading',
    impact: 6, effort: 2, effortLabel: 'Medium (< 1 hour)',
    why: 'Without responsive images and lazy loading, mobile users download unnecessarily large files and off-screen images load immediately.',
  },
  'stylesheets may block rendering': {
    title: 'Reduce render-blocking stylesheets',
    impact: 5, effort: 2, effortLabel: 'Medium (< 1 hour)',
    why: 'Too many stylesheets delay first paint. Combine them or inline critical CSS.',
  },
  'No <main> landmark': {
    title: 'Add a <main> landmark',
    impact: 4, effort: 1, effortLabel: 'Quick fix (< 10 min)',
    why: 'Screen reader users cannot skip to your main content without a <main> element.',
  },
  'Heading levels are skipped': {
    title: 'Fix heading hierarchy',
    impact: 4, effort: 1, effortLabel: 'Quick fix (< 10 min)',
    why: 'Skipping heading levels (e.g. H1 to H3) confuses screen readers and hurts document structure.',
  },
  'Missing lang attribute': {
    title: 'Add lang attribute to <html>',
    impact: 4, effort: 1, effortLabel: 'Quick fix (< 10 min)',
    why: 'Screen readers need the lang attribute to select the correct pronunciation. Also helps SEO.',
  },
  'No skip-navigation link': {
    title: 'Add a skip navigation link',
    impact: 3, effort: 1, effortLabel: 'Quick fix (< 10 min)',
    why: 'Keyboard users must tab through your entire navigation before reaching content. A skip link saves them time.',
  },
  'Missing og:title': {
    title: 'Add Open Graph title',
    impact: 3, effort: 1, effortLabel: 'Quick fix (< 10 min)',
    why: 'Without og:title, social media shares of your page use a generic or missing title, reducing click-through.',
  },
  'Missing og:image': {
    title: 'Add Open Graph image',
    impact: 3, effort: 1, effortLabel: 'Quick fix (< 10 min)',
    why: 'Social shares without an image get much less engagement. A good og:image can significantly boost sharing.',
  },
  'No JSON-LD structured data': {
    title: 'Add structured data (JSON-LD)',
    impact: 3, effort: 2, effortLabel: 'Medium (< 1 hour)',
    why: 'Structured data enables rich search results (star ratings, FAQ dropdowns, etc.) which increase click-through rates.',
  },
};

function matchFixDetail(issueText) {
  for (const [pattern, detail] of Object.entries(FIX_DETAILS)) {
    if (issueText.includes(pattern)) return detail;
  }
  return null;
}

// ── Build prioritized fix list ───────────────────────────────────────────────

function buildTopFixes(audit, maxFixes) {
  maxFixes = maxFixes || 5;
  const allIssues = [];

  const categories = [
    { name: 'SEO', data: audit.seo },
    { name: 'Performance', data: audit.performance },
    { name: 'Accessibility', data: audit.accessibility },
  ];

  for (const cat of categories) {
    for (const issue of cat.data.issues) {
      const severity = classifySeverity(issue);
      const detail = matchFixDetail(issue);
      const priorityScore = detail ? detail.impact * (4 - detail.effort) : severityToScore(severity);

      allIssues.push({
        category: cat.name,
        issue,
        severity,
        title: detail ? detail.title : shortenIssue(issue),
        impact: detail ? impactLabel(detail.impact) : severityToImpactLabel(severity),
        effort: detail ? detail.effortLabel : 'Unknown',
        why: detail ? detail.why : issue,
        priorityScore,
      });
    }
  }

  // Sort by priority score descending (highest impact + easiest first)
  allIssues.sort((a, b) => b.priorityScore - a.priorityScore);

  return allIssues.slice(0, maxFixes);
}

function severityToScore(sev) {
  switch (sev) {
    case SEVERITY.CRITICAL: return 30;
    case SEVERITY.HIGH: return 20;
    case SEVERITY.MEDIUM: return 10;
    default: return 5;
  }
}

function impactLabel(score) {
  if (score >= 9) return 'Critical';
  if (score >= 7) return 'High';
  if (score >= 4) return 'Medium';
  return 'Low';
}

function severityToImpactLabel(sev) {
  switch (sev) {
    case SEVERITY.CRITICAL: return 'Critical';
    case SEVERITY.HIGH: return 'High';
    case SEVERITY.MEDIUM: return 'Medium';
    default: return 'Low';
  }
}

function shortenIssue(text) {
  // Take first sentence or first 60 chars
  const first = text.split(/[.!—]/)[0].trim();
  return first.length > 60 ? first.slice(0, 57) + '...' : first;
}

// ── Classify all issues with severity ────────────────────────────────────────

function classifyAllIssues(issues) {
  return issues.map(issue => ({
    text: issue,
    severity: classifySeverity(issue),
  }));
}

// ── Main entry: enrich audit with interpretation ─────────────────────────────

function enrichAudit(audit) {
  if (audit.error) return audit;

  return {
    scoreInterpretations: {
      overall: interpretScore('overall', audit.scores.overall),
      seo: interpretScore('seo', audit.scores.seo),
      performance: interpretScore('performance', audit.scores.performance),
      accessibility: interpretScore('accessibility', audit.scores.accessibility),
    },
    metricInterpretations: interpretMetrics(audit),
    topFixes: buildTopFixes(audit, 5),
    seoIssuesClassified: classifyAllIssues(audit.seo.issues),
    perfIssuesClassified: classifyAllIssues(audit.performance.issues),
    a11yIssuesClassified: classifyAllIssues(audit.accessibility.issues),
  };
}

module.exports = {
  enrichAudit,
  interpretScore,
  interpretMetrics,
  buildTopFixes,
  classifySeverity,
  classifyAllIssues,
  SEVERITY,
  BENCHMARKS,
};
