'use strict';

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
const GREY = '#718096';
const LIGHT_GREY = '#f4f6f9';
const WHITE = '#ffffff';

function scoreColour(s) { return s >= 80 ? GREEN : s >= 50 ? YELLOW : RED; }
function scoreLabel(s) { return s >= 80 ? 'Good' : s >= 50 ? 'Needs Work' : 'Poor'; }

// ── Document definition ───────────────────────────────────────────────────────

function buildDocDefinition(audit, opts) {
  const { agencyName = '', agencyUrl = '' } = opts;
  const { scores, seo, performance: perf, accessibility: a11y } = audit;

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
      // Score overview
      { text: 'Score Overview', fontSize: 13, bold: true, margin: [0, 8, 0, 8] },
      {
        columns: [
          scoreCard('Overall', scores.overall),
          scoreCard('SEO', scores.seo),
          scoreCard('Performance', scores.performance),
          scoreCard('Accessibility', scores.accessibility),
        ],
        columnGap: 8,
        margin: [0, 0, 0, 16],
      },

      // Page info
      sectionHeader('Page Info'),
      metaTable([
        ['HTTP Status', String(audit.statusCode)],
        ['Time to First Byte', `${audit.ttfbMs} ms`],
        ['HTML Size', `${audit.pageSizeKb} KB`],
        ['Encoding', perf.contentEncoding || 'none'],
      ]),

      // SEO
      sectionHeader(`SEO  —  ${scores.seo}/100`),
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
      checklistTable(seo.passes, seo.issues),

      // Performance
      sectionHeader(`Performance  —  ${scores.performance}/100`),
      metaTable([
        ['TTFB', `${perf.ttfbMs} ms`],
        ['HTML Size', `${perf.pageSizeKb} KB`],
        ['Render-blocking JS', String(perf.renderBlockingJs)],
        ['Render-blocking CSS', String(perf.renderBlockingCss)],
        ['Images', `${perf.imagesTotal} total, ${perf.imagesWithoutSrcset} without srcset/lazy`],
      ]),
      checklistTable(perf.passes, perf.issues),

      // Accessibility
      sectionHeader(`Accessibility  —  ${scores.accessibility}/100`),
      metaTable([
        ['Images without alt', String(a11y.imgsNoAlt)],
        ['Unlabelled inputs', String(a11y.unlabelledInputs)],
        ['Heading order', a11y.headingOrderOk ? 'Correct' : 'Skipped levels'],
        ['Main landmark', a11y.hasMain ? 'Present' : 'Missing'],
        ['Skip link', a11y.skipLink ? 'Present' : 'Missing'],
        ['Unlabelled buttons', String(a11y.btnsNoName)],
      ]),
      checklistTable(a11y.passes, a11y.issues),
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

function checklistTable(passes, issues) {
  const rows = [
    ...issues.map((i) => [
      { text: 'FAIL', fontSize: 7, bold: true, color: RED, margin: [4, 3, 4, 3] },
      { text: i, fontSize: 8.5, color: RED, margin: [0, 3, 4, 3] },
    ]),
    ...passes.map((p) => [
      { text: 'PASS', fontSize: 7, bold: true, color: GREEN, margin: [4, 3, 4, 3] },
      { text: p, fontSize: 8.5, color: GREEN, margin: [0, 3, 4, 3] },
    ]),
  ];
  if (!rows.length) return {};
  return {
    table: {
      widths: [28, '*'],
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
