'use strict';

const { enrichAudit } = require('./interpret');

let _fontsLoaded = false;

function loadFonts() {
  if (_fontsLoaded) return;
  const pdfmake = require('pdfmake');
  const vfs = require('pdfmake/build/vfs_fonts');

  // Load fonts into pdfmake's virtual file system
  for (const [filename, content] of Object.entries(vfs)) {
    pdfmake.virtualfs.writeFileSync(filename, Buffer.from(content, 'base64'));
  }

  pdfmake.addFonts({
    Roboto: {
      normal: 'Roboto-Regular.ttf',
      bold: 'Roboto-Medium.ttf',
      italics: 'Roboto-Italic.ttf',
      bolditalics: 'Roboto-MediumItalic.ttf',
    },
  });

  // Allow no external URLs (white-label, self-contained)
  pdfmake.setUrlAccessPolicy(() => false);

  _fontsLoaded = true;
}

/**
 * Generates a white-label PDF audit report using pdfmake.
 * No AuditBot branding — agencies can present this as their own.
 *
 * @param {object} audit  - audit result from auditor.js
 * @param {object} [opts]
 * @param {string} [opts.agencyName]  - shown in the header
 * @param {string} [opts.agencyUrl]   - shown in the footer
 * @returns {Promise<Buffer>}
 */
function generatePdf(audit, opts = {}) {
  loadFonts();

  const pdfmake = require('pdfmake');
  const docDefinition = buildDocDefinition(audit, opts);

  const pdfDoc = pdfmake.createPdf(docDefinition);
  return pdfDoc.getBuffer();
}

// ── Colours ───────────────────────────────────────────────────────────────────

const NAVY = '#1a1a2e';
const GREEN = '#38a169';
const YELLOW = '#d69e2e';
const RED = '#e53e3e';
const ORANGE = '#ed8936';
const GREY = '#718096';
const LIGHT_GREY = '#f4f6f9';
const WHITE = '#ffffff';
const BLUE = '#3182ce';
const PURPLE = '#9f7aea';

function priorityActionColour(action) {
  switch (action) {
    case 'DO FIRST': return GREEN;
    case 'PLAN': return BLUE;
    case 'NICE TO HAVE': return YELLOW;
    default: return GREY;
  }
}

function scoreColour(s) { return s >= 80 ? GREEN : s >= 50 ? YELLOW : RED; }
function scoreLabel(s) { return s >= 80 ? 'Good' : s >= 50 ? 'Needs Work' : 'Poor'; }

function severityColour(sev) {
  switch (sev) {
    case 'critical': return RED;
    case 'high': return ORANGE;
    case 'medium': return YELLOW;
    default: return GREY;
  }
}

// ── Document definition ───────────────────────────────────────────────────────

