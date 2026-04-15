---
title: The Complete On-Page SEO Audit Checklist (2026 Edition)
slug: complete-on-page-seo-audit-checklist
date: 2026-04-18
category: guides
excerpt: A 12-point checklist covering everything from title tags to Core Web Vitals — and how to prioritize the fixes that move the needle most.
readTime: 8
---

# The Complete On-Page SEO Audit Checklist (2026 Edition)

An on-page SEO audit is a systematic review of every element on your website that search engines use to understand, rank, and surface your content. Done right, it tells you exactly what's holding your rankings back — and what to fix first.

This checklist covers 12 critical areas. Work through them in order, and you'll have a clear picture of your site's SEO health.

## What Is an On-Page SEO Audit?

On-page SEO refers to everything you control directly on your website: your content, HTML structure, technical setup, and user experience signals. An audit identifies gaps between where you are and where Google wants you to be.

It's different from off-page SEO (backlinks, brand mentions) and technical infrastructure (server speed, DNS, CDN). Those matter too — but they're separate conversations.

## The 12-Point Checklist

### 1. Title Tags

Every page should have a unique `<title>` tag between 50–60 characters. It should include your primary keyword near the front and clearly describe the page content.

**Common failures:** duplicate titles, missing titles, titles over 70 characters that get truncated in results.

### 2. Meta Descriptions

Meta descriptions don't directly affect rankings but dramatically affect click-through rate. Each page needs a unique description of 120–160 characters that includes the keyword and a clear reason to click.

**Common failures:** missing descriptions, duplicate descriptions, auto-generated gibberish.

### 3. H1 Tags

Every page should have exactly one `<h1>` that matches the topic of the page. It doesn't have to be identical to the title tag, but should include the primary keyword.

**Common failures:** missing H1, multiple H1s, H1 that doesn't match page content.

### 4. Canonical URLs

The `<link rel="canonical">` tag tells Google which version of a URL is the "real" one. This prevents duplicate content issues from parameters, trailing slashes, and HTTP vs. HTTPS versions.

**Common failures:** missing canonicals, self-referencing canonicals pointing to the wrong URL, conflicting canonicals on paginated content.

### 5. Image Alt Text

Every meaningful image should have descriptive alt text. This helps Google understand your images and is required for WCAG accessibility compliance.

**Common failures:** empty alt attributes, generic alt text like "image1.jpg", alt text stuffed with keywords.

### 6. Internal Linking

A strong internal link structure helps Google discover and understand your pages. Every important page should be reachable within 3 clicks from the homepage.

**Common failures:** orphaned pages with no internal links, broken internal links, over-reliance on navigation menus rather than contextual links.

### 7. Page Speed and Core Web Vitals

Google uses Core Web Vitals as a ranking signal. The three metrics to track:

- **LCP (Largest Contentful Paint):** Should be under 2.5 seconds
- **INP (Interaction to Next Paint):** Should be under 200ms
- **CLS (Cumulative Layout Shift):** Should be under 0.1

**Common causes of failure:** unoptimized images, render-blocking scripts, no CDN, large JavaScript bundles.

### 8. Schema Markup

Structured data (JSON-LD) helps search engines understand your content type and can unlock rich results in SERPs. At minimum, add Organization schema on your homepage and Article schema on blog posts.

**Common failures:** missing schema entirely, malformed schema, schema that doesn't match visible page content.

### 9. Mobile Usability

Google indexes the mobile version of your site first. Your pages must be fully functional and readable on mobile devices.

**Common failures:** text too small to read, clickable elements too close together, content wider than the viewport.

### 10. HTTPS

Your entire site should be served over HTTPS. Mixed content (HTTPS page loading HTTP resources) triggers browser warnings and can hurt rankings.

**Common failures:** HTTP pages still accessible, mixed content warnings, expired SSL certificate.

### 11. Crawlability

Make sure Google can access your important pages. Check your `robots.txt` to ensure you're not accidentally blocking important sections, and verify your sitemap is up to date and submitted to Google Search Console.

**Common failures:** `Disallow: /` in robots.txt, important pages blocked by noindex tags, sitemap referencing 404 pages.

### 12. Content Quality

Google increasingly rewards pages that demonstrate expertise, authority, and trustworthiness (E-E-A-T). Thin content (under ~300 words), duplicate content, and pages that don't match search intent will underperform regardless of technical optimization.

**Common failures:** pages with little original content, keyword stuffing, content that doesn't answer the user's actual question.

## How to Prioritize Fixes

Not all issues are equal. Use this rough priority order:

1. **Critical (fix immediately):** Noindex on important pages, missing title tags, broken canonical pointing to wrong URL, HTTPS issues
2. **High impact:** Core Web Vitals failures, missing meta descriptions on high-traffic pages, broken internal links
3. **Quick wins:** Adding alt text to images, fixing H1 structure, adding schema to key pages
4. **Long-term:** Content depth improvements, internal link restructuring

## How to Automate This Process

Running this checklist manually across a multi-page site takes hours. AuditBot automates the entire thing — enter your URL and get a prioritized report across all 12 areas in seconds.

The report includes specific page-level recommendations so you know exactly what to fix, not just that something is broken.

Try your first audit free — no technical setup required.
