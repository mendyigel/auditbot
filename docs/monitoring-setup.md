# AuditBot Monitoring Setup

## Health Check Endpoint

`GET /health` — returns `200 OK` with JSON status when all systems are up.

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 42,
  "timestamp": "2026-04-15T18:00:00.000Z",
  "checks": {
    "database": "ok",
    "storage": "local",
    "billing": "enabled"
  }
}
```

Returns `503` with `"status": "degraded"` when the database is unreachable.

---

## Error Tracking — Sentry

### 1. Create a Sentry project

1. Sign up at [sentry.io](https://sentry.io) (free tier is sufficient for launch).
2. Create a new project → **Node.js**.
3. Copy the **DSN** from the project settings.

### 2. Configure the app

Set the environment variable before starting AuditBot:

```bash
export SENTRY_DSN="https://your-key@oXXXXX.ingest.sentry.io/XXXXXXX"
node src/server.js
```

Or add it to your `.env` / deployment config:

```
SENTRY_DSN=https://your-key@oXXXXX.ingest.sentry.io/XXXXXXX
NODE_ENV=production
```

The `src/monitoring.js` module initialises Sentry automatically when `SENTRY_DSN` is present. When the variable is absent the server starts with error tracking disabled (safe for local dev).

### 3. Recommended alert rules (configure in Sentry UI)

| Rule | Condition | Action |
|------|-----------|--------|
| Unhandled exception | Any new issue | Email ops |
| Error rate spike | >10 events/min | Email ops |
| New error type | First occurrence of issue | Email ops |

---

## Uptime Monitoring — UptimeRobot

### 1. Sign up

Go to [uptimerobot.com](https://uptimerobot.com) — the free tier (50 monitors, 5-minute checks) is sufficient. Upgrading to the paid tier gives 1-minute checks.

### 2. Monitors to create

| Monitor | URL | Type | Interval |
|---------|-----|------|----------|
| AuditBot App | `https://your-domain.com/` | HTTP(S) | 1 min |
| API Health | `https://your-domain.com/health` | HTTP(S) | 1 min |
| Stripe Webhook | `https://your-domain.com/billing/webhook` | HTTP(S) — keyword "404" should NOT appear | 1 min |

For the health check monitor, set the **Expected HTTP status** to `200` and optionally add a **keyword check** for `"status":"ok"`.

### 3. Alert contacts

Add your ops email under **My Settings → Alert Contacts**.
Attach the alert contact to all monitors above.

---

## Checklist

- [ ] Sentry project created and `SENTRY_DSN` set in production env
- [ ] Sentry alert rules configured (see above)
- [ ] UptimeRobot account created
- [ ] Three monitors created and 1-minute interval set
- [ ] Alert email added and attached to all monitors
- [ ] `/health` endpoint verified returning `200` in production