function buildDocDefinition(audit, opts) {
  const { agencyName = '', agencyUrl = '' } = opts;
  const { scores, seo, performance: perf, accessibility: a11y } = audit;
  const insights = enrichAudit(audit);

  const headerTitle = agencyName ? `${agencyName} — Website Audit Report` : 'Website Audit Report';
  const footerLine = agencyUrl || agencyName || 'Confidential';

  return {
    pageSize: 'A4',
    pageMargins: [40, 90, 40, 55],

    defaultStyle: { font: 'Roboto', fontSize: 9, color: NAVY, lineHeight: 1.4 },

    header: {
      margin: [40, 16, 40, 0],
      table: {
        widths: ['*'],
        body: [[{
          fillColor: NAVY,
          margin: [16, 14, 16, 14],
          stack: [
            { text: headerTitle, fontSize: 17, bold: true, color: WHITE },
            { text: audit.url, fontSize: 8, color: '#a0aec0', margin: [0, 4, 0, 0] },
            { text: `Audited: ${audit.auditedAt}`, fontSize: 7, color: '#718096', margin: [0, 2, 0, 0] },
          ],
        }]],
      },
      layout: 'noBorders',
    },

    footer: (page, pages) => ({
      margin: [40, 0, 40, 14],
      columns: [
        { text: footerLine, fontSize: 7, color: GREY },
        { text: `Page ${page} of ${pages}`, fontSize: 7, color: GREY, alignment: 'right' },
      ],
    }),

    content: [
      // Score overview with interpretations
      { text: 'Score Overview', fontSize: 13, bold: true, margin: [0, 8, 0, 8] },
      {
        columns: [
          scoreCard('Overall', scores.overall),
          scoreCard('SEO', scores.seo),
          scoreCard('Performance', scores.performance),
          scoreCard('Accessibility', scores.accessibility),
        ],
        columnGap: 8,
        margin: [0, 0, 0, 8],
      },

      // Score benchmark interpretations
      ...scoreInterpretationBlocks(insights.scoreInterpretations),

      // Revenue Opportunity Summary
      ...revenueOpportunitySummaryBlocks(insights.revenueOpportunitySummary),

      // Top Fixes section with how-to-fix guidance
      ...topFixesBlocks(insights.topFixes, insights.detectedPlatform),

      // Page info with metric interpretations
      sectionHeader('Page Info'),
      metaTable([
        ['HTTP Status', String(audit.statusCode)],
        ['Time to First Byte', `${audit.ttfbMs} ms`],
        ['HTML Size', `${audit.pageSizeKb} KB`],
        ['Encoding', perf.contentEncoding || 'none'],
      ]),
      ...metricInterpretationBlocks(insights.metricInterpretations, ['ttfb', 'pageSize']),

      // SEO
      sectionHeader(`SEO  —  ${scores.seo}/100`),
      ...categoryInterpretationBlock(insights.scoreInterpretations.seo),
      metaTable([
        ['Title', seo.title || '(none)'],
        ['Meta Description', seo.metaDescription || '(none)'],
        ['Canonical', seo.canonical || '(none)'],
        ['H1 Tags', seo.h1s.join(', ') || '(none)'],
        ['Lang Attribute', seo.lang || '(none)'],
        ['Structured Data', seo.structuredDataTypes.join(', ') || 'none'],
        ['Internal Links', String(seo.internalLinks)],
        ['External Links', String(seo.externalLinks)],
      ]),
      checklistTableWithSeverity(seo.passes, insights.seoIssuesClassified),

      // Performance
      sectionHeader(`Performance  —  ${scores.performance}/100`),
      ...categoryInterpretationBlock(insights.scoreInterpretations.performance),
      metaTable([
        ['TTFB', `${perf.ttfbMs} ms`],
        ['HTML Size', `${perf.pageSizeKb} KB`],
        ['Render-blocking JS', String(perf.renderBlockingJs)],
        ['Render-blocking CSS', String(perf.renderBlockingCss)],
        ['Images', `${perf.imagesTotal} total, ${perf.imagesWithoutSrcset} without srcset/lazy`],
      ]),
      ...metricInterpretationBlocks(insights.metricInterpretations, ['renderBlockingJs', 'renderBlockingCss', 'images', 'compression']),
      checklistTableWithSeverity(perf.passes, insights.perfIssuesClassified),

      // Accessibility
      sectionHeader(`Accessibility  —  ${scores.accessibility}/100`),
      ...categoryInterpretationBlock(insights.scoreInterpretations.accessibility),
      metaTable([
        ['Images without alt', String(a11y.imgsNoAlt)],
        ['Unlabelled inputs', String(a11y.unlabelledInputs)],
        ['Heading order', a11y.headingOrderOk ? 'Correct' : 'Skipped levels'],
        ['Main landmark', a11y.hasMain ? 'Present' : 'Missing'],
        ['Skip link', a11y.skipLink ? 'Present' : 'Missing'],
        ['Unlabelled buttons', String(a11y.btnsNoName)],
      ]),
      checklistTableWithSeverity(a11y.passes, insights.a11yIssuesClassified),
    ],
  };
}

