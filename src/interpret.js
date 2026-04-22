'use strict';

/**
 * Interpretation layer for audit reports.
 *
 * Adds plain-English explanations, severity labels, ranked fix lists,
 * and benchmark comparisons for every audit finding.
 */

// ── Severity levels ──────────────────────────────────────────────────────────

const SEVERITY = { CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };

// ── Responsibility mapping ──────────────────────────────────────────────────
// Maps issue patterns to who should fix them: Dev, Designer, Marketing, Hosting

const RESPONSIBILITY_MAP = {
  'noindex directive': 'Dev',
  'Missing viewport meta': 'Dev',
  'HTTP error status': 'Dev',
  'Title missing or too long': 'Marketing',
  'Meta description missing or out of 50–160 range': 'Marketing',
  'Page should have exactly one H1': 'Marketing',
  'No canonical URL defined': 'Dev',
  'Missing lang attribute on <html>': 'Dev',
  'Missing og:title': 'Marketing',
  'Missing og:image': 'Marketing',
  'No JSON-LD structured data found': 'Dev',
  'HTML payload too large': 'Dev',
  'Slow time-to-first-byte': 'Hosting',
  'render-blocking <script>': 'Dev',
  'stylesheets may block rendering': 'Dev',
  'image(s) missing srcset or loading="lazy"': 'Dev',
  'Response not compressed': 'Hosting',
  'image(s) missing alt attribute': 'Marketing',
  'form input(s) missing label or aria-label': 'Dev',
  'Heading levels are skipped': 'Marketing',
  'No skip-navigation link detected': 'Dev',
  'No <main> landmark': 'Dev',
  'Missing lang attribute — screen readers cannot select voice': 'Dev',
  'button(s) have no visible or accessible name': 'Dev',
};

function getResponsibility(issueText) {
  for (const [pattern, owner] of Object.entries(RESPONSIBILITY_MAP)) {
    if (issueText.includes(pattern)) return owner;
  }
  return 'Dev';
}

// ── Priority matrix (effort-vs-impact) ──────────────────────────────────────
// Replaces technical severity with actionable priority labels

function getPriorityAction(impactScore, effortScore) {
  const highImpact = impactScore >= 7;
  const lowEffort = effortScore <= 1;

  if (highImpact && lowEffort) return 'DO FIRST';
  if (highImpact && !lowEffort) return 'PLAN';
  if (!highImpact && lowEffort) return 'NICE TO HAVE';
  return 'IGNORE FOR NOW';
}

// ── Business impact estimation ──────────────────────────────────────────────
// Converts technical issues into revenue-impact estimates

const DEFAULT_MONTHLY_TRAFFIC = 500;
const DEFAULT_CONVERSION_RATE = 0.025;
const DEFAULT_AVG_VALUE = 100;

function computeBusinessImpact(trafficImpact, effortScore, category) {
  const trafficGain = Math.round(DEFAULT_MONTHLY_TRAFFIC * (trafficImpact / 100));
  const conversions = trafficGain * DEFAULT_CONVERSION_RATE;
  const monthlyValue = Math.round(conversions * DEFAULT_AVG_VALUE);
  const annualValue = monthlyValue * 12;
  const speedImpactSec = trafficImpact >= 40 ? 1.5 : trafficImpact >= 20 ? 0.5 : 0;
  const conversionLoss = speedImpactSec > 0 ? Math.round(speedImpactSec * 7) : 0;

  return {
    trafficGain,
    monthlyValue,
    annualValue,
    conversionLoss,
    summary: buildBusinessSummary(trafficGain, monthlyValue, annualValue, conversionLoss, effortScore, category),
  };
}

