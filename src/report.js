'use strict';

const { enrichAudit } = require('./interpret');

/**
 * Generates a self-contained HTML report from an audit result object.
 * @param {object} audit - The single-page audit result
 * @param {object} [extras] - Optional extras: { crawl, competitor }
 */
function generateHtml(audit, extras) {
  if (audit.error) {
    return errorPage(audit);
  }

  extras = extras || {};
  const { scores, seo, performance: perf, accessibility: a11y } = audit;
  const insights = enrichAudit(audit, extras);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OrbioLabs Audit Report — ${escHtml(audit.url)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f4f6f9; color: #1a1a2e; }
    header { background: #1a1a2e; color: #fff; padding: 24px 32px; display: flex; align-items: center; gap: 16px; }
    header h1 { font-size: 1.4rem; font-weight: 700; }
    header .url { font-size: 0.85rem; color: #a0aec0; word-break: break-all; }
    .container { max-width: 960px; margin: 32px auto; padding: 0 16px; }
    .scores { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .score-card { background: #fff; border-radius: 12px; padding: 24px; text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    .score-card h3 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 1px; color: #718096; margin-bottom: 12px; }
    .score-ring { font-size: 2.8rem; font-weight: 800; }
    .ring-good { color: #38a169; }
    .ring-warn { color: #d69e2e; }
    .ring-bad  { color: #e53e3e; }
    .badge { display: inline-block; font-size: 0.7rem; font-weight: 600; padding: 2px 8px; border-radius: 99px; margin-top: 6px; }
    .badge-good { background: #c6f6d5; color: #276749; }
    .badge-warn { background: #fefcbf; color: #744210; }
    .badge-bad  { background: #fed7d7; color: #742a2a; }
    .score-interpretation { font-size: 0.82rem; color: #4a5568; margin-top: 10px; line-height: 1.45; text-align: left; }
    section { background: #fff; border-radius: 12px; padding: 24px; margin-bottom: 24px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    section h2 { font-size: 1rem; font-weight: 700; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
    .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 24px; font-size: 0.85rem; margin-bottom: 16px; }
    .meta-grid dt { color: #718096; font-weight: 600; }
    .meta-grid dd { color: #2d3748; word-break: break-all; }
    ul.checklist { list-style: none; }
    ul.checklist li { padding: 6px 0; font-size: 0.88rem; border-bottom: 1px solid #f0f0f0; display: flex; gap: 8px; align-items: flex-start; }
    ul.checklist li:last-child { border: none; }
    .pass::before { content: "✓"; color: #38a169; font-weight: 700; flex-shrink: 0; }
    .fail::before { content: "✗"; color: #e53e3e; font-weight: 700; flex-shrink: 0; }
    .severity-tag { display: inline-block; font-size: 0.65rem; font-weight: 700; padding: 1px 6px; border-radius: 4px; margin-right: 6px; text-transform: uppercase; vertical-align: middle; }
    .severity-critical { background: #e53e3e; color: #fff; }
    .severity-high { background: #ed8936; color: #fff; }
    .severity-medium { background: #d69e2e; color: #fff; }
    .severity-low { background: #a0aec0; color: #fff; }
    .top-fixes { background: linear-gradient(135deg, #1a1a2e 0%, #2d3748 100%); border-radius: 12px; padding: 24px; margin-bottom: 24px; color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
    .top-fixes h2 { color: #fff; font-size: 1.1rem; margin-bottom: 16px; }
    .fix-item { background: rgba(255,255,255,0.08); border-radius: 8px; padding: 16px; margin-bottom: 12px; border-left: 4px solid; }
    .fix-item:last-child { margin-bottom: 0; }
    .fix-critical { border-left-color: #e53e3e; }
    .fix-high { border-left-color: #ed8936; }
    .fix-medium { border-left-color: #d69e2e; }
    .fix-low { border-left-color: #a0aec0; }
    .fix-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; flex-wrap: wrap; gap: 6px; }
    .fix-title { font-weight: 700; font-size: 0.95rem; }
    .fix-meta { display: flex; gap: 8px; font-size: 0.72rem; }
    .fix-meta span { padding: 2px 8px; border-radius: 4px; font-weight: 600; }
    .impact-tag { background: rgba(255,255,255,0.15); }
    .effort-tag { background: rgba(255,255,255,0.1); }
    .fix-why { font-size: 0.82rem; color: #cbd5e0; line-height: 1.4; }
    .fix-category { font-size: 0.7rem; color: #a0aec0; margin-top: 4px; }
    .fix-howto { margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.1); }
    .fix-howto-title { font-size: 0.78rem; font-weight: 700; color: #e2e8f0; margin-bottom: 6px; }
    .fix-howto ol { margin: 0 0 0 18px; padding: 0; }
    .fix-howto ol li { font-size: 0.78rem; color: #cbd5e0; line-height: 1.5; margin-bottom: 3px; }
    .fix-impact { font-size: 0.78rem; color: #68d391; margin-top: 6px; font-style: italic; }
    .fix-platform-tip { margin-top: 8px; background: rgba(99,179,237,0.12); border-radius: 6px; padding: 8px 12px; }
    .fix-platform-label { font-size: 0.68rem; font-weight: 700; text-transform: uppercase; color: #63b3ed; letter-spacing: 0.5px; }
    .fix-platform-text { font-size: 0.78rem; color: #bee3f8; margin-top: 3px; line-height: 1.45; }
    .platform-badge { display: inline-block; font-size: 0.7rem; font-weight: 600; padding: 3px 10px; border-radius: 99px; background: rgba(99,179,237,0.2); color: #63b3ed; margin-left: 8px; }
    .interpretation-box { background: #edf2f7; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; font-size: 0.85rem; color: #2d3748; line-height: 1.5; }
    .interpretation-box strong { color: #1a1a2e; }
    footer { text-align: center; font-size: 0.75rem; color: #a0aec0; padding: 32px 0; }
    .crawl-section { background: linear-gradient(135deg, #1e3a5f 0%, #2d3748 100%); border-radius: 12px; padding: 24px; margin-bottom: 24px; color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
    .crawl-section h2 { color: #fff; font-size: 1.1rem; margin-bottom: 16px; }
    .crawl-stat { display: inline-block; background: rgba(255,255,255,0.1); border-radius: 8px; padding: 12px 20px; margin: 0 8px 8px 0; text-align: center; }
    .crawl-stat-value { font-size: 1.8rem; font-weight: 800; color: #63b3ed; }
    .crawl-stat-label { font-size: 0.72rem; color: #a0aec0; text-transform: uppercase; letter-spacing: 0.5px; }
    .crawl-issue { background: rgba(255,255,255,0.08); border-radius: 8px; padding: 14px; margin-bottom: 10px; border-left: 4px solid; }
    .crawl-issue-critical { border-left-color: #e53e3e; }
    .crawl-issue-high { border-left-color: #ed8936; }
    .crawl-issue-medium { border-left-color: #d69e2e; }
    .crawl-issue h4 { font-size: 0.9rem; font-weight: 700; margin-bottom: 4px; }
    .crawl-issue p { font-size: 0.8rem; color: #cbd5e0; line-height: 1.4; }
    .crawl-issue .page-list { font-size: 0.75rem; color: #a0aec0; margin-top: 6px; }
    .competitor-section { background: linear-gradient(135deg, #2d1b4e 0%, #1a1a2e 100%); border-radius: 12px; padding: 24px; margin-bottom: 24px; color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
    .competitor-section h2 { color: #fff; font-size: 1.1rem; margin-bottom: 16px; }
    .comp-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; margin-bottom: 16px; }
    .comp-table th { text-align: left; padding: 8px 12px; border-bottom: 2px solid rgba(255,255,255,0.2); color: #a0aec0; font-weight: 600; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.5px; }
    .comp-table td { padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); }
    .comp-table tr.target-row { background: rgba(99,179,237,0.12); }
    .comp-insight { background: rgba(255,255,255,0.06); border-radius: 8px; padding: 12px 16px; margin-bottom: 8px; font-size: 0.82rem; line-height: 1.45; }
    .comp-strength { border-left: 3px solid #38a169; }
    .comp-weakness { border-left: 3px solid #e53e3e; }
    .comp-opportunity { border-left: 3px solid #d69e2e; }
    .traffic-bar { display: inline-block; height: 6px; border-radius: 3px; background: #63b3ed; margin-right: 6px; vertical-align: middle; }
    .keyword-section { background: linear-gradient(135deg, #1a3a2e 0%, #1a1a2e 100%); border-radius: 12px; padding: 24px; margin-bottom: 24px; color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
    .keyword-section h2 { color: #fff; font-size: 1.1rem; margin-bottom: 16px; }
    .kw-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; margin-bottom: 16px; }
    .kw-table th { text-align: left; padding: 8px 12px; border-bottom: 2px solid rgba(255,255,255,0.2); color: #a0aec0; font-weight: 600; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.5px; }
    .kw-table td { padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); }
    .kw-quickwin { background: rgba(56,161,105,0.15); }
    .gap-section { background: linear-gradient(135deg, #3a1a2e 0%, #1a1a2e 100%); border-radius: 12px; padding: 24px; margin-bottom: 24px; color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
    .gap-section h2 { color: #fff; font-size: 1.1rem; margin-bottom: 16px; }
    .roi-section { background: linear-gradient(135deg, #0d4f3c 0%, #1a3a2e 100%); border-radius: 12px; padding: 24px; margin-bottom: 24px; color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
    .roi-section h2 { color: #fff; font-size: 1.1rem; margin-bottom: 16px; }
    .roi-summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 20px; }
    .roi-stat { background: rgba(255,255,255,0.1); border-radius: 8px; padding: 16px; text-align: center; }
    .roi-stat-value { font-size: 2rem; font-weight: 800; color: #68d391; }
    .roi-stat-label { font-size: 0.72rem; color: #a0aec0; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }
    .roi-rec { background: rgba(255,255,255,0.06); border-radius: 8px; padding: 14px; margin-bottom: 10px; border-left: 4px solid #68d391; }
    .roi-rec h4 { font-size: 0.88rem; font-weight: 700; margin-bottom: 4px; }
    .roi-rec p { font-size: 0.8rem; color: #cbd5e0; line-height: 1.4; }
    .roi-rec .roi-value { font-weight: 700; color: #68d391; }
    .difficulty-easy { color: #68d391; } .difficulty-moderate { color: #ecc94b; } .difficulty-challenging { color: #ed8936; } .difficulty-hard { color: #fc8181; }
    @media (max-width: 600px) { .meta-grid { grid-template-columns: 1fr; } .comp-table { font-size: 0.72rem; } .comp-table th, .comp-table td { padding: 6px 8px; } .kw-table { font-size: 0.72rem; } .roi-summary-grid { grid-template-columns: 1fr 1fr; } }
  </style>
</head>
<body>
<header>
  <div>
    <h1>OrbioLabs Audit Report</h1>
    <div class="url">${escHtml(audit.url)}</div>
    <div class="url" style="font-size:0.75rem;margin-top:4px">Audited: ${audit.auditedAt}</div>
  </div>
</header>

<div class="container">
  <!-- Score cards with interpretations -->
  <div class="scores">
    ${scoreCard('Overall', scores.overall, insights.scoreInterpretations.overall)}
    ${scoreCard('SEO', scores.seo, insights.scoreInterpretations.seo)}
    ${scoreCard('Performance', scores.performance, insights.scoreInterpretations.performance)}
    ${scoreCard('Accessibility', scores.accessibility, insights.scoreInterpretations.accessibility)}
  </div>

  <!-- Top Fixes with How-to-Fix Guidance -->
  ${topFixesSection(insights.topFixes, insights.detectedPlatform)}

  <!-- Page metadata with interpretations -->
  <section>
    <h2>📄 Page Info</h2>
    <dl class="meta-grid">
      <dt>HTTP Status</dt><dd>${audit.statusCode}</dd>
      <dt>TTFB</dt><dd>${audit.ttfbMs} ms</dd>
      <dt>HTML Size</dt><dd>${audit.pageSizeKb} KB</dd>
      <dt>Encoding</dt><dd>${escHtml(perf.contentEncoding || 'none')}</dd>
    </dl>
    ${metricInterpretationBox(insights.metricInterpretations.ttfb)}
    ${metricInterpretationBox(insights.metricInterpretations.pageSize)}
  </section>

  <!-- SEO -->
  <section>
    <h2>🔍 SEO <span style="font-weight:400;font-size:.85rem;color:#718096">(${scores.seo}/100)</span></h2>
    ${interpretationBox(insights.scoreInterpretations.seo)}
    <dl class="meta-grid">
      <dt>Title</dt><dd>${escHtml(seo.title || '(none)')}</dd>
      <dt>Meta Description</dt><dd>${escHtml(seo.metaDescription || '(none)')}</dd>
      <dt>Canonical</dt><dd>${escHtml(seo.canonical || '(none)')}</dd>
      <dt>H1</dt><dd>${seo.h1s.map(escHtml).join(', ') || '(none)'}</dd>
      <dt>Lang</dt><dd>${escHtml(seo.lang || '(none)')}</dd>
      <dt>Structured Data</dt><dd>${seo.structuredDataTypes.join(', ') || 'none'}</dd>
      <dt>Internal Links</dt><dd>${seo.internalLinks}</dd>
      <dt>External Links</dt><dd>${seo.externalLinks}</dd>
    </dl>
    ${checkListWithSeverity(seo.passes, insights.seoIssuesClassified)}
  </section>

  <!-- Performance -->
  <section>
    <h2>⚡ Performance <span style="font-weight:400;font-size:.85rem;color:#718096">(${scores.performance}/100)</span></h2>
    ${interpretationBox(insights.scoreInterpretations.performance)}
    <dl class="meta-grid">
      <dt>TTFB</dt><dd>${perf.ttfbMs} ms</dd>
      <dt>HTML Size</dt><dd>${perf.pageSizeKb} KB</dd>
      <dt>Render-blocking JS</dt><dd>${perf.renderBlockingJs}</dd>
      <dt>Render-blocking CSS</dt><dd>${perf.renderBlockingCss}</dd>
      <dt>Images</dt><dd>${perf.imagesTotal} total, ${perf.imagesWithoutSrcset} without srcset/lazy</dd>
    </dl>
    ${metricInterpretationBox(insights.metricInterpretations.renderBlockingJs)}
    ${metricInterpretationBox(insights.metricInterpretations.renderBlockingCss)}
    ${metricInterpretationBox(insights.metricInterpretations.images)}
    ${metricInterpretationBox(insights.metricInterpretations.compression)}
    ${checkListWithSeverity(perf.passes, insights.perfIssuesClassified)}
  </section>

  <!-- Accessibility -->
  <section>
    <h2>♿ Accessibility <span style="font-weight:400;font-size:.85rem;color:#718096">(${scores.accessibility}/100)</span></h2>
    ${interpretationBox(insights.scoreInterpretations.accessibility)}
    <dl class="meta-grid">
      <dt>Images without alt</dt><dd>${a11y.imgsNoAlt}</dd>
      <dt>Unlabelled inputs</dt><dd>${a11y.unlabelledInputs}</dd>
      <dt>Heading order</dt><dd>${a11y.headingOrderOk ? 'Correct' : 'Skipped levels'}</dd>
      <dt>Main landmark</dt><dd>${a11y.hasMain ? 'Present' : 'Missing'}</dd>
      <dt>Skip link</dt><dd>${a11y.skipLink ? 'Present' : 'Missing'}</dd>
      <dt>Unlabelled buttons</dt><dd>${a11y.btnsNoName}</dd>
    </dl>
    ${checkListWithSeverity(a11y.passes, insights.a11yIssuesClassified)}
  </section>

  ${crawlSection(extras.crawl, insights.crawlSummary)}
  ${competitorSection(extras.competitor)}
  ${keywordSection(extras.keywords, insights.keywordSummary)}
  ${contentGapSection(extras.contentGaps, insights.contentGapSummary)}
  ${roiSection(extras.roi, insights.roiSummary, insights.roiRecommendations)}
</div>

<footer>Generated by <strong>OrbioLabs</strong> · ${audit.auditedAt}</footer>
</body>
</html>`;
}

function scoreCard(label, score, interpretation) {
  const cls = score >= 80 ? 'ring-good' : score >= 50 ? 'ring-warn' : 'ring-bad';
  const badge = score >= 80
    ? `<span class="badge badge-good">Good</span>`
    : score >= 50
    ? `<span class="badge badge-warn">Needs Work</span>`
    : `<span class="badge badge-bad">Poor</span>`;
  const interp = interpretation
    ? `<div class="score-interpretation">${escHtml(interpretation.comparison)}</div>`
    : '';
  return `<div class="score-card"><h3>${label}</h3><div class="score-ring ${cls}">${score}</div>${badge}${interp}</div>`;
}

function interpretationBox(interp) {
  if (!interp) return '';
  return `<div class="interpretation-box"><strong>${escHtml(interp.comparison)}</strong> ${escHtml(interp.advice)}</div>`;
}

function metricInterpretationBox(text) {
  if (!text) return '';
  return `<div class="interpretation-box">${escHtml(text)}</div>`;
}

function topFixesSection(fixes, platform) {
  if (!fixes || fixes.length === 0) return '';

  const platformLabel = {
    wordpress: 'WordPress', shopify: 'Shopify', squarespace: 'Squarespace',
    wix: 'Wix', nextjs: 'Next.js', custom: 'Custom', html: 'HTML',
  };
  const platformName = platformLabel[platform] || '';
  const platformBadge = platform && platform !== 'html'
    ? `<span class="platform-badge">Detected: ${escHtml(platformName)}</span>`
    : '';

  const items = fixes.map((fix, i) => {
    const borderClass = `fix-${fix.severity}`;
    const htf = fix.howToFix;

    let howToFixHtml = '';
    if (htf) {
      const stepsHtml = htf.steps
        ? `<ol>${htf.steps.map(s => `<li>${escHtml(s)}</li>`).join('')}</ol>`
        : '';
      const impactHtml = htf.estimatedImpact
        ? `<div class="fix-impact">${escHtml(htf.estimatedImpact)}</div>`
        : '';
      const platformTipHtml = htf.platformTip
        ? `<div class="fix-platform-tip"><div class="fix-platform-label">${escHtml(platformName)} tip</div><div class="fix-platform-text">${escHtml(htf.platformTip)}</div></div>`
        : '';

      howToFixHtml = `<div class="fix-howto">
        <div class="fix-howto-title">How to Fix</div>
        ${stepsHtml}
        ${impactHtml}
        ${platformTipHtml}
      </div>`;
    }

    return `<div class="fix-item ${borderClass}">
      <div class="fix-header">
        <span class="fix-title">#${i + 1} ${escHtml(fix.title)}</span>
        <div class="fix-meta">
          <span class="severity-tag severity-${fix.severity}">${fix.impact}</span>
          <span class="effort-tag">${escHtml(fix.effort)}</span>
        </div>
      </div>
      <div class="fix-why">${escHtml(fix.why)}</div>
      <div class="fix-category">${escHtml(fix.category)}</div>
      ${howToFixHtml}
    </div>`;
  }).join('');

  return `<div class="top-fixes">
    <h2>🎯 Top ${fixes.length} Fixes — What to Do First ${platformBadge}</h2>
    ${items}
  </div>`;
}

function checkListWithSeverity(passes, classifiedIssues) {
  const items = [
    ...classifiedIssues.map(i =>
      `<li class="fail"><span class="severity-tag severity-${i.severity}">${i.severity}</span>${escHtml(i.text)}</li>`
    ),
    ...passes.map(p => `<li class="pass">${escHtml(p)}</li>`),
  ];
  return `<ul class="checklist">${items.join('')}</ul>`;
}

function errorPage(audit) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>OrbioLabs — Audit Error</title></head>
<body style="font-family:sans-serif;padding:32px">
<h1>Audit Failed</h1><p>URL: ${escHtml(audit.url)}</p><p>Error: ${escHtml(audit.error)}</p>
</body></html>`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function crawlSection(crawl, crawlSummary) {
  if (!crawl) return '';

  const statsHtml = `
    <div style="margin-bottom:16px">
      <div class="crawl-stat"><div class="crawl-stat-value">${crawl.pagesCrawled}</div><div class="crawl-stat-label">Pages Crawled</div></div>
      <div class="crawl-stat"><div class="crawl-stat-value">${(crawl.orphanPages || []).length}</div><div class="crawl-stat-label">Orphan Pages</div></div>
      <div class="crawl-stat"><div class="crawl-stat-value">${(crawl.duplicateTitles || []).length}</div><div class="crawl-stat-label">Duplicate Titles</div></div>
      <div class="crawl-stat"><div class="crawl-stat-value">${(crawl.indexationIssues || []).length}</div><div class="crawl-stat-label">Indexation Issues</div></div>
      <div class="crawl-stat"><div class="crawl-stat-value">${(crawl.thinContentPages || []).length}</div><div class="crawl-stat-label">Thin Content</div></div>
    </div>`;

  let issuesHtml = '';
  if (crawlSummary && crawlSummary.issues && crawlSummary.issues.length > 0) {
    issuesHtml = crawlSummary.issues.map(issue => {
      const severityClass = `crawl-issue-${issue.severity}`;
      const trafficBar = `<span class="traffic-bar" style="width:${issue.trafficImpact}px"></span> ${issue.trafficImpact}/100 traffic impact`;
      const pageList = issue.pages
        ? `<div class="page-list">${issue.pages.slice(0, 5).map(p => escHtml(p)).join('<br>')}</div>`
        : issue.items
        ? `<div class="page-list">${issue.items.slice(0, 3).map(item => escHtml(typeof item === 'string' ? item : JSON.stringify(item))).join('<br>')}</div>`
        : '';
      return `<div class="crawl-issue ${severityClass}">
        <h4>${escHtml(issue.title)}</h4>
        <p>${escHtml(issue.description)}</p>
        <p style="margin-top:4px;font-size:0.75rem">${trafficBar}</p>
        ${pageList}
      </div>`;
    }).join('');
  }

  return `<div class="crawl-section">
    <h2>🕷️ Site Crawl Analysis (${crawl.pagesCrawled} pages)</h2>
    ${statsHtml}
    ${issuesHtml || '<p style="color:#a0aec0">No site-wide issues detected across crawled pages.</p>'}
  </div>`;
}

function competitorSection(competitor) {
  if (!competitor) return '';

  const target = competitor.target;
  const competitors = competitor.competitors || [];
  const comparison = competitor.comparison || {};

  if (!target || target.error) return '';

  // Build comparison table
  const allDomains = [target, ...competitors.filter(c => !c.error)];
  const tableRows = allDomains.map(d => {
    const isTarget = d.isTarget;
    const rowClass = isTarget ? 'target-row' : '';
    const authScore = d.authorityProxy?.score || 0;
    return `<tr class="${rowClass}">
      <td>${escHtml(d.domain)}${isTarget ? ' <strong>(you)</strong>' : ''}</td>
      <td>${authScore}/100</td>
      <td>${d.ttfbMs || '-'}ms</td>
      <td>${d.wordCount || 0}</td>
      <td>${d.internalLinks || 0}</td>
      <td>${d.hasStructuredData ? 'Yes' : 'No'}</td>
      <td>${d.isHttps ? 'Yes' : 'No'}</td>
    </tr>`;
  }).join('');

  const tableHtml = `<table class="comp-table">
    <thead><tr><th>Domain</th><th>SEO Score</th><th>TTFB</th><th>Words</th><th>Internal Links</th><th>Structured Data</th><th>HTTPS</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>`;

  // Insights
  let insightsHtml = '';
  if (comparison.strengths && comparison.strengths.length > 0) {
    insightsHtml += comparison.strengths.map(s =>
      `<div class="comp-insight comp-strength">${escHtml(s)}</div>`
    ).join('');
  }
  if (comparison.weaknesses && comparison.weaknesses.length > 0) {
    insightsHtml += comparison.weaknesses.map(w =>
      `<div class="comp-insight comp-weakness">${escHtml(w)}</div>`
    ).join('');
  }
  if (comparison.opportunities && comparison.opportunities.length > 0) {
    insightsHtml += comparison.opportunities.map(o =>
      `<div class="comp-insight comp-opportunity">${escHtml(o)}</div>`
    ).join('');
  }

  return `<div class="competitor-section">
    <h2>🏆 Competitor Benchmarking</h2>
    <p style="font-size:0.85rem;color:#cbd5e0;margin-bottom:16px">${escHtml(comparison.summary || '')}</p>
    ${tableHtml}
    ${insightsHtml}
  </div>`;
}

function keywordSection(keywords, summary) {
  if (!keywords || !summary || summary.totalOpportunities === 0) return '';

  const opps = summary.topOpportunities || [];
  const rowsHtml = opps.map(o => {
    const diffClass = `difficulty-${o.difficulty || 'moderate'}`;
    const isQuickWin = o.currentPosition >= 8 && o.currentPosition <= 12;
    return `<tr class="${isQuickWin ? 'kw-quickwin' : ''}">
      <td>${escHtml(o.keyword)}</td>
      <td>${o.searchVolume ? o.searchVolume.toLocaleString() : '—'}</td>
      <td>#${o.currentPosition}</td>
      <td>#${o.targetPosition}</td>
      <td>+${o.estimatedMonthlyTrafficGain}</td>
      <td class="${diffClass}">${o.difficulty || '—'}</td>
    </tr>`;
  }).join('');

  return `<div class="keyword-section">
    <h2>🎯 Keyword Opportunities</h2>
    <div style="display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap">
      <div class="crawl-stat"><div class="crawl-stat-value">${summary.totalOpportunities}</div><div class="crawl-stat-label">Total Keywords</div></div>
      <div class="crawl-stat"><div class="crawl-stat-value">${summary.strikingDistanceCount}</div><div class="crawl-stat-label">Striking Distance</div></div>
      <div class="crawl-stat"><div class="crawl-stat-value">${summary.quickWinCount}</div><div class="crawl-stat-label">Quick Wins</div></div>
      <div class="crawl-stat"><div class="crawl-stat-value">+${summary.totalEstimatedMonthlyTrafficGain}</div><div class="crawl-stat-label">Est. Monthly Traffic Gain</div></div>
    </div>
    ${opps.length > 0 ? `
    <table class="kw-table">
      <thead><tr><th>Keyword</th><th>Volume</th><th>Current</th><th>Target</th><th>Traffic Gain</th><th>Difficulty</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>` : ''}
    <p style="font-size:0.75rem;color:#a0aec0;margin-top:8px">Data source: ${summary.dataSource === 'dataforseo' ? 'DataForSEO API' : 'Heuristic estimates — connect DataForSEO API for precise data'}</p>
  </div>`;
}

function contentGapSection(contentGaps, summary) {
  if (!contentGaps || !summary || summary.totalGapsFound === 0) return '';

  const gaps = summary.topGaps || [];
  const rowsHtml = gaps.map(g => {
    const diffClass = `difficulty-${g.difficulty || 'moderate'}`;
    return `<tr>
      <td>${escHtml(g.keyword)}</td>
      <td>${g.searchVolume ? g.searchVolume.toLocaleString() : '—'}</td>
      <td>${escHtml(g.competitorDomain || '—')}</td>
      <td>#${g.competitorPosition || '—'}</td>
      <td class="${diffClass}">${g.difficulty || '—'}</td>
    </tr>`;
  }).join('');

  const categoriesHtml = Object.entries(summary.categories || {}).map(([cat, data]) =>
    `<span style="display:inline-block;background:rgba(255,255,255,0.1);border-radius:6px;padding:4px 10px;margin:4px;font-size:0.78rem">${escHtml(cat)}: ${data.count} keyword(s)</span>`
  ).join('');

  return `<div class="gap-section">
    <h2>🔍 Content Gap Analysis</h2>
    <div style="display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap">
      <div class="crawl-stat"><div class="crawl-stat-value">${summary.totalGapsFound}</div><div class="crawl-stat-label">Gaps Found</div></div>
      <div class="crawl-stat"><div class="crawl-stat-value">${summary.easyWins}</div><div class="crawl-stat-label">Easy Wins</div></div>
      <div class="crawl-stat"><div class="crawl-stat-value">+${summary.totalEstimatedMonthlyTraffic}</div><div class="crawl-stat-label">Est. Monthly Traffic</div></div>
    </div>
    <div style="margin-bottom:16px">${categoriesHtml}</div>
    ${gaps.length > 0 ? `
    <table class="kw-table">
      <thead><tr><th>Topic</th><th>Volume</th><th>Competitor</th><th>Their Position</th><th>Difficulty</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>` : ''}
    <p style="font-size:0.75rem;color:#a0aec0;margin-top:8px">Data source: ${summary.dataSource === 'dataforseo' ? 'DataForSEO API' : 'Heuristic estimates — connect DataForSEO API for precise data'}</p>
  </div>`;
}

function roiSection(roi, roiSummary, roiRecommendations) {
  if (!roi || !roiSummary) return '';

  const recs = roiRecommendations || [];

  const recsHtml = recs.map(r => {
    const effortBadge = r.effort === 'low' ? '🟢 Quick' : r.effort === 'medium' ? '🟡 Medium' : '🔴 Significant';
    return `<div class="roi-rec">
      <h4>${escHtml(r.issue)}</h4>
      <p>${escHtml(r.roiFrame || '')}</p>
      <p style="margin-top:6px;font-size:0.75rem;color:#a0aec0">
        ${effortBadge} effort · Category: ${escHtml(r.category)} ·
        <span class="roi-value">+${r.estimatedMonthlyTraffic} visits/mo</span> ·
        <span class="roi-value">~$${r.estimatedMonthlyValue}/mo</span>
      </p>
    </div>`;
  }).join('');

  return `<div class="roi-section">
    <h2>💰 ROI Impact Analysis</h2>
    <p style="font-size:0.85rem;color:#cbd5e0;margin-bottom:16px">${escHtml(roiSummary.executiveSummary || '')}</p>
    <div class="roi-summary-grid">
      <div class="roi-stat"><div class="roi-stat-value">${roiSummary.totalRecommendations}</div><div class="roi-stat-label">Recommendations</div></div>
      <div class="roi-stat"><div class="roi-stat-value">+${(roiSummary.totalEstimatedMonthlyTrafficGain || 0).toLocaleString()}</div><div class="roi-stat-label">Monthly Traffic Gain</div></div>
      <div class="roi-stat"><div class="roi-stat-value">$${(roiSummary.totalEstimatedMonthlyValue || 0).toLocaleString()}/mo</div><div class="roi-stat-label">Monthly Value</div></div>
      <div class="roi-stat"><div class="roi-stat-value">$${(roiSummary.totalEstimatedAnnualValue || 0).toLocaleString()}/yr</div><div class="roi-stat-label">Annual Value</div></div>
    </div>
    ${roiSummary.quickWins > 0 ? `<p style="font-size:0.85rem;color:#68d391;margin-bottom:16px">✨ ${roiSummary.quickWins} quick win(s) available — low effort, immediate impact</p>` : ''}
    ${recsHtml}
  </div>`;
}

module.exports = { generateHtml };
