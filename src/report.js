'use strict';

const { enrichAudit } = require('./interpret');

/**
 * Generates a self-contained HTML report from an audit result object.
 */
function generateHtml(audit) {
  if (audit.error) {
    return errorPage(audit);
  }

  const { scores, seo, performance: perf, accessibility: a11y } = audit;
  const insights = enrichAudit(audit);

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
    @media (max-width: 600px) { .meta-grid { grid-template-columns: 1fr; } }
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

module.exports = { generateHtml };