function buildBusinessSummary(trafficGain, monthlyValue, annualValue, conversionLoss, effortScore, category) {
  const parts = [];
  const effortLabel = effortScore <= 1 ? '< 1 hour' : effortScore <= 2 ? '1–4 hours' : '4+ hours';

  if (category === 'Accessibility') {
    // Accessibility: frame as compliance risk + audience reach, not speed stats
    if (trafficGain > 0) {
      parts.push(`This accessibility gap may exclude ~${trafficGain} visitors/mo`);
    }
    if (monthlyValue > 0) {
      parts.push(`worth ~$${monthlyValue.toLocaleString()}/mo`);
    }
    parts.push(`estimated effort: ${effortLabel}`);
    return parts.join(', ') + '.';
  }

  if (category === 'Performance') {
    // Performance: frame as conversion/bounce impact, not generic traffic
    if (conversionLoss > 0) {
      parts.push(`Slow load adds ~${(conversionLoss / 7).toFixed(1)}s delay, reducing conversions by ~${conversionLoss}%`);
    }
    if (monthlyValue > 0) {
      parts.push(`estimated lost revenue: ~$${monthlyValue.toLocaleString()}/mo`);
    }
    parts.push(`estimated effort: ${effortLabel}`);
    return parts.join(', ') + '.';
  }

  // SEO: frame as traffic/visibility
  if (trafficGain > 0) {
    parts.push(`Fixing this could recover ~${trafficGain} monthly visits`);
  }
  if (monthlyValue > 0) {
    parts.push(`worth ~$${monthlyValue.toLocaleString()}/mo ($${annualValue.toLocaleString()}/yr)`);
  }
  parts.push(`estimated effort: ${effortLabel}`);
  return parts.join(', ') + '.';
}

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
    estimatedImpact: 'Your page will become visible to search engines immediately — this alone can restore all organic traffic.',
    steps: [
      'Open your page\'s HTML source or template file',
      'Search for <meta name="robots" content="noindex"> or similar noindex directives',
      'Remove the entire meta tag, or change "noindex" to "index"',
      'Save and redeploy your site',
      'Use Google Search Console to request re-indexing of the URL',
    ],
    platformTips: {
      wordpress: 'Go to Settings → Reading → uncheck "Discourage search engines from indexing this site". Per-page: edit the page → Yoast SEO box → toggle "Allow search engines to show this page".',
      shopify: 'Edit the page/product → scroll to "Search engine listing" → ensure the page is not marked as hidden. Check theme.liquid for any noindex meta tags.',
      squarespace: 'Go to the page settings → SEO tab → uncheck "Hide this page from search results".',
    },
  },
  'Missing viewport meta': {
    title: 'Add viewport meta tag',
    impact: 10, effort: 1, effortLabel: 'Quick fix (< 10 min)',
    why: 'Without a viewport tag, your site looks broken on mobile. Google penalizes non-mobile-friendly sites in search results.',
    estimatedImpact: 'Could improve mobile usability score significantly and prevent Google\'s mobile-unfriendly penalty.',
    steps: [
      'Open your HTML template or main layout file',
      'Add this tag inside the <head> section: <meta name="viewport" content="width=device-width, initial-scale=1">',
      'Save and redeploy',
    ],
    platformTips: {
      wordpress: 'Most themes include this by default. If missing, add it to your theme\'s header.php or use the "Insert Headers and Footers" plugin.',
      shopify: 'Add the viewport tag to your theme.liquid file inside the <head> section. Most Shopify themes include it already.',
      squarespace: 'Squarespace includes this automatically. If missing, contact Squarespace support.',
    },
  },
  'HTTP error status': {
    title: 'Fix HTTP error response',
    impact: 10, effort: 3, effortLabel: 'Significant (> 1 hour)',
    why: 'Your page returns an error status code. Search engines will not index it and users see an error page.',
    estimatedImpact: 'Fixing the error will restore page access for all users and allow search engine indexing.',
    steps: [
      'Check your server logs for the specific error (e.g. 404, 500, 503)',
      'For 404 errors: verify the URL is correct and the page/file exists',
      'For 500 errors: check server logs for application errors, database connection issues, or configuration problems',
      'For 503 errors: check if your server is overloaded or in maintenance mode',
      'Test the fix by loading the page in a browser and verifying a 200 status',
    ],
    platformTips: {
      wordpress: 'Check wp-config.php for errors, deactivate plugins one by one to find conflicts, and enable WP_DEBUG in wp-config.php to see detailed errors.',
      shopify: 'Check if the page or product was deleted or unpublished. Shopify handles most server errors — contact support if 500 errors persist.',
    },
  },
  'Response not compressed': {
    title: 'Enable gzip or brotli compression',
    impact: 8, effort: 1, effortLabel: 'Quick fix (< 10 min)',
    why: 'Compression reduces transfer size by 60-80%. This is usually a single server config change with major speed gains.',
    estimatedImpact: 'Could reduce page load time by 0.5–2s depending on page size — one of the easiest performance wins.',
    steps: [
      'Check if your hosting provider or CDN already supports compression (most do)',
      'For Apache: add to .htaccess: AddOutputFilterByType DEFLATE text/html text/css application/javascript',
      'For Nginx: add to nginx.conf: gzip on; gzip_types text/html text/css application/javascript;',
      'For Node.js/Express: add the "compression" middleware (npm install compression)',
      'Verify compression is working: check the Content-Encoding response header is "gzip" or "br"',
    ],
    platformTips: {
      wordpress: 'Install a caching plugin like WP Super Cache or W3 Total Cache — these enable gzip automatically. Or add the gzip rules to your .htaccess file.',
      shopify: 'Shopify automatically compresses responses. If this issue appears, it may be a CDN or proxy issue in front of Shopify.',
      squarespace: 'Squarespace handles compression automatically. If this issue appears, check for any proxy or CDN misconfiguration.',
    },
  },
  'Slow time-to-first-byte': {
    title: 'Improve server response time (TTFB)',
    impact: 8, effort: 3, effortLabel: 'Significant (> 1 hour)',
    why: 'A slow server delays everything. Consider caching, a CDN, or upgrading hosting.',
    estimatedImpact: 'Could reduce initial page load by 0.5–3s. Everything else loads faster when the server responds quickly.',
    steps: [
      'Enable server-side caching (page caching, object caching, or database query caching)',
      'Set up a CDN like Cloudflare (free tier available) to serve cached pages from servers closer to your visitors',
      'Optimize your database queries — look for slow queries in server logs',
      'Upgrade your hosting plan if on shared hosting (VPS or managed hosting is much faster)',
      'If using a CMS, reduce the number of active plugins and avoid plugins that run heavy database queries on every page load',
    ],
    platformTips: {
      wordpress: 'Install a caching plugin (WP Super Cache, W3 Total Cache, or LiteSpeed Cache). Use a CDN. Consider managed WordPress hosting like WP Engine or Kinsta.',
      shopify: 'Shopify handles server performance. Slow TTFB usually means too many Liquid template operations — simplify your theme, reduce app scripts.',
      squarespace: 'Squarespace handles hosting. If TTFB is slow, minimize custom code injections and third-party scripts.',
    },
  },
  'Title missing or too long': {
    title: 'Fix page title tag',
    impact: 8, effort: 1, effortLabel: 'Quick fix (< 10 min)',
    why: 'The title tag is the most important on-page SEO element. It appears in search results and browser tabs.',
    estimatedImpact: 'Could improve search ranking position and click-through rate by 10–20% for this page.',
    steps: [
      'Open your HTML file or page editor',
      'Find or add the <title> tag inside the <head> section',
      'Write a concise, descriptive title under 60 characters that includes your target keyword',
      'Format: "Primary Keyword — Brand Name" (e.g., "Handmade Leather Bags — MyShop")',
      'Save and verify the title appears correctly in the browser tab',
    ],
    platformTips: {
      wordpress: 'Install Yoast SEO or Rank Math plugin → edit the page → use the SEO title field to set a custom title without editing code.',
      shopify: 'Edit the page/product → scroll to "Search engine listing" → click "Edit" → update the Page title field.',
      squarespace: 'Edit the page → Settings (gear icon) → SEO tab → enter your SEO title.',
    },
  },
  'Meta description missing': {
    title: 'Add or fix meta description',
    impact: 7, effort: 1, effortLabel: 'Quick fix (< 10 min)',
    why: 'A good meta description improves click-through rates from search results. Without one, Google picks random page text.',
    estimatedImpact: 'A compelling meta description can improve click-through rate from search results by 5–10%.',
    steps: [
      'Open your HTML file or page editor',
      'Add inside <head>: <meta name="description" content="Your description here">',
      'Write 50–160 characters that summarize the page and include a call to action',
      'Include your primary keyword naturally in the description',
      'Avoid duplicate descriptions across pages — each page needs a unique one',
    ],
    platformTips: {
      wordpress: 'Edit the page → scroll to the Yoast SEO box → fill in the "Meta description" field. Preview how it looks in search results.',
      shopify: 'Edit the page/product → scroll to "Search engine listing" → click "Edit" → update the Description field.',
      squarespace: 'Edit the page → Settings (gear icon) → SEO tab → enter your SEO description.',
    },
  },
  'No canonical URL': {
    title: 'Set a canonical URL',
    impact: 7, effort: 1, effortLabel: 'Quick fix (< 10 min)',
    why: 'Without a canonical URL, search engines may treat duplicate pages as separate, diluting your ranking.',
    estimatedImpact: 'Prevents duplicate content issues and consolidates link equity — could improve ranking for affected pages.',
    steps: [
      'Open your HTML file or page template',
      'Add inside <head>: <link rel="canonical" href="https://yoursite.com/this-page">',
      'Use the full, absolute URL (including https://)',
      'Ensure the canonical URL points to the preferred version of the page (with or without www, with or without trailing slash)',
      'Verify with Google Search Console that no duplicate content warnings remain',
    ],
    platformTips: {
      wordpress: 'Yoast SEO adds canonical URLs automatically. To customize: edit the page → Yoast → Advanced → Canonical URL field.',
      shopify: 'Shopify adds canonical URLs automatically. If you need to override: edit theme.liquid and modify the canonical tag in <head>.',
      squarespace: 'Squarespace adds canonical URLs automatically for all pages.',
    },
  },
  'render-blocking <script>': {
    title: 'Defer render-blocking scripts',
    impact: 7, effort: 1, effortLabel: 'Quick fix (< 10 min)',
    why: 'Render-blocking scripts delay page display. Adding async or defer lets the page show content while scripts load.',
    estimatedImpact: 'Could reduce perceived load time by 0.5–1.5s — users see content faster even if total load time is similar.',
    steps: [
      'Find all <script src="..."> tags in your HTML (without async or defer attributes)',
      'Add the "defer" attribute to scripts that need DOM access: <script defer src="...">',
      'Add the "async" attribute to independent scripts (analytics, ads): <script async src="...">',
      'Move non-critical scripts to the bottom of <body> as an alternative',
      'Test that your page still works correctly after making changes',
    ],
    platformTips: {
      wordpress: 'Use the "Autoptimize" or "Asset CleanUp" plugin to automatically defer/async scripts without editing code.',
      shopify: 'Edit your theme files (theme.liquid, sections) and add defer to <script> tags. Be careful with Shopify\'s own scripts.',
    },
  },
  'image(s) missing alt attribute': {
    title: 'Add alt text to images',
    impact: 7, effort: 2, effortLabel: 'Medium (< 1 hour)',
    why: 'Alt text is essential for screen reader users and helps search engines understand your images.',
    estimatedImpact: 'Improves accessibility compliance, image search traffic, and could boost SEO score by 5–10 points.',
    steps: [
      'Find all <img> tags missing the alt attribute',
      'Add descriptive alt text: <img src="photo.jpg" alt="Red leather handbag on wooden table">',
      'For decorative images, use an empty alt: <img src="divider.png" alt="">',
      'Keep alt text under 125 characters — be concise but descriptive',
      'Include relevant keywords naturally, but avoid keyword stuffing',
    ],
    platformTips: {
      wordpress: 'Go to Media Library → click each image → fill in the "Alt Text" field. For existing posts, edit and click each image to add alt text.',
      shopify: 'Go to Products/Pages → click the image → fill in the "Alt text" field in the image details panel.',
      squarespace: 'Click any image in the editor → click the pencil icon → fill in the "Image alt text" field.',
    },
  },
  'form input(s) missing label': {
    title: 'Label all form inputs',
    impact: 7, effort: 2, effortLabel: 'Medium (< 1 hour)',
    why: 'Unlabelled form fields are unusable for screen reader users and violate WCAG accessibility standards.',
    estimatedImpact: 'Fixes a WCAG 2.1 Level A violation — required for accessibility compliance and improves usability for all users.',
    steps: [
      'Find all <input>, <select>, and <textarea> elements without associated labels',
      'Add a <label> element: <label for="email">Email address</label> <input id="email" type="email">',
      'The "for" attribute must match the input\'s "id" attribute',
      'Alternative: use aria-label for visually-hidden labels: <input aria-label="Search" type="search">',
      'Test with a screen reader or browser accessibility tools to verify labels are announced',
    ],
    platformTips: {
      wordpress: 'Use a forms plugin like WPForms or Gravity Forms which automatically adds proper labels. For custom forms, edit the HTML directly.',
      shopify: 'Edit your theme\'s form templates (e.g., contact form, newsletter form) to add <label> elements to each input.',
    },
  },
  'button(s) have no visible or accessible name': {
    title: 'Add accessible names to buttons',
    impact: 7, effort: 1, effortLabel: 'Quick fix (< 10 min)',
    why: 'Unnamed buttons are meaningless to screen reader users. Add visible text or aria-label.',
    estimatedImpact: 'Fixes a WCAG 2.1 Level A violation — critical for screen reader users to understand button actions.',
    steps: [
      'Find all <button> elements without text content or aria-label',
      'Add visible text inside the button: <button>Submit</button>',
      'For icon-only buttons, add aria-label: <button aria-label="Close menu"><svg>...</svg></button>',
      'Avoid using aria-label when visible text is present — just use the visible text',
      'Test buttons with a screen reader to verify they announce correctly',
    ],
    platformTips: {
      wordpress: 'Check your theme\'s template files for icon-only buttons (common in headers, sliders). Add aria-label attributes directly.',
      shopify: 'Edit theme sections to add aria-label to icon-only buttons (cart, search, hamburger menu are common offenders).',
    },
  },
  'exactly one H1': {
    title: 'Fix H1 heading structure',
    impact: 5, effort: 1, effortLabel: 'Quick fix (< 10 min)',
    why: 'Having exactly one H1 helps search engines understand your page topic. Multiple or missing H1s confuse ranking signals.',
    estimatedImpact: 'Could improve search engine understanding of your page topic — minor but meaningful SEO signal.',
    steps: [
      'Check if your page has zero H1 tags or multiple H1 tags',
      'If missing: add one H1 that describes the main topic of the page',
      'If multiple: change extra H1 tags to H2 or H3 as appropriate',
      'The H1 should be the most prominent heading on the page and include your target keyword',
      'Ensure heading hierarchy flows logically: H1 → H2 → H3 (no skipping)',
    ],
    platformTips: {
      wordpress: 'The page/post title is usually the H1. Avoid using H1 in the content editor — use H2 and below. Check your theme for duplicate H1s in the header/logo area.',
      shopify: 'Product and page titles are automatically H1. Check your theme template for additional H1 tags in headers or sections.',
      squarespace: 'The page title is the H1. In the content editor, use Heading 2 and below — never Heading 1.',
    },
  },
  'HTML payload too large': {
    title: 'Reduce HTML payload size',
    impact: 5, effort: 2, effortLabel: 'Medium (< 1 hour)',
    why: 'Large HTML slows initial page load, especially on mobile networks. Minify and remove unused inline content.',
    estimatedImpact: 'Could reduce page load time by 0.3–1s on mobile connections.',
    steps: [
      'Minify your HTML by removing unnecessary whitespace and comments',
      'Move inline CSS to external stylesheets',
      'Move inline JavaScript to external files',
      'Remove any large SVGs embedded directly in the HTML — reference them as external files instead',
      'If using a framework, check for server-side rendering that outputs unnecessary HTML',
    ],
    platformTips: {
      wordpress: 'Install an optimization plugin like Autoptimize or WP Rocket which minifies HTML automatically.',
      shopify: 'Minimize Liquid template output — avoid unnecessary whitespace with {%- -%} tags. Remove unused sections from templates.',
    },
  },
  'image(s) missing srcset or loading="lazy"': {
    title: 'Optimize images with srcset and lazy loading',
    impact: 6, effort: 2, effortLabel: 'Medium (< 1 hour)',
    why: 'Without responsive images and lazy loading, mobile users download unnecessarily large files and off-screen images load immediately.',
    estimatedImpact: 'Could reduce page weight by 30–60% on mobile and cut load time by 1–3s for image-heavy pages.',
    steps: [
      'Add loading="lazy" to images below the fold: <img src="photo.jpg" loading="lazy" alt="...">',
      'Do NOT lazy-load the hero image or images visible on initial load',
      'Add srcset for responsive images: <img src="photo-800.jpg" srcset="photo-400.jpg 400w, photo-800.jpg 800w, photo-1200.jpg 1200w" sizes="(max-width: 600px) 400px, 800px">',
      'Compress images before uploading using TinyPNG.com or Squoosh.app',
      'Consider using modern formats like WebP for further savings (30% smaller than JPEG)',
    ],
    platformTips: {
      wordpress: 'WordPress 5.5+ adds loading="lazy" automatically. For srcset, use a plugin like ShortPixel or Imagify to auto-generate multiple sizes.',
      shopify: 'Use Shopify\'s built-in image_tag filter which generates srcset automatically. Add loading="lazy" to below-fold images in theme templates.',
      squarespace: 'Squarespace handles lazy loading and responsive images automatically. Upload the highest quality image — Squarespace creates the variants.',
    },
  },
  'stylesheets may block rendering': {
    title: 'Reduce render-blocking stylesheets',
    impact: 5, effort: 2, effortLabel: 'Medium (< 1 hour)',
    why: 'Too many stylesheets delay first paint. Combine them or inline critical CSS.',
    estimatedImpact: 'Could reduce time to first paint by 0.3–1s.',
    steps: [
      'Combine multiple CSS files into one to reduce HTTP requests',
      'Inline critical (above-the-fold) CSS directly in a <style> tag in <head>',
      'Load non-critical CSS asynchronously: <link rel="preload" href="style.css" as="style" onload="this.onload=null;this.rel=\'stylesheet\'">',
      'Remove unused CSS rules — tools like PurgeCSS can help identify them',
      'Use media attributes to only load print styles when printing: <link rel="stylesheet" href="print.css" media="print">',
    ],
    platformTips: {
      wordpress: 'Use WP Rocket or Autoptimize to combine and minify CSS. These plugins also handle critical CSS generation.',
      shopify: 'Minimize the number of external stylesheets in your theme. Combine custom CSS into one file in assets/.',
    },
  },
  'No <main> landmark': {
    title: 'Add a <main> landmark',
    impact: 4, effort: 1, effortLabel: 'Quick fix (< 10 min)',
    why: 'Screen reader users cannot skip to your main content without a <main> element.',
    estimatedImpact: 'Improves screen reader navigation — small effort for meaningful accessibility improvement.',
    steps: [
      'Find the primary content area of your page template',
      'Wrap it with <main> tags: <main>...your content...</main>',
      'Only use one <main> element per page',
      'The <main> should not include navigation, sidebars, or footers',
    ],
    platformTips: {
      wordpress: 'Edit your theme\'s page templates (single.php, page.php, index.php) and wrap the content area with <main>. Many modern themes already include this.',
      shopify: 'Edit theme.liquid or your main template and wrap the content_for_layout section with <main> tags.',
      squarespace: 'Squarespace templates usually include <main>. If missing, add it via Code Injection → Header/Footer.',
    },
  },
  'Heading levels are skipped': {
    title: 'Fix heading hierarchy',
    impact: 4, effort: 1, effortLabel: 'Quick fix (< 10 min)',
    why: 'Skipping heading levels (e.g. H1 to H3) confuses screen readers and hurts document structure.',
    estimatedImpact: 'Improves content structure for search engines and screen reader users.',
    steps: [
      'Review your page\'s heading tags in order (H1, H2, H3, etc.)',
      'Ensure headings follow a logical hierarchy: H1 → H2 → H3 (never skip, e.g. H1 → H3)',
      'Change any out-of-order headings to the correct level',
      'Use headings for structure, not for visual styling — use CSS classes for sizing instead',
    ],
    platformTips: {
      wordpress: 'In the block editor, check heading blocks and ensure they follow the correct order. Avoid jumping from Heading 2 to Heading 4.',
      shopify: 'Check theme section templates for hardcoded heading levels. Ensure product/collection sections use consistent heading order.',
      squarespace: 'In the content editor, use heading levels sequentially. Squarespace uses Heading 1–3 in the formatting options.',
    },
  },
  'Missing lang attribute': {
    title: 'Add lang attribute to <html>',
    impact: 4, effort: 1, effortLabel: 'Quick fix (< 10 min)',
    why: 'Screen readers need the lang attribute to select the correct pronunciation. Also helps SEO.',
    estimatedImpact: 'Helps search engines serve your page to the right language audience and improves screen reader pronunciation.',
    steps: [
      'Open your main HTML template file',
      'Add the lang attribute to the <html> tag: <html lang="en"> (use your page\'s language code)',
      'Common codes: "en" (English), "es" (Spanish), "fr" (French), "de" (German), "pt" (Portuguese)',
      'For regional variants: "en-US", "en-GB", "pt-BR"',
    ],
    platformTips: {
      wordpress: 'WordPress sets this automatically based on Settings → General → Site Language. If missing, check your theme\'s header.php for the <html> tag.',
      shopify: 'Set in theme.liquid: <html lang="{{ request.locale.iso_code }}"> — most themes include this.',
      squarespace: 'Go to Settings → Language & Region → Site Language. Squarespace sets the lang attribute automatically.',
    },
  },
  'No skip-navigation link': {
    title: 'Add a skip navigation link',
    impact: 3, effort: 1, effortLabel: 'Quick fix (< 10 min)',
    why: 'Keyboard users must tab through your entire navigation before reaching content. A skip link saves them time.',
    estimatedImpact: 'Important for keyboard and screen reader users — a WCAG 2.1 Level A requirement.',
    steps: [
      'Add a hidden link as the first element inside <body>:',
      '<a href="#main-content" class="skip-link">Skip to main content</a>',
      'Add an id to your main content: <main id="main-content">',
      'Style the skip link to be visually hidden but visible on focus: .skip-link { position: absolute; left: -9999px; } .skip-link:focus { left: 10px; top: 10px; z-index: 9999; }',
      'Test by pressing Tab on page load — the skip link should appear',
    ],
    platformTips: {
      wordpress: 'Many modern themes include a skip link. If yours doesn\'t, add it to header.php right after the <body> tag.',
      shopify: 'Add the skip link to theme.liquid right after the <body> tag. Target the main content container with the id attribute.',
    },
  },
  'Missing og:title': {
    title: 'Add Open Graph title',
    impact: 3, effort: 1, effortLabel: 'Quick fix (< 10 min)',
    why: 'Without og:title, social media shares of your page use a generic or missing title, reducing click-through.',
    estimatedImpact: 'Better social media previews lead to more clicks when your content is shared.',
    steps: [
      'Add inside <head>: <meta property="og:title" content="Your Page Title Here">',
      'Keep it under 60 characters for best display across platforms',
      'Make it compelling — this is what people see when your page is shared on Facebook, LinkedIn, etc.',
    ],
    platformTips: {
      wordpress: 'Yoast SEO → edit the page → Social tab → Facebook title. This sets og:title automatically.',
      shopify: 'Shopify sets og:title from the page title by default. To customize, edit theme.liquid.',
      squarespace: 'Squarespace sets og:title automatically from the page title. Customize in page Settings → Social Image.',
    },
  },
  'Missing og:image': {
    title: 'Add Open Graph image',
    impact: 3, effort: 1, effortLabel: 'Quick fix (< 10 min)',
    why: 'Social shares without an image get much less engagement. A good og:image can significantly boost sharing.',
    estimatedImpact: 'Posts with images get 2–3x more engagement on social media.',
    steps: [
      'Create or choose a high-quality image (recommended: 1200×630 pixels)',
      'Add inside <head>: <meta property="og:image" content="https://yoursite.com/images/share-image.jpg">',
      'Use an absolute URL (including https://)',
      'Test with Facebook\'s Sharing Debugger (developers.facebook.com/tools/debug/) to preview how it looks',
    ],
    platformTips: {
      wordpress: 'Yoast SEO → edit the page → Social tab → upload a Facebook image. Or set a default image in Yoast → Social → Facebook.',
      shopify: 'Shopify uses the featured image as og:image. To set a custom one, edit theme.liquid.',
      squarespace: 'Edit the page → Settings → Social Image → upload your sharing image.',
    },
  },
  'No JSON-LD structured data': {
    title: 'Add structured data (JSON-LD)',
    impact: 3, effort: 2, effortLabel: 'Medium (< 1 hour)',
    why: 'Structured data enables rich search results (star ratings, FAQ dropdowns, etc.) which increase click-through rates.',
    estimatedImpact: 'Rich results can improve click-through rate by 20–30% in search results.',
    steps: [
      'Choose the right schema type for your page: Organization, LocalBusiness, Product, Article, FAQ, etc.',
      'Create a JSON-LD script block and add it to your <head> or <body>:',
      '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Your Business","url":"https://yoursite.com"}</script>',
      'Use Google\'s Schema Markup Validator (validator.schema.org) to test your markup',
      'Use Google\'s Rich Results Test (search.google.com/test/rich-results) to see if your page qualifies for rich results',
    ],
    platformTips: {
      wordpress: 'Install the "Schema" or "Rank Math" plugin which generates JSON-LD automatically for posts, pages, and products.',
      shopify: 'Many Shopify themes include Product and Organization schema. For additional types, use an app like "JSON-LD for SEO" from the Shopify App Store.',
      squarespace: 'Squarespace adds basic schema automatically. For custom schema, add JSON-LD via Code Injection → Header.',
    },
  },
};

