# AuditBot

> Automated website audits — SEO, Performance & Accessibility — with shareable HTML reports.

**$29/month · Unlimited audits · No signup required to trial**

---

## What it does

Submit any URL and receive a scored audit across three dimensions:

| Category | What's checked |
|----------|---------------|
| **SEO** | Title, meta description, canonical, H1, Open Graph, Twitter Card, JSON-LD structured data, robots meta, lang attribute, viewport |
| **Performance** | TTFB, HTML page size, render-blocking JS/CSS, image lazy-loading, gzip/brotli compression |
| **Accessibility** | Alt text on images, form labels, heading order, skip-nav link, `<main>` landmark, button accessible names |

Each category returns a 0–100 score. You also get a **shareable HTML report URL** to send to clients.

---

## Quick start

### Requirements

- Node.js 18+
- npm

### Install & run

```bash
git clone https://github.com/your-org/auditbot
cd auditbot
npm install
npm start
# → AuditBot running on http://localhost:3000
```

### Run an audit

**REST API (JSON)**

```bash
curl -X POST http://localhost:3000/audit \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com"}'
```

**Browser-friendly GET (HTML report)**

```
http://localhost:3000/audit?url=https://example.com
```

**Request HTML directly**

```bash
curl -X POST http://localhost:3000/audit \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com", "format": "html"}' \
  -o report.html
```

---

## API reference

### `POST /audit`

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | ✅ | Target URL to audit. `https://` prefix is added automatically if missing. |
| `format` | `"json"` \| `"html"` | — | Default: `json`. Use `html` to receive the report directly. |

**Response (JSON)**

```jsonc
{
  "url": "https://example.com",
  "auditedAt": "2026-04-15T12:00:00.000Z",
  "statusCode": 200,
  "ttfbMs": 210,
  "pageSizeKb": 14.3,
  "reportUrl": "/report/3f8a1c4d-...",   // shareable HTML report
  "scores": {
    "overall": 72,
    "seo": 80,
    "performance": 67,
    "accessibility": 71
  },
  "seo": { ... },
  "performance": { ... },
  "accessibility": { ... }
}
```

### `GET /report/:id`

Returns a cached HTML report (expires after 1 hour).

### `GET /audit?url=:url`

Convenience endpoint — returns the HTML report directly. Ideal for bookmarking or sharing.

### `GET /health`

Returns `{ status: "ok", uptime, timestamp }`.

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3000`  | HTTP port to listen on |

---

## Deployment

### Docker (recommended)

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "src/server.js"]
```

```bash
docker build -t auditbot .
docker run -p 3000:3000 auditbot
```

### Railway / Render / Fly.io

1. Connect your repo.
2. Set `PORT` if needed (most platforms inject it automatically).
3. Build command: `npm install`
4. Start command: `npm start`

### Reverse proxy (nginx)

```nginx
location / {
  proxy_pass http://localhost:3000;
  proxy_set_header Host $host;
}
```

---

## Roadmap (iteration #1 suggestions)

1. **PDF export** — generate a client-ready PDF report alongside the HTML
2. **Scheduled monitoring** — re-audit on a cron and email diffs when scores drop
3. **Lighthouse integration** — add real Core Web Vitals (LCP, CLS, FID) via headless Chrome
4. **Multi-page crawl** — follow internal links up to N pages
5. **API key auth + billing** — Stripe integration for $29/month subscriptions

---

## Known limitations (MVP)

- No JavaScript rendering — audits the raw HTML response (pre-JS). SPAs may score lower on SEO.
- Performance metrics are HTTP-level only (TTFB, page size, headers); no Core Web Vitals.
- Accessibility checks are heuristic (DOM-based); no colour-contrast analysis.
- Reports are in-memory only and expire after 1 hour. A persistent store (S3/DB) is needed for production.

---

## License

MIT
