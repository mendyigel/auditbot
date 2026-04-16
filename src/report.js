'use strict';

/**
 * Generates a self-contained HTML report from an audit result object.
 */
function generateHtml(audit) {
  if (audit.error) {
    return errorPage(audit);
  }

  const { scores, seo, performance: perf, accessibility: a11y } = audit;

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
  <!-- Score cards -->
  <div class="scores">
    ${scoreCard('Overall', scores.overall)}
    ${scoreCard('SEO', scores.seo)}
    ${scoreCard('Performance', scores.performance)}
    ${scoreCard('Accessibility', scores.accessibility)}
  </div>

  <!-- Page metadata -->
  <section>
    <h2>📄 Page Info</h2>
    <dl class="meta-grid">
      <dt>HTTP Status</dt><dd>${audit.statusCode}</dd>
      <dt>TTFB</dt><dd>${audit.ttfbMs} ms</dd>
      <dt>HTML Size</dt><dd>${audit.pageSizeKb} KB</dd>
      <dt>Encoding</dt><dd>${escHtml(perf.contentEncoding || 'none')}</dd>
    </dl>
  </section>

  <!-- SEO -->
  <section>
    <h2>🔍 SEO <span style="font-weight:400;font-size:.85rem;color:#718096">(${scores.seo}/100)</span></h2>
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
    ${checkList(seo.passes, seo.issues)}
  </section>

  <!-- Performance -->
  <section>
    <h2>⚡ Performance <span style="font-weight:400;font-size:.85rem;color:#718096">(${scores.performance}/100)</span></h2>
    <dl class="meta-grid">
      <dt>TTFB</dt><dd>${perf.ttfbMs} ms</dd>
      <dt>HTML Size</dt><dd>${perf.pageSizeKb} KB</dd>
      <dt>Render-blocking JS</dt><dd>${perf.renderBlockingJs}</dd>
      <dt>Render-blocking CSS</dt><dd>${perf.renderBlockingCss}</dd>
      <dt>Images</dt><dd>${perf.imagesTotal} total, ${perf.imagesWithoutSrcset} without srcset/lazy</dd>
    </dl>
    ${checkList(perf.passes, perf.issues)}
  </section>

  <!-- Accessibility -->
  <section>
    <h2>♿ Accessibility <span style="font-weight:400;font-size:.85rem;color:#718096">(${scores.accessibility}/100)</span></h2>
    <dl class="meta-grid">
      <dt>Images without alt</dt><dd>${a11y.imgsNoAlt}</dd>
      <dt>Unlabelled inputs</dt><dd>${a11y.unlabelledInputs}</dd>
      <dt>Heading order</dt><dd>${a11y.headingOrderOk ? 'Correct' : 'Skipped levels'}</dd>
      <dt>Main landmark</dt><dd>${a11y.hasMain ? 'Present' : 'Missing'}</dd>
      <dt>Skip link</dt><dd>${a11y.skipLink ? 'Present' : 'Missing'}</dd>
      <dt>Unlabelled buttons</dt><dd>${a11y.btnsNoName}</dd>
    </dl>
    ${checkList(a11y.passes, a11y.issues)}
  </section>
</div>

<footer>Generated by <strong>OrbioLabs</strong> · ${audit.auditedAt}</footer>
</body>
</html>`;
}

function scoreCard(label, score) {
  const cls = score >= 80 ? 'ring-good' : score >= 50 ? 'ring-warn' : 'ring-bad';
  const badge = score >= 80
    ? `<span class="badge badge-good">Good</span>`
    : score >= 50
    ? `<span class="badge badge-warn">Needs Work</span>`
    : `<span class="badge badge-bad">Poor</span>`;
  return `<div class="score-card"><h3>${label}</h3><div class="score-ring ${cls}">${score}</div>${badge}</div>`;
}

function checkList(passes, issues) {
  const items = [
    ...issues.map(i => `<li class="fail">${escHtml(i)}</li>`),
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