function matchFixDetail(issueText) {
  for (const [pattern, detail] of Object.entries(FIX_DETAILS)) {
    if (issueText.includes(pattern)) return detail;
  }
  return null;
}

// ── Estimated traffic impact weights ────────────────────────────────────────
// Maps issue patterns to estimated monthly traffic impact (relative scale 1-100).
// These estimates are based on industry averages for how much each issue type
// typically affects organic traffic when fixed.

const TRAFFIC_IMPACT_ESTIMATES = {
  'noindex directive': { trafficImpact: 100, rationale: 'Page is completely invisible to search engines — fixing restores all potential organic traffic.' },
  'Missing viewport meta': { trafficImpact: 85, rationale: 'Google\'s mobile-first indexing penalizes non-mobile-friendly pages heavily.' },
  'HTTP error status': { trafficImpact: 95, rationale: 'Error pages cannot rank and lose all organic traffic for their target queries.' },
  'Title missing or too long': { trafficImpact: 70, rationale: 'Title tag is the strongest on-page ranking signal — fixing can improve position by 1-3 spots.' },
  'Meta description missing': { trafficImpact: 40, rationale: 'Improves click-through rate by 5-10% but does not directly affect ranking position.' },
  'No canonical URL': { trafficImpact: 55, rationale: 'Prevents duplicate content dilution — consolidates ranking signals to the preferred URL.' },
  'exactly one H1': { trafficImpact: 25, rationale: 'Minor ranking signal but helps search engines understand page topic.' },
  'Missing lang attribute': { trafficImpact: 20, rationale: 'Helps international SEO and correct language targeting.' },
  'Missing og:title': { trafficImpact: 10, rationale: 'Social signals only — improves sharing appearance but minimal direct SEO impact.' },
  'Missing og:image': { trafficImpact: 10, rationale: 'Social signals only — improves sharing engagement.' },
  'No JSON-LD structured data': { trafficImpact: 35, rationale: 'Enables rich results which can boost CTR by 20-30%.' },
  'Response not compressed': { trafficImpact: 45, rationale: 'Improves Core Web Vitals which is a direct Google ranking factor.' },
  'Slow time-to-first-byte': { trafficImpact: 50, rationale: 'Slow servers hurt crawl efficiency and user experience signals.' },
  'render-blocking <script>': { trafficImpact: 40, rationale: 'Affects LCP and page experience signals used in ranking.' },
  'HTML payload too large': { trafficImpact: 25, rationale: 'Slows page load, especially on mobile — indirect ranking impact via Core Web Vitals.' },
  'stylesheets may block rendering': { trafficImpact: 20, rationale: 'Minor performance impact on first paint timing.' },
  'image(s) missing srcset or loading="lazy"': { trafficImpact: 30, rationale: 'Affects page speed on mobile, impacting Core Web Vitals.' },
  'image(s) missing alt attribute': { trafficImpact: 30, rationale: 'Improves image search traffic and accessibility compliance.' },
  'form input(s) missing label': { trafficImpact: 5, rationale: 'Accessibility compliance — minimal direct traffic impact.' },
  'Heading levels are skipped': { trafficImpact: 10, rationale: 'Minor structural issue — helps content parsing.' },
  'No skip-navigation link': { trafficImpact: 2, rationale: 'Accessibility best practice — no direct traffic impact.' },
  'No <main> landmark': { trafficImpact: 5, rationale: 'Accessibility landmark — minimal traffic impact.' },
  'button(s) have no visible or accessible name': { trafficImpact: 5, rationale: 'Accessibility compliance — no direct SEO traffic impact.' },
};