// ── Layout helpers ────────────────────────────────────────────────────────────

function scoreCard(label, score) {
  const colour = scoreColour(score);
  return {
    table: {
      widths: ['*'],
      body: [[{
        fillColor: LIGHT_GREY,
        margin: [8, 10, 8, 10],
        stack: [
          { text: label.toUpperCase(), fontSize: 7, bold: true, color: GREY, alignment: 'center' },
          { text: String(score), fontSize: 24, bold: true, color: colour, alignment: 'center', margin: [0, 4, 0, 2] },
          { text: scoreLabel(score), fontSize: 7, bold: true, color: colour, alignment: 'center' },
        ],
      }]],
    },
    layout: {
      hLineWidth: () => 1, vLineWidth: () => 1,
      hLineColor: () => '#e2e8f0', vLineColor: () => '#e2e8f0',
    },
  };
}

function scoreInterpretationBlocks(interpretations) {
  const blocks = [];
  const overall = interpretations.overall;
  if (overall) {
    blocks.push({
      table: {
        widths: ['*'],
        body: [[{
          fillColor: '#edf2f7',
          margin: [10, 6, 10, 6],
          stack: [
            { text: overall.comparison, fontSize: 8.5, bold: true, color: NAVY },
            { text: overall.advice, fontSize: 8, color: GREY, margin: [0, 2, 0, 0] },
          ],
        }]],
      },
      layout: { hLineWidth: () => 0, vLineWidth: () => 0 },
      margin: [0, 0, 0, 12],
    });
  }
  return blocks;
}

function categoryInterpretationBlock(interp) {
  if (!interp) return [];
  return [{
    table: {
      widths: ['*'],
      body: [[{
        fillColor: '#edf2f7',
        margin: [10, 6, 10, 6],
        stack: [
          { text: interp.comparison, fontSize: 8, bold: true, color: NAVY },
          { text: interp.advice, fontSize: 7.5, color: GREY, margin: [0, 2, 0, 0] },
        ],
      }]],
    },
    layout: { hLineWidth: () => 0, vLineWidth: () => 0 },
    margin: [0, 0, 0, 4],
  }];
}

function metricInterpretationBlocks(interpretations, keys) {
  const blocks = [];
  for (const key of keys) {
    const text = interpretations[key];
    if (text) {
      blocks.push({
        table: {
          widths: ['*'],
          body: [[{
            fillColor: '#edf2f7',
            margin: [10, 4, 10, 4],
            text: text,
            fontSize: 7.5,
            color: '#4a5568',
          }]],
        },
        layout: { hLineWidth: () => 0, vLineWidth: () => 0 },
        margin: [0, 0, 0, 4],
      });
    }
  }
  return blocks;
}

