'use strict';

const fs = require('fs');
const path = require('path');
const { consentBannerSnippet } = require('./consent-banner');
const { appPageAnalyticsSnippet } = require('./analytics');

const POSTS_DIR = path.join(__dirname, 'blog', 'posts');

// ── Frontmatter parser ────────────────────────────────────────────────────────

function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    meta[key] = val;
  }
  return { meta, body: match[2] };
}

// ── Simple Markdown → HTML renderer ──────────────────────────────────────────
// Handles: headings, bold, italic, inline code, code fences, unordered &
// ordered lists, links, horizontal rules, and paragraphs.

function mdToHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;
  let inList = null; // 'ul' | 'ol' | null
  let inCodeFence = false;
  let codeFenceLines = [];

  function closeList() {
    if (inList) {
      out.push(`</${inList}>`);
      inList = null;
    }
  }

  function closeCodeFence() {
    const escaped = codeFenceLines.join('\n')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    out.push(`<pre><code>${escaped}</code></pre>`);
    codeFenceLines = [];
    inCodeFence = false;
  }

  function inlineFormat(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  }

  while (i < lines.length) {
    const line = lines[i];

    // Code fence open/close
    if (line.startsWith('```')) {
      if (inCodeFence) {
        closeCodeFence();
      } else {
        closeList();
        inCodeFence = true;
      }
      i++;
      continue;
    }

    if (inCodeFence) {
      codeFenceLines.push(line);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      closeList();
      out.push('<hr>');
      i++;
      continue;
    }

    // Headings
    const hMatch = line.match(/^(#{1,4})\s+(.*)/);
    if (hMatch) {
      closeList();
      const level = hMatch[1].length;
      out.push(`<h${level}>${inlineFormat(hMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    // Unordered list item
    const ulMatch = line.match(/^[-*+]\s+(.*)/);
    if (ulMatch) {
      if (inList === 'ol') closeList();
      if (!inList) { out.push('<ul>'); inList = 'ul'; }
      out.push(`<li>${inlineFormat(ulMatch[1])}</li>`);
      i++;
      continue;
    }

    // Ordered list item
    const olMatch = line.match(/^\d+\.\s+(.*)/);
    if (olMatch) {
      if (inList === 'ul') closeList();
      if (!inList) { out.push('<ol>'); inList = 'ol'; }
      out.push(`<li>${inlineFormat(olMatch[1])}</li>`);
      i++;
      continue;
    }

    // Blank line — close list or paragraph break
    if (line.trim() === '') {
      closeList();
      out.push('');
      i++;
      continue;
    }

    // Paragraph — collect consecutive non-blank, non-special lines
    closeList();
    const paraLines = [];
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].match(/^(#{1,4}\s|[-*+]\s|\d+\.\s|```|---)/)) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) {
      out.push(`<p>${inlineFormat(paraLines.join(' '))}</p>`);
    }
  }

  if (inCodeFence) closeCodeFence();
  closeList();

  return out.join('\n');
}

// ── Post loader ───────────────────────────────────────────────────────────────

function loadPosts() {
  if (!fs.existsSync(POSTS_DIR)) return [];
  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.md'));
  const posts = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(POSTS_DIR, file), 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      posts.push({
        title: meta.title || file.replace('.md', ''),
        slug: meta.slug || file.replace('.md', ''),
        date: meta.date || '2026-01-01',
        category: meta.category || 'general',
        excerpt: meta.excerpt || '',
        readTime: parseInt(meta.readTime, 10) || 5,
        body,
      });
    } catch (_) { /* skip unreadable files */ }
  }
  // Sort newest first
  posts.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));
  return posts;
}

// ── Shared HTML shell ─────────────────────────────────────────────────────────