function estimateTrafficImpact(issueText) {
  for (const [pattern, data] of Object.entries(TRAFFIC_IMPACT_ESTIMATES)) {
    if (issueText.includes(pattern)) return data;
  }
  return { trafficImpact: 15, rationale: 'General improvement — moderate potential impact.' };
}

// ── Build prioritized fix list ───────────────────────────────────────────────

function buildTopFixes(audit, maxFixes, platform) {
  maxFixes = maxFixes || 5;
  platform = platform || 'html';
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
      const trafficData = estimateTrafficImpact(issue);

      // Impact-based priority: traffic impact * ease-of-fix multiplier
      const effortMultiplier = detail ? (4 - Math.min(detail.effort, 3)) : 2;
      const priorityScore = trafficData.trafficImpact * effortMultiplier;

      // Build how-to-fix object from detail
      let howToFix = null;
      if (detail && detail.steps) {
        const platformTip = detail.platformTips && detail.platformTips[platform]
          ? detail.platformTips[platform]
          : null;
        howToFix = {
          steps: detail.steps,
          estimatedImpact: detail.estimatedImpact || null,
          platformTip,
          platform: platformTip ? platform : null,
        };
      }

      const impactScore = detail ? detail.impact : severityToScore(severity) / 3;
      const effortScoreRaw = detail ? detail.effort : 2;
      const priorityAction = getPriorityAction(impactScore, effortScoreRaw);
      const responsibility = getResponsibility(issue);
      let businessImpact = computeBusinessImpact(trafficData.trafficImpact, effortScoreRaw, cat.name);

      // Fix IGNORE vs. value contradiction: items marked IGNORE should not show
      // meaningful dollar values — it undermines credibility to say something is
      // worth $375/mo but also tell the user to ignore it.
      if (priorityAction === 'IGNORE FOR NOW') {
        businessImpact = {
          trafficGain: 0,
          monthlyValue: 0,
          annualValue: 0,
          conversionLoss: 0,
          summary: `Low impact and high effort — not worth prioritizing right now. Revisit if your top issues are resolved.`,
        };
      }

      allIssues.push({
        category: cat.name,
        issue,
        severity,
        title: detail ? detail.title : shortenIssue(issue),
        impact: detail ? impactLabel(detail.impact) : severityToImpactLabel(severity),
        effort: detail ? detail.effortLabel : 'Unknown',
        why: detail ? detail.why : issue,
        priorityScore,
        trafficImpact: trafficData.trafficImpact,
        trafficRationale: trafficData.rationale,
        howToFix,
        priorityAction,
        responsibility,
        businessImpact,
      });
    }
  }

  // Sort by priority score descending (highest traffic impact + easiest first)
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