function topFixesBlocks(fixes, platform) {
  if (!fixes || fixes.length === 0) return [];

  const platformLabels = {
    wordpress: 'WordPress', shopify: 'Shopify', squarespace: 'Squarespace',
    wix: 'Wix', nextjs: 'Next.js', custom: 'Custom', html: 'HTML',
  };
  const platformName = platformLabels[platform] || '';

  const blocks = [];

  const headerText = platform && platform !== 'html'
    ? [
        { text: `Top ${fixes.length} Fixes — What to Do First  `, fontSize: 12, bold: true, color: WHITE },
        { text: `Detected: ${platformName}`, fontSize: 8, bold: true, color: '#63b3ed' },
      ]
    : { text: `Top ${fixes.length} Fixes — What to Do First`, fontSize: 12, bold: true, color: WHITE };

  blocks.push({
    table: {
      widths: ['*'],
      body: [[{
        fillColor: NAVY,
        margin: [12, 10, 12, 10],
        text: headerText,
      }]],
    },
    layout: { hLineWidth: () => 0, vLineWidth: () => 0 },
    margin: [0, 8, 0, 4],
  });

  for (let i = 0; i < fixes.length; i++) {
    const fix = fixes[i];
    const htf = fix.howToFix;
    const priorityAction = fix.priorityAction || 'PLAN';
    const responsibility = fix.responsibility || 'Dev';
    const bi = fix.businessImpact;

    // Fix header row
    const fixStack = [
      { text: fix.title, fontSize: 9, bold: true, color: NAVY },
      {
        columns: [
          { text: priorityAction, fontSize: 6.5, bold: true, color: priorityActionColour(priorityAction), width: 'auto' },
          { text: `Effort: ${fix.effort}`, fontSize: 6.5, color: GREY, width: 'auto', margin: [8, 0, 0, 0] },
          { text: `Owner: ${responsibility}`, fontSize: 6.5, color: GREY, width: 'auto', margin: [8, 0, 0, 0] },
        ],
        margin: [0, 3, 0, 0],
      },
    ];

    // Business impact summary
    if (bi && bi.summary) {
      fixStack.push({ text: bi.summary, fontSize: 7.5, bold: true, color: GREEN, margin: [0, 2, 0, 0] });
    }

    fixStack.push({ text: fix.why, fontSize: 7.5, color: GREY, margin: [0, 2, 0, 0] });
    fixStack.push({
      columns: [
        { text: `${fix.category}`, fontSize: 6.5, color: GREY, width: 'auto' },
      ],
      margin: [0, 2, 0, 0],
    });

    // Add how-to-fix steps
    if (htf && htf.steps) {
      fixStack.push({ text: 'How to Fix:', fontSize: 8, bold: true, color: NAVY, margin: [0, 6, 0, 2] });
      fixStack.push({
        ol: htf.steps.map(step => ({ text: step, fontSize: 7.5, color: '#4a5568', margin: [0, 0, 0, 1] })),
        margin: [4, 0, 0, 0],
      });

      if (htf.estimatedImpact) {
        fixStack.push({ text: htf.estimatedImpact, fontSize: 7.5, italics: true, color: GREEN, margin: [0, 4, 0, 0] });
      }

      if (htf.platformTip) {
        fixStack.push({
          table: {
            widths: ['*'],
            body: [[{
              fillColor: '#ebf8ff',
              margin: [6, 4, 6, 4],
              stack: [
                { text: `${platformName} Tip`, fontSize: 7, bold: true, color: '#2b6cb0' },
                { text: htf.platformTip, fontSize: 7.5, color: '#2c5282', margin: [0, 2, 0, 0] },
              ],
            }]],
          },
          layout: { hLineWidth: () => 0, vLineWidth: () => 0 },
          margin: [0, 4, 0, 0],
        });
      }
    }

    blocks.push({
      table: {
        widths: [36, '*'],
        body: [[
          {
            margin: [4, 4, 4, 4],
            stack: [
              { text: `#${i + 1}`, fontSize: 10, bold: true, color: priorityActionColour(priorityAction) },
              { text: priorityAction, fontSize: 5.5, bold: true, color: priorityActionColour(priorityAction), margin: [0, 2, 0, 0] },
            ],
            alignment: 'center',
          },
          {
            margin: [4, 4, 4, 4],
            stack: fixStack,
          },
        ]],
      },
      layout: {
        hLineWidth: () => 0,
        vLineWidth: () => 0,
        fillColor: () => (i % 2 === 0 ? '#fafafa' : WHITE),
      },
      margin: [0, 0, 0, 2],
    });
  }

  // Add a small spacer after fixes
  blocks.push({ text: '', margin: [0, 0, 0, 8] });

  return blocks;
}

