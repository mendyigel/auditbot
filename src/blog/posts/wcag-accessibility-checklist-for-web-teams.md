---
title: WCAG 2.1 Accessibility Checklist for Web Teams
slug: wcag-accessibility-checklist-for-web-teams
date: 2026-04-29
category: guides
excerpt: WCAG 2.1 AA requirements in plain English, the top 10 accessibility failures found on real websites, and what automated tools can and can't catch.
readTime: 7
---

# WCAG 2.1 Accessibility Checklist for Web Teams

Over 1 billion people worldwide live with some form of disability. If your website isn't accessible, you're excluding a significant portion of your potential audience — and in many jurisdictions, you may be violating the law.

The Web Content Accessibility Guidelines (WCAG) 2.1 is the international standard for web accessibility. Here's what you need to know, without the standards committee jargon.

## Why Web Accessibility Matters

### The Legal Risk

The number of web accessibility lawsuits has grown every year since 2018. In the US, the ADA (Americans with Disabilities Act) has been interpreted to apply to websites. The EU Web Accessibility Directive mandates WCAG 2.1 AA compliance for public sector websites, and the European Accessibility Act extends this to many private sector businesses from 2025.

Accessibility lawsuits are expensive — settlements often run $20,000–$100,000, and the reputational damage can last years.

### The Business Case

Accessible websites perform better for everyone, not just users with disabilities:

- High-contrast text is easier to read in bright sunlight
- Keyboard navigation helps power users
- Clear link text helps users who skim
- Captions help users in noisy environments

Accessibility improvements frequently lift conversion rates and reduce bounce rates across all users.

## WCAG 2.1 AA: The Core Requirements

WCAG organizes requirements into four principles, abbreviated POUR:

**Perceivable** — Information must be presentable in ways users can perceive. If something is only communicated through color, a color-blind user will miss it. If there's no alt text, a screen reader user won't know what the image shows.

**Operable** — Users must be able to operate the interface. Everything interactive must be keyboard-navigable. Moving content must be pausable. Users must have enough time to read and respond.

**Understandable** — The interface must be understandable. Page language must be declared in HTML. Error messages must clearly explain what went wrong. Navigation must be consistent.

**Robust** — Content must work with current and future assistive technologies. HTML must be valid and semantically correct. ARIA labels must be used correctly.

## Top 10 Accessibility Failures on Real Websites

Based on the WebAIM Million annual study and AuditBot's own scan data, these are the most common failures:

### 1. Low Color Contrast

Text must have a contrast ratio of at least 4.5:1 against its background (3:1 for large text). Light gray text on white backgrounds is a near-universal failure.

### 2. Missing Image Alt Text

Images without alt attributes are invisible to screen readers. Decorative images should have `alt=""`. Meaningful images must describe their content.

### 3. Missing Form Labels

Every form input must have an associated `<label>` element. Placeholder text doesn't count — it disappears when the user starts typing.

### 4. Empty Links and Buttons

Links that say "click here" or "read more" and buttons with only an icon — no text — are inaccessible to screen reader users who navigate by links.

### 5. Missing Document Language

The `lang` attribute on the `<html>` element tells screen readers what language to use for pronunciation. Missing it causes screen readers to guess, often incorrectly.

### 6. Missing Skip Navigation Link

Users who navigate by keyboard must tab through every nav item on every page to reach the main content. A "skip to main content" link at the top of the page solves this.

### 7. Keyboard Traps

Modal dialogs, dropdown menus, and custom widgets must be keyboard-escapable. Users should always be able to close something with the Escape key and return focus to where they were.

### 8. Auto-Playing Media

Videos or audio that play automatically are disorienting for screen reader users (the media competes with the reader's voice) and annoying for everyone else.

### 9. Insufficient Focus Indicators

When users navigate with a keyboard, they need a visible indicator of which element is focused. The default browser outline is often removed by CSS (`outline: none`), leaving keyboard users with no visual cue.

### 10. Inaccessible PDFs

PDFs are frequently used for reports, menus, and documentation but are rarely made accessible. Tagged PDFs with reading order defined are required for screen reader compatibility.

## What Automated Tools Can and Can't Catch

Automated accessibility scanners like AuditBot can reliably detect:

- Images without alt attributes
- Color contrast failures
- Missing form labels
- Missing document language
- Empty links and buttons
- Basic ARIA errors

Automation typically catches **30–40% of WCAG failures**. The rest require manual testing:

- Does the tab order make logical sense?
- Are error messages actually helpful?
- Does the page work with a real screen reader (NVDA, VoiceOver, JAWS)?
- Is the content understandable to users with cognitive disabilities?

**The right approach:** use automated scanning to catch the easy stuff at scale, then do manual testing for your most important pages and user flows.

## Run a Free Accessibility Check

AuditBot runs automated WCAG 2.1 AA checks on any URL in seconds. You'll get a list of failures, their severity, and specific recommendations for each page element that needs fixing.

It won't catch everything — no automated tool will — but it's the fastest way to identify the most common issues and build your remediation backlog.

Try your first audit free and see where your site stands.