function enrichAudit(audit, extras) {
  if (audit.error) return audit;

  const platform = audit.detectedPlatform || 'html';
  extras = extras || {};

  const allFixes = buildTopFixes(audit, 999, platform);
  const topFixes = allFixes.slice(0, 5);

  // Revenue Opportunity Summary — aggregated from all fixes
  const totalMonthlyValue = allFixes.reduce((s, f) => s + (f.businessImpact?.monthlyValue || 0), 0);
  const totalAnnualValue = totalMonthlyValue * 12;
  const totalTrafficGain = allFixes.reduce((s, f) => s + (f.businessImpact?.trafficGain || 0), 0);
  const doFirstCount = allFixes.filter(f => f.priorityAction === 'DO FIRST').length;

  const avgScore = Math.round((audit.scores.seo + audit.scores.performance + audit.scores.accessibility) / 3);
  const speedBoost = avgScore < 60 ? '30–50%' : avgScore < 80 ? '15–30%' : '5–15%';
  const seoBoost = audit.scores.seo < 60 ? '10–25%' : audit.scores.seo < 80 ? '5–12%' : '2–5%';
  const conversionBoost = avgScore < 50 ? '8–15%' : avgScore < 70 ? '5–12%' : '2–5%';

  const revenueOpportunitySummary = {
    headline: `Estimated Impact if Fixed: +${speedBoost} faster load time, +${seoBoost} SEO visibility increase, +${conversionBoost} conversion improvement potential.`,
    totalMonthlyValue,
    totalAnnualValue,
    totalTrafficGain,
    doFirstCount,
    planCount: allFixes.filter(f => f.priorityAction === 'PLAN').length,
    niceToHaveCount: allFixes.filter(f => f.priorityAction === 'NICE TO HAVE').length,
    ignoreCount: allFixes.filter(f => f.priorityAction === 'IGNORE FOR NOW').length,
  };

  const result = {
    detectedPlatform: platform,
    scoreInterpretations: {
      overall: interpretScore('overall', audit.scores.overall),
      seo: interpretScore('seo', audit.scores.seo),
      performance: interpretScore('performance', audit.scores.performance),
      accessibility: interpretScore('accessibility', audit.scores.accessibility),
    },
    metricInterpretations: interpretMetrics(audit),
    topFixes,
    allFixes,
    revenueOpportunitySummary,
    seoIssuesClassified: classifyAllIssues(audit.seo.issues),
    perfIssuesClassified: classifyAllIssues(audit.performance.issues),
    a11yIssuesClassified: classifyAllIssues(audit.accessibility.issues),
  };

  // Attach crawl summary if provided
  if (extras.crawl) {
    result.crawlSummary = interpretCrawl(extras.crawl);
  }

  // Attach competitor summary if provided
  if (extras.competitor) {
    result.competitorSummary = extras.competitor.comparison || null;
  }

  // Attach Tier 2 summaries if provided
  if (extras.keywords) {
    result.keywordSummary = {
      totalOpportunities: extras.keywords.totalOpportunities || 0,
      strikingDistanceCount: extras.keywords.strikingDistanceCount || 0,
      quickWinCount: extras.keywords.quickWinCount || 0,
      totalEstimatedMonthlyTrafficGain: extras.keywords.totalEstimatedMonthlyTrafficGain || 0,
      topOpportunities: (extras.keywords.opportunities || []).slice(0, 5),
      dataSource: extras.keywords.dataSource || 'heuristic',
    };
  }

  if (extras.contentGaps) {
    result.contentGapSummary = {
      totalGapsFound: extras.contentGaps.totalGapsFound || 0,
      easyWins: extras.contentGaps.easyWins || 0,
      totalEstimatedMonthlyTraffic: extras.contentGaps.totalEstimatedMonthlyTraffic || 0,
      categories: extras.contentGaps.categories || {},
      topGaps: (extras.contentGaps.gaps || []).slice(0, 5),
      dataSource: extras.contentGaps.dataSource || 'heuristic',
    };
  }

  if (extras.roi) {
    result.roiSummary = extras.roi.summary || null;
    result.roiRecommendations = (extras.roi.recommendations || []).slice(0, 10);
  }

  return result;
}