function blogShell({ title, description, ogTitle, ogDescription, children, analytics }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="${escapeAttr(description)}" />
  <meta property="og:title" content="${escapeAttr(ogTitle || title)}" />
  <meta property="og:description" content="${escapeAttr(ogDescription || description)}" />
  <meta property="og:type" content="website" />
  <title>${escapeAttr(title)} — OrbioLabs Blog</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --brand: #3b82f6;
      --brand-dark: #2563eb;
      --bg: #0f172a;
      --surface: #1e293b;
      --border: #334155;
      --text: #f1f5f9;
      --muted: #94a3b8;
    }
    html { scroll-behavior: smooth; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.7;
    }
    a { color: var(--brand); text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* Nav */
    nav {
      display: flex; align-items: center; justify-content: space-between;
      padding: 20px 40px; border-bottom: 1px solid var(--border);
      position: sticky; top: 0; background: var(--bg); z-index: 100;
    }
    .logo { font-size: 1.25rem; font-weight: 800; letter-spacing: -0.5px; color: var(--text); }
    .logo span { color: var(--brand); }
    nav .nav-links { display: flex; align-items: center; gap: 24px; }
    nav .nav-link { color: var(--muted); font-size: 0.875rem; }
    nav .nav-link:hover { color: var(--text); text-decoration: none; }
    nav .cta-nav {
      background: var(--brand); color: #fff; padding: 8px 20px;
      border-radius: 6px; font-weight: 600; font-size: 0.875rem;
      transition: background 0.15s;
    }
    nav .cta-nav:hover { background: var(--brand-dark); text-decoration: none; }

    /* Layout */
    .container { max-width: 760px; margin: 0 auto; padding: 0 24px; }

    /* Blog index */
    .blog-header { padding: 64px 0 48px; }
    .blog-header h1 { font-size: clamp(1.8rem, 4vw, 2.8rem); font-weight: 800; letter-spacing: -0.5px; margin-bottom: 12px; }
    .blog-header p { color: var(--muted); font-size: 1.1rem; }

    .post-list { display: flex; flex-direction: column; gap: 2px; padding-bottom: 80px; }
    .post-card {
      display: block; padding: 28px; border-radius: 10px;
      border: 1px solid var(--border); background: var(--surface);
      transition: border-color 0.15s;
    }
    .post-card:hover { border-color: var(--brand); text-decoration: none; }
    .post-card + .post-card { margin-top: 16px; }
    .post-meta { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
    .post-category {
      font-size: 0.75rem; font-weight: 700; letter-spacing: 0.5px;
      text-transform: uppercase; color: var(--brand);
      background: rgba(59,130,246,0.1); border: 1px solid rgba(59,130,246,0.2);
      padding: 2px 10px; border-radius: 99px;
    }
    .post-date { font-size: 0.8rem; color: var(--muted); }
    .post-read-time { font-size: 0.8rem; color: var(--muted); }
    .post-card h2 { font-size: 1.2rem; font-weight: 700; color: var(--text); margin-bottom: 8px; line-height: 1.4; }
    .post-card p { font-size: 0.9rem; color: var(--muted); line-height: 1.6; }

    /* Blog post */
    .post-header { padding: 64px 0 40px; border-bottom: 1px solid var(--border); margin-bottom: 48px; }
    .post-header .post-meta { margin-bottom: 16px; }
    .post-header h1 { font-size: clamp(1.6rem, 4vw, 2.4rem); font-weight: 800; letter-spacing: -0.5px; line-height: 1.25; margin-bottom: 16px; }
    .post-header .post-excerpt { font-size: 1.1rem; color: var(--muted); line-height: 1.6; }

    /* Post content */
    .post-content { padding-bottom: 80px; }
    .post-content h1,
    .post-content h2 { font-size: 1.4rem; font-weight: 700; margin: 40px 0 16px; }
    .post-content h3 { font-size: 1.1rem; font-weight: 700; margin: 32px 0 12px; color: var(--text); }
    .post-content h4 { font-size: 1rem; font-weight: 700; margin: 24px 0 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
    .post-content p { margin-bottom: 20px; color: #cbd5e1; }
    .post-content ul, .post-content ol { margin: 0 0 20px 24px; color: #cbd5e1; }
    .post-content li { margin-bottom: 8px; }
    .post-content strong { color: var(--text); font-weight: 600; }
    .post-content em { color: var(--text); }
    .post-content code {
      background: rgba(255,255,255,0.08); padding: 2px 6px;
      border-radius: 4px; font-size: 0.875em; font-family: 'SF Mono', 'Fira Code', monospace;
    }
    .post-content pre {
      background: #0a0f1e; border: 1px solid var(--border);
      border-radius: 8px; padding: 20px; margin: 24px 0;
      overflow-x: auto;
    }
    .post-content pre code { background: none; padding: 0; font-size: 0.85rem; }
    .post-content hr { border: none; border-top: 1px solid var(--border); margin: 40px 0; }
    .post-content a { color: var(--brand); }

    /* CTA box */
    .post-cta {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 12px; padding: 32px; margin: 48px 0 64px;
      text-align: center;
    }
    .post-cta h3 { font-size: 1.2rem; font-weight: 700; margin-bottom: 8px; }
    .post-cta p { color: var(--muted); margin-bottom: 20px; font-size: 0.95rem; }
    .btn-primary {
      display: inline-block; background: var(--brand); color: #fff;
      padding: 10px 28px; border-radius: 8px; font-weight: 600;
      font-size: 0.95rem; transition: background 0.15s;
    }
    .btn-primary:hover { background: var(--brand-dark); text-decoration: none; }

    /* Breadcrumb */
    .breadcrumb { padding: 20px 0 0; font-size: 0.85rem; color: var(--muted); }
    .breadcrumb a { color: var(--muted); }
    .breadcrumb a:hover { color: var(--text); }
    .breadcrumb span { margin: 0 8px; }

    /* Footer */
    footer {
      border-top: 1px solid var(--border); padding: 32px 40px;
      color: var(--muted); font-size: 0.85rem;
      display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;
    }
    footer a { color: var(--muted); }
    footer a:hover { color: var(--text); }

    @media (max-width: 600px) {
      nav { padding: 16px 20px; }
      .container { padding: 0 16px; }
      footer { padding: 24px 20px; flex-direction: column; align-items: flex-start; }
    }
  </style>
</head>
<body>
  <nav>
    <a href="/" class="logo">Orbio<span>Labs</span></a>
    <div class="nav-links">
      <a href="/blog" class="nav-link">Blog</a>
      <a href="/billing/trial" class="cta-nav">Start Free Trial</a>
    </div>
  </nav>
  ${children}
  <footer>
    <div>&copy; ${new Date().getFullYear()} OrbioLabs. All rights reserved.</div>
    <div style="display:flex;gap:20px">
      <a href="/">Home</a>
      <a href="/blog">Blog</a>
      <a href="/api">API Docs</a>
    </div>
  </footer>
  ${analytics}
  ${consentBannerSnippet()}
</body>
</html>`;
}

function escapeAttr(s) {
  return String(s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatDate(dateStr) {
  try {
    return new Date(dateStr).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch (_) {
    return dateStr;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Returns the full HTML for GET /blog (index page listing all posts).
 */
function generateBlogIndex() {
  const posts = loadPosts();

  const cards = posts.length === 0
    ? '<p style="color:var(--muted);padding:40px 0">No posts yet — check back soon.</p>'
    : posts.map(post => `
      <a href="/blog/${escapeAttr(post.slug)}" class="post-card">
        <div class="post-meta">
          <span class="post-category">${escapeAttr(post.category)}</span>
          <span class="post-date">${formatDate(post.date)}</span>
          <span class="post-read-time">${post.readTime} min read</span>
        </div>
        <h2>${escapeAttr(post.title)}</h2>
        <p>${escapeAttr(post.excerpt)}</p>
      </a>`).join('\n');

  return blogShell({
    title: 'Blog',
    description: 'Guides, checklists, and insights on SEO, web performance, and accessibility from the OrbioLabs team.',
    children: `
      <div class="container">
        <div class="blog-header">
          <h1>OrbioLabs Blog</h1>
          <p>Guides, checklists, and insights on SEO, performance, and accessibility.</p>
        </div>
        <div class="post-list">${cards}</div>
      </div>`,
    analytics: appPageAnalyticsSnippet('blog'),
  });
}

/**
 * Returns the full HTML for GET /blog/:slug, or null if the post doesn't exist.
 */
function generateBlogPost(slug) {
  const posts = loadPosts();
  const post = posts.find(p => p.slug === slug);
  if (!post) return null;

  const contentHtml = mdToHtml(post.body);

  return blogShell({
    title: post.title,
    description: post.excerpt,
    ogTitle: post.title,
    ogDescription: post.excerpt,
    children: `
      <div class="container">
        <div class="breadcrumb">
          <a href="/">Home</a><span>/</span>
          <a href="/blog">Blog</a><span>/</span>
          <span>${escapeAttr(post.title)}</span>
        </div>
        <div class="post-header">
          <div class="post-meta">
            <span class="post-category">${escapeAttr(post.category)}</span>
            <span class="post-date">${formatDate(post.date)}</span>
            <span class="post-read-time">${post.readTime} min read</span>
          </div>
          <h1>${escapeAttr(post.title)}</h1>
          <p class="post-excerpt">${escapeAttr(post.excerpt)}</p>
        </div>
        <div class="post-content">${contentHtml}</div>
        <div class="post-cta">
          <h3>Ready to audit your website?</h3>
          <p>Get a complete SEO, performance, and accessibility report in seconds. Start your 14-day free trial — no charge until your trial ends.</p>
          <a href="/billing/trial" class="btn-primary">Start Free Trial</a>
        </div>
      </div>`,
    analytics: appPageAnalyticsSnippet(`blog/${slug}`),
  });
}

module.exports = { generateBlogIndex, generateBlogPost };