function revenueOpportunitySummaryBlocks(summary) {
  if (!summary) return [];

  return [
    {
      table: {
        widths: ['*'],
        body: [[{
          fillColor: '#0d4f3c',
          margin: [12, 10, 12, 10],
          stack: [
            { text: 'Estimated Impact if All Issues Fixed', fontSize: 12, bold: true, color: WHITE },
            { text: summary.headline, fontSize: 9, bold: true, color: '#68d391', margin: [0, 6, 0, 0] },
          ],
        }]],
      },
      layout: { hLineWidth: () => 0, vLineWidth: () => 0 },
      margin: [0, 8, 0, 4],
    },
    {
      columns: [
        { text: `+${(summary.totalTrafficGain || 0).toLocaleString()}\nMonthly Traffic Gain`, fontSize: 8, alignment: 'center', color: GREEN, bold: true },
        { text: `$${(summary.totalMonthlyValue || 0).toLocaleString()}/mo\nEstimated Monthly Value`, fontSize: 8, alignment: 'center', color: GREEN, bold: true },
        { text: `$${(summary.totalAnnualValue || 0).toLocaleString()}/yr\nEstimated Annual Value`, fontSize: 8, alignment: 'center', color: GREEN, bold: true },
      ],
      margin: [0, 0, 0, 4],
    },
    {
      columns: [
        { text: `${summary.doFirstCount || 0} Do First`, fontSize: 7.5, alignment: 'center', color: GREEN, bold: true },
        { text: `${summary.planCount || 0} Plan`, fontSize: 7.5, alignment: 'center', color: BLUE, bold: true },
        { text: `${summary.niceToHaveCount || 0} Nice to Have`, fontSize: 7.5, alignment: 'center', color: YELLOW, bold: true },
        { text: `${summary.ignoreCount || 0} Ignore`, fontSize: 7.5, alignment: 'center', color: GREY, bold: true },
      ],
      margin: [0, 0, 0, 12],
    },
  ];
}

function sectionHeader(title) {
  return {
    table: {
      widths: ['*'],
      body: [[{ text: title, bold: true, fontSize: 11, color: NAVY, fillColor: LIGHT_GREY, margin: [8, 6, 8, 6] }]],
    },
    layout: { hLineWidth: () => 0, vLineWidth: () => 0 },
    margin: [0, 12, 0, 4],
  };
}

function metaTable(rows) {
  return {
    table: {
      widths: [130, '*'],
      body: rows.map(([k, v]) => [
        { text: k, fontSize: 8, bold: true, color: GREY, margin: [4, 4, 4, 4] },
        { text: v, fontSize: 9, color: NAVY, margin: [4, 4, 4, 4] },
      ]),
    },
    layout: {
      hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0 : 0.5),
      vLineWidth: () => 0,
      hLineColor: () => '#e2e8f0',
      fillColor: (row) => (row % 2 === 0 ? '#fafafa' : WHITE),
    },
    margin: [0, 0, 0, 4],
  };
}

function checklistTableWithSeverity(passes, classifiedIssues) {
  const rows = [
    ...classifiedIssues.map((item) => [
      {
        stack: [
          { text: item.severity.toUpperCase(), fontSize: 6, bold: true, color: severityColour(item.severity), alignment: 'center' },
        ],
        margin: [2, 4, 2, 3],
      },
      { text: item.text, fontSize: 8.5, color: RED, margin: [0, 3, 4, 3] },
    ]),
    ...passes.map((p) => [
      { text: 'PASS', fontSize: 7, bold: true, color: GREEN, margin: [4, 3, 4, 3] },
      { text: p, fontSize: 8.5, color: GREEN, margin: [0, 3, 4, 3] },
    ]),
  ];
  if (!rows.length) return {};
  return {
    table: {
      widths: [36, '*'],
      body: rows,
    },
    layout: {
      hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0 : 0.3),
      vLineWidth: () => 0,
      hLineColor: () => '#e2e8f0',
    },
    margin: [0, 2, 0, 4],
  };
}

module.exports = { generatePdf };