function interpretCrawl(crawl) {
  const issues = [];

  if (crawl.orphanPages && crawl.orphanPages.length > 0) {
    issues.push({
      severity: 'high',
      title: `${crawl.orphanPages.length} orphan page(s) found`,
      description: 'These pages have no internal links pointing to them, making them hard for search engines to discover.',
      pages: crawl.orphanPages.map(p => p.url),
      trafficImpact: 60,
    });
  }

  if (crawl.duplicateTitles && crawl.duplicateTitles.length > 0) {
    issues.push({
      severity: 'high',
      title: `${crawl.duplicateTitles.length} duplicate title(s) found`,
      description: 'Duplicate title tags confuse search engines about which page to rank for a query.',
      items: crawl.duplicateTitles,
      trafficImpact: 50,
    });
  }

  if (crawl.duplicateDescriptions && crawl.duplicateDescriptions.length > 0) {
    issues.push({
      severity: 'medium',
      title: `${crawl.duplicateDescriptions.length} duplicate meta description(s)`,
      description: 'Duplicate descriptions reduce click-through rates from search results.',
      items: crawl.duplicateDescriptions,
      trafficImpact: 25,
    });
  }

  if (crawl.indexationIssues && crawl.indexationIssues.length > 0) {
    issues.push({
      severity: 'critical',
      title: `${crawl.indexationIssues.length} page(s) with indexation problems`,
      description: 'These pages may not appear in search results due to noindex, missing canonical, or HTTP errors.',
      items: crawl.indexationIssues,
      trafficImpact: 80,
    });
  }

  if (crawl.thinContentPages && crawl.thinContentPages.length > 0) {
    issues.push({
      severity: 'medium',
      title: `${crawl.thinContentPages.length} thin content page(s) (<300 words)`,
      description: 'Pages with very little content are less likely to rank well for competitive queries.',
      items: crawl.thinContentPages,
      trafficImpact: 35,
    });
  }

  if (crawl.missingTitles && crawl.missingTitles.length > 0) {
    issues.push({
      severity: 'high',
      title: `${crawl.missingTitles.length} page(s) missing title tags`,
      description: 'Pages without title tags lose their most important ranking signal.',
      pages: crawl.missingTitles,
      trafficImpact: 70,
    });
  }

  // Sort by traffic impact
  issues.sort((a, b) => b.trafficImpact - a.trafficImpact);

  return {
    pagesCrawled: crawl.pagesCrawled,
    totalIssues: issues.length,
    issues,
  };
}

module.exports = {
  enrichAudit,
  interpretScore,
  interpretMetrics,
  interpretCrawl,
  buildTopFixes,
  classifySeverity,
  classifyAllIssues,
  estimateTrafficImpact,
  getResponsibility,
  getPriorityAction,
  computeBusinessImpact,
  SEVERITY,
  BENCHMARKS,
};
