'use strict';

/**
 * PostgreSQL persistence layer for AuditBot.
 *
 * Migrated from SQLite (better-sqlite3) to PostgreSQL (pg) for reliable
 * persistence across Render deploys.
 *
 * Connection: $DATABASE_URL (Render auto-injects for managed PG).
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

// ── Schema bootstrap ────────────────────────────────────────────────────────

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS reports (
        id          TEXT PRIMARY KEY,
        url         TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        audit_json  TEXT NOT NULL,
        created_at  BIGINT NOT NULL,
        user_id     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at);
      CREATE INDEX IF NOT EXISTS idx_reports_user ON reports(user_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        api_key             TEXT PRIMARY KEY,
        email               TEXT NOT NULL,
        customer_id         TEXT NOT NULL UNIQUE,
        subscription_id     TEXT,
        status              TEXT NOT NULL DEFAULT 'incomplete',
        created_at          BIGINT NOT NULL,
        audit_count         INTEGER NOT NULL DEFAULT 0,
        emails_sent         TEXT NOT NULL DEFAULT '{}',
        pdf_count           INTEGER NOT NULL DEFAULT 0,
        plan_tier           TEXT NOT NULL DEFAULT 'pro',
        monthly_audit_count INTEGER NOT NULL DEFAULT 0,
        monthly_reset_at    BIGINT NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_subs_customer ON subscriptions(customer_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS waitlist (
        email      TEXT PRIMARY KEY,
        created_at BIGINT NOT NULL
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id                  TEXT PRIMARY KEY,
        username            TEXT NOT NULL UNIQUE,
        password_hash       TEXT NOT NULL,
        email               TEXT,
        api_key             TEXT REFERENCES subscriptions(api_key),
        session_token       TEXT UNIQUE,
        created_at          BIGINT NOT NULL,
        reset_token         TEXT,
        reset_token_expires BIGINT,
        is_admin            INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_users_username ON users(LOWER(username));
      CREATE INDEX IF NOT EXISTS idx_users_session ON users(session_token);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS monitored_sites (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL,
        url             TEXT NOT NULL,
        frequency       TEXT NOT NULL DEFAULT 'weekly',
        next_run_at     BIGINT NOT NULL,
        last_run_at     BIGINT,
        competitor_urls TEXT NOT NULL DEFAULT '[]',
        notify_on       TEXT NOT NULL DEFAULT '{"score_drop":true,"new_issues":true,"competitor_change":true}',
        enabled         INTEGER NOT NULL DEFAULT 1,
        created_at      BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_monitored_user ON monitored_sites(user_id, enabled);
      CREATE INDEX IF NOT EXISTS idx_monitored_next_run ON monitored_sites(next_run_at, enabled);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_snapshots (
        id                  TEXT PRIMARY KEY,
        monitored_site_id   TEXT NOT NULL,
        report_id           TEXT,
        seo_score           INTEGER NOT NULL DEFAULT 0,
        performance_score   INTEGER NOT NULL DEFAULT 0,
        accessibility_score INTEGER NOT NULL DEFAULT 0,
        overall_score       INTEGER NOT NULL DEFAULT 0,
        issues_json         TEXT NOT NULL DEFAULT '[]',
        competitor_scores   TEXT NOT NULL DEFAULT '{}',
        created_at          BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_site_created ON audit_snapshots(monitored_site_id, created_at);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS roadmaps (
        id                TEXT PRIMARY KEY,
        user_id           TEXT NOT NULL,
        monitored_site_id TEXT,
        snapshot_id       TEXT,
        roadmap_json      TEXT NOT NULL DEFAULT '{}',
        roadmap_html      TEXT NOT NULL DEFAULT '',
        vertical          TEXT,
        created_at        BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_roadmaps_user ON roadmaps(user_id);
      CREATE INDEX IF NOT EXISTS idx_roadmaps_site ON roadmaps(monitored_site_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS support_tickets (
        id             TEXT PRIMARY KEY,
        ticket_number  TEXT NOT NULL UNIQUE,
        email          TEXT NOT NULL,
        user_id        TEXT,
        category       TEXT NOT NULL DEFAULT 'other',
        subject        TEXT NOT NULL,
        description    TEXT NOT NULL,
        priority       TEXT NOT NULL DEFAULT 'medium',
        status         TEXT NOT NULL DEFAULT 'new',
        assignee       TEXT,
        internal_notes TEXT NOT NULL DEFAULT '[]',
        status_history TEXT NOT NULL DEFAULT '[]',
        created_at     BIGINT NOT NULL,
        updated_at     BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);
      CREATE INDEX IF NOT EXISTS idx_support_tickets_email ON support_tickets(email);
      CREATE INDEX IF NOT EXISTS idx_support_tickets_created ON support_tickets(created_at);
      CREATE INDEX IF NOT EXISTS idx_support_tickets_number ON support_tickets(ticket_number);
    `);

    await client.query('COMMIT');
    console.log('[DB] PostgreSQL schema ready');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DB] Migration failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

// ── Reports API ─────────────────────────────────────────────────────────────

async function saveReportMeta({ id, url, storageKey, audit, userId = null }) {
  await pool.query(
    `INSERT INTO reports (id, url, storage_key, audit_json, created_at, user_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, url, storageKey, JSON.stringify(audit), Date.now(), userId]
  );
}

async function getReportsByUser(userId) {
  const { rows } = await pool.query(
    `SELECT id, url, created_at FROM reports WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [userId]
  );
  return rows.map(row => ({ id: row.id, url: row.url, createdAt: Number(row.created_at) }));
}

async function getReportMeta(id) {
  const { rows } = await pool.query(`SELECT * FROM reports WHERE id = $1`, [id]);
  if (!rows[0]) return null;
  const row = rows[0];
  return {
    id: row.id,
    url: row.url,
    storageKey: row.storage_key,
    audit: JSON.parse(row.audit_json),
    createdAt: Number(row.created_at),
  };
}

async function deleteReportMeta(id) {
  await pool.query(`DELETE FROM reports WHERE id = $1`, [id]);
}

async function pruneOldReports(maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  await pool.query(`DELETE FROM reports WHERE created_at < $1`, [cutoff]);
}

// ── Waitlist API ────────────────────────────────────────────────────────────

async function saveWaitlistEmail(email) {
  await pool.query(
    `INSERT INTO waitlist (email, created_at) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING`,
    [email, Date.now()]
  );
}

// ── Subscriptions API ───────────────────────────────────────────────────────

async function upsertSubscription({ apiKey, email, customerId, subscriptionId = null, status = 'incomplete' }) {
  await pool.query(`
    INSERT INTO subscriptions (api_key, email, customer_id, subscription_id, status, created_at)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (customer_id) DO UPDATE SET
      email           = EXCLUDED.email,
      subscription_id = COALESCE(EXCLUDED.subscription_id, subscriptions.subscription_id),
      status          = EXCLUDED.status
  `, [apiKey, email, customerId, subscriptionId, status, Date.now()]);
}

async function getSubscriptionByApiKey(apiKey) {
  const { rows } = await pool.query(`SELECT * FROM subscriptions WHERE api_key = $1`, [apiKey]);
  return rows[0] ? rowToSub(rows[0]) : null;
}

async function getSubscriptionByCustomerId(customerId) {
  const { rows } = await pool.query(`SELECT * FROM subscriptions WHERE customer_id = $1`, [customerId]);
  return rows[0] ? rowToSub(rows[0]) : null;
}

async function updateSubscriptionStatus({ customerId, status, subscriptionId = null }) {
  await pool.query(
    `UPDATE subscriptions SET status = $1, subscription_id = COALESCE($2, subscription_id)
     WHERE customer_id = $3`,
    [status, subscriptionId, customerId]
  );
}

function rowToSub(row) {
  return {
    apiKey:            row.api_key,
    email:             row.email,
    customerId:        row.customer_id,
    subscriptionId:    row.subscription_id,
    status:            row.status,
    createdAt:         Number(row.created_at),
    auditCount:        row.audit_count || 0,
    pdfCount:          row.pdf_count || 0,
    emailsSent:        JSON.parse(row.emails_sent || '{}'),
    planTier:          row.plan_tier || 'pro',
    monthlyAuditCount: row.monthly_audit_count || 0,
    monthlyResetAt:    Number(row.monthly_reset_at) || 0,
  };
}

async function incrementAuditCount(apiKey) {
  await pool.query(`UPDATE subscriptions SET audit_count = audit_count + 1 WHERE api_key = $1`, [apiKey]);
}

async function incrementPdfCount(apiKey) {
  await pool.query(`UPDATE subscriptions SET pdf_count = pdf_count + 1 WHERE api_key = $1`, [apiKey]);
}

async function getSubscriptionsForTrialEmails(beforeMs) {
  const { rows } = await pool.query(
    `SELECT * FROM subscriptions WHERE status IN ('active', 'trialing', 'incomplete') AND created_at < $1`,
    [beforeMs]
  );
  return rows.map(rowToSub);
}

async function markEmailSent(apiKey, emailKey) {
  const { rows } = await pool.query(`SELECT emails_sent FROM subscriptions WHERE api_key = $1`, [apiKey]);
  if (!rows[0]) return;
  const flags = JSON.parse(rows[0].emails_sent || '{}');
  flags[emailKey] = Date.now();
  await pool.query(`UPDATE subscriptions SET emails_sent = $1 WHERE api_key = $2`, [JSON.stringify(flags), apiKey]);
}

async function updatePlanTier(customerId, tier) {
  await pool.query(`UPDATE subscriptions SET plan_tier = $1 WHERE customer_id = $2`, [tier, customerId]);
}

async function incrementMonthlyAuditCount(apiKey) {
  const { rows } = await pool.query(`SELECT monthly_reset_at FROM subscriptions WHERE api_key = $1`, [apiKey]);
  if (!rows[0]) return;
  const now = Date.now();
  const resetAt = Number(rows[0].monthly_reset_at) || 0;
  if (now - resetAt > 30 * 24 * 60 * 60 * 1000) {
    await pool.query(`UPDATE subscriptions SET monthly_audit_count = 0, monthly_reset_at = $1 WHERE api_key = $2`, [now, apiKey]);
  }
  await pool.query(`UPDATE subscriptions SET monthly_audit_count = monthly_audit_count + 1 WHERE api_key = $1`, [apiKey]);
}

async function getMonthlyAuditCount(apiKey) {
  const { rows } = await pool.query(`SELECT monthly_audit_count, monthly_reset_at FROM subscriptions WHERE api_key = $1`, [apiKey]);
  if (!rows[0]) return 0;
  const now = Date.now();
  const resetAt = Number(rows[0].monthly_reset_at) || 0;
  if (now - resetAt > 30 * 24 * 60 * 60 * 1000) {
    await pool.query(`UPDATE subscriptions SET monthly_audit_count = 0, monthly_reset_at = $1 WHERE api_key = $2`, [now, apiKey]);
    return 0;
  }
  return rows[0].monthly_audit_count || 0;
}

// ── Users API ───────────────────────────────────────────────────────────────

async function createUser({ id, username, passwordHash, email = null, apiKey = null, sessionToken = null }) {
  await pool.query(
    `INSERT INTO users (id, username, password_hash, email, api_key, session_token, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, username, passwordHash, email, apiKey, sessionToken, Date.now()]
  );
}

async function getUserById(id) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function getUserByUsername(username) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE LOWER(username) = LOWER($1)`, [username]);
  return rows[0] || null;
}

async function getUserBySessionToken(token) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE session_token = $1`, [token]);
  return rows[0] || null;
}

async function updateUserSession(userId, sessionToken) {
  await pool.query(`UPDATE users SET session_token = $1 WHERE id = $2`, [sessionToken, userId]);
}

async function linkUserApiKey(userId, apiKey) {
  await pool.query(`UPDATE users SET api_key = $1 WHERE id = $2`, [apiKey, userId]);
}

async function getUserByEmail(email) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE LOWER(email) = LOWER($1)`, [email]);
  return rows[0] || null;
}

async function setResetToken(userId, token, expiresAt) {
  await pool.query(`UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3`, [token, expiresAt, userId]);
}

async function getUserByResetToken(token) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE reset_token = $1`, [token]);
  const user = rows[0];
  if (!user) return null;
  if (user.reset_token_expires && Date.now() > Number(user.reset_token_expires)) return null;
  return user;
}

async function updatePassword(userId, passwordHash) {
  await pool.query(
    `UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2`,
    [passwordHash, userId]
  );
}

// ── Monitored Sites API ─────────────────────────────────────────────────────

const FREQUENCY_MS = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  biweekly: 14 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

async function createMonitoredSite({ id, userId, url, frequency = 'weekly', competitorUrls = [], notifyOn = null }) {
  const now = Date.now();
  await pool.query(
    `INSERT INTO monitored_sites (id, user_id, url, frequency, next_run_at, competitor_urls, notify_on, enabled, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8)`,
    [id, userId, url, frequency, now, JSON.stringify(competitorUrls.slice(0, 3)),
     JSON.stringify(notifyOn || { score_drop: true, new_issues: true, competitor_change: true }), now]
  );
}

async function getMonitoredSite(id) {
  const { rows } = await pool.query(`SELECT * FROM monitored_sites WHERE id = $1`, [id]);
  return rows[0] ? rowToMonitoredSite(rows[0]) : null;
}

async function getMonitoredSitesByUser(userId) {
  const { rows } = await pool.query(`SELECT * FROM monitored_sites WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return rows.map(rowToMonitoredSite);
}

async function updateMonitoredSite(id, { frequency, competitorUrls, notifyOn, enabled }) {
  const { rows } = await pool.query(`SELECT * FROM monitored_sites WHERE id = $1`, [id]);
  const existing = rows[0];
  if (!existing) return null;
  const freq = frequency || existing.frequency;
  const nextRun = frequency && frequency !== existing.frequency
    ? Date.now() + (FREQUENCY_MS[freq] || FREQUENCY_MS.weekly)
    : Number(existing.next_run_at);
  await pool.query(
    `UPDATE monitored_sites SET frequency = $1, competitor_urls = $2, notify_on = $3, enabled = $4, next_run_at = $5 WHERE id = $6`,
    [freq,
     competitorUrls !== undefined ? JSON.stringify((competitorUrls || []).slice(0, 3)) : existing.competitor_urls,
     notifyOn !== undefined ? JSON.stringify(notifyOn) : existing.notify_on,
     enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
     nextRun, id]
  );
  return getMonitoredSite(id);
}

async function deleteMonitoredSite(id) {
  await pool.query(`DELETE FROM monitored_sites WHERE id = $1`, [id]);
}

async function getDueSites(limit = 10) {
  const { rows } = await pool.query(
    `SELECT * FROM monitored_sites WHERE enabled = 1 AND next_run_at <= $1 ORDER BY next_run_at ASC LIMIT $2`,
    [Date.now(), limit]
  );
  return rows.map(rowToMonitoredSite);
}

async function updateSiteNextRun(id, frequency) {
  const intervalMs = FREQUENCY_MS[frequency] || FREQUENCY_MS.weekly;
  const now = Date.now();
  await pool.query(`UPDATE monitored_sites SET next_run_at = $1, last_run_at = $2 WHERE id = $3`, [now + intervalMs, now, id]);
}

async function countUserMonitoredSites(userId) {
  const { rows } = await pool.query(`SELECT COUNT(*) as cnt FROM monitored_sites WHERE user_id = $1 AND enabled = 1`, [userId]);
  return parseInt(rows[0].cnt, 10);
}

function rowToMonitoredSite(row) {
  return {
    id: row.id,
    userId: row.user_id,
    url: row.url,
    frequency: row.frequency,
    nextRunAt: Number(row.next_run_at),
    lastRunAt: row.last_run_at ? Number(row.last_run_at) : null,
    competitorUrls: JSON.parse(row.competitor_urls || '[]'),
    notifyOn: JSON.parse(row.notify_on || '{}'),
    enabled: !!row.enabled,
    createdAt: Number(row.created_at),
  };
}

// ── Audit Snapshots API ─────────────────────────────────────────────────────

async function saveSnapshot({ id, monitoredSiteId, reportId, seoScore, performanceScore, accessibilityScore, overallScore, issues, competitorScores }) {
  await pool.query(
    `INSERT INTO audit_snapshots (id, monitored_site_id, report_id, seo_score, performance_score, accessibility_score, overall_score, issues_json, competitor_scores, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, monitoredSiteId, reportId || null, seoScore, performanceScore, accessibilityScore, overallScore,
     JSON.stringify(issues || []), JSON.stringify(competitorScores || {}), Date.now()]
  );
}

async function getSnapshot(id) {
  const { rows } = await pool.query(`SELECT * FROM audit_snapshots WHERE id = $1`, [id]);
  return rows[0] ? rowToSnapshot(rows[0]) : null;
}

async function getSnapshotsBySite(siteId, limit = 20) {
  const { rows } = await pool.query(
    `SELECT * FROM audit_snapshots WHERE monitored_site_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [siteId, limit]
  );
  return rows.map(rowToSnapshot);
}

async function getLatestSnapshot(siteId) {
  const { rows } = await pool.query(
    `SELECT * FROM audit_snapshots WHERE monitored_site_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [siteId]
  );
  return rows[0] ? rowToSnapshot(rows[0]) : null;
}

async function getTrendsBySite(siteId) {
  const { rows } = await pool.query(
    `SELECT seo_score, performance_score, accessibility_score, overall_score, created_at
     FROM audit_snapshots WHERE monitored_site_id = $1 ORDER BY created_at ASC`,
    [siteId]
  );
  return rows.map(row => ({
    seoScore: row.seo_score,
    performanceScore: row.performance_score,
    accessibilityScore: row.accessibility_score,
    overallScore: row.overall_score,
    createdAt: Number(row.created_at),
  }));
}

function rowToSnapshot(row) {
  return {
    id: row.id,
    monitoredSiteId: row.monitored_site_id,
    reportId: row.report_id,
    seoScore: row.seo_score,
    performanceScore: row.performance_score,
    accessibilityScore: row.accessibility_score,
    overallScore: row.overall_score,
    issues: JSON.parse(row.issues_json || '[]'),
    competitorScores: JSON.parse(row.competitor_scores || '{}'),
    createdAt: Number(row.created_at),
  };
}

// ── Roadmaps API ────────────────────────────────────────────────────────────

async function saveRoadmap({ id, userId, monitoredSiteId, snapshotId, roadmapJson, roadmapHtml, vertical }) {
  await pool.query(
    `INSERT INTO roadmaps (id, user_id, monitored_site_id, snapshot_id, roadmap_json, roadmap_html, vertical, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, userId, monitoredSiteId || null, snapshotId || null, JSON.stringify(roadmapJson || {}), roadmapHtml || '', vertical || null, Date.now()]
  );
}

async function getRoadmap(id) {
  const { rows } = await pool.query(`SELECT * FROM roadmaps WHERE id = $1`, [id]);
  return rows[0] ? rowToRoadmap(rows[0]) : null;
}

async function getLatestRoadmapBySite(siteId) {
  const { rows } = await pool.query(
    `SELECT * FROM roadmaps WHERE monitored_site_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [siteId]
  );
  return rows[0] ? rowToRoadmap(rows[0]) : null;
}

async function getRoadmapsByUser(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM roadmaps WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [userId]
  );
  return rows.map(rowToRoadmap);
}

function rowToRoadmap(row) {
  return {
    id: row.id,
    userId: row.user_id,
    monitoredSiteId: row.monitored_site_id,
    snapshotId: row.snapshot_id,
    roadmapJson: JSON.parse(row.roadmap_json || '{}'),
    roadmapHtml: row.roadmap_html,
    vertical: row.vertical,
    createdAt: Number(row.created_at),
  };
}

// ── Admin helpers ───────────────────────────────────────────────────────────

async function countAdmins() {
  const { rows } = await pool.query(`SELECT COUNT(*) as cnt FROM users WHERE is_admin = 1`);
  return parseInt(rows[0].cnt, 10);
}

async function setAdmin(userId, isAdmin) {
  await pool.query(`UPDATE users SET is_admin = $1 WHERE id = $2`, [isAdmin ? 1 : 0, userId]);
}

async function getAdminStats() {
  const results = await Promise.all([
    pool.query(`SELECT COUNT(*) as cnt FROM users`),
    pool.query(`SELECT COUNT(*) as cnt FROM subscriptions WHERE status IN ('active','trialing','cancelling')`),
    pool.query(`SELECT COALESCE(SUM(audit_count),0) as cnt FROM subscriptions`),
    pool.query(`SELECT COUNT(*) as cnt FROM waitlist`),
    pool.query(`SELECT COUNT(*) as cnt FROM monitored_sites WHERE enabled = 1`),
    pool.query(`SELECT COUNT(*) as cnt FROM reports`),
    pool.query(`SELECT COUNT(*) as cnt FROM subscriptions WHERE status IN ('active','cancelling') AND plan_tier = 'starter'`),
    pool.query(`SELECT COUNT(*) as cnt FROM subscriptions WHERE status IN ('active','cancelling') AND plan_tier = 'pro'`),
    pool.query(`SELECT COUNT(*) as cnt FROM subscriptions WHERE status = 'trialing'`),
  ]);

  const [totalUsers, totalSubscribers, totalAudits, totalWaitlist, totalMonitoredSites, totalReports, starterCount, proCount, trialingCount] =
    results.map(r => parseInt(r.rows[0].cnt, 10));

  const mrr = (starterCount * 9) + (proCount * 29);

  return { totalUsers, totalSubscribers, totalAudits, totalWaitlist, totalMonitoredSites, totalReports, starterCount, proCount, trialingCount, mrr };
}

async function getAllUsers({ search, limit = 50, offset = 0 } = {}) {
  let query = `SELECT u.*, s.status as sub_status, s.plan_tier, s.audit_count as total_audits, s.email as sub_email
               FROM users u LEFT JOIN subscriptions s ON u.api_key = s.api_key`;
  const params = [];
  let paramIdx = 1;
  if (search) {
    query += ` WHERE LOWER(u.username) LIKE LOWER($${paramIdx}) OR LOWER(u.email) LIKE LOWER($${paramIdx + 1}) OR LOWER(COALESCE(s.email, '')) LIKE LOWER($${paramIdx + 2})`;
    const like = `%${search}%`;
    params.push(like, like, like);
    paramIdx += 3;
  }
  query += ` ORDER BY u.created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
  params.push(limit, offset);
  const { rows } = await pool.query(query, params);
  return rows;
}

async function getAllSubscriptions({ search, status, planTier, limit = 50, offset = 0 } = {}) {
  let query = `SELECT s.*, u.username FROM subscriptions s LEFT JOIN users u ON u.api_key = s.api_key`;
  const conditions = [];
  const params = [];
  let paramIdx = 1;
  if (search) {
    conditions.push(`(LOWER(s.email) LIKE LOWER($${paramIdx}) OR LOWER(COALESCE(u.username, '')) LIKE LOWER($${paramIdx + 1}))`);
    const like = `%${search}%`;
    params.push(like, like);
    paramIdx += 2;
  }
  if (status) {
    conditions.push(`s.status = $${paramIdx}`);
    params.push(status);
    paramIdx++;
  }
  if (planTier) {
    conditions.push(`s.plan_tier = $${paramIdx}`);
    params.push(planTier);
    paramIdx++;
  }
  if (conditions.length) query += ` WHERE ` + conditions.join(' AND ');
  query += ` ORDER BY s.created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
  params.push(limit, offset);
  const { rows } = await pool.query(query, params);
  return rows;
}

async function updateSubscriptionFields(apiKey, fields) {
  const allowed = ['status', 'plan_tier', 'audit_count', 'monthly_audit_count'];
  const sets = [];
  const params = [];
  let paramIdx = 1;
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) { sets.push(`${k} = $${paramIdx}`); params.push(v); paramIdx++; }
  }
  if (!sets.length) return;
  params.push(apiKey);
  await pool.query(`UPDATE subscriptions SET ${sets.join(', ')} WHERE api_key = $${paramIdx}`, params);
}

async function getTimeSeriesSignups(days = 30) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const { rows } = await pool.query(`
    SELECT (created_at / 86400000)::BIGINT as day_bucket, COUNT(*) as cnt
    FROM users WHERE created_at >= $1 GROUP BY day_bucket ORDER BY day_bucket ASC
  `, [cutoff]);
  return rows.map(r => ({ day_bucket: Number(r.day_bucket), cnt: parseInt(r.cnt, 10) }));
}

async function getTimeSeriesAudits(days = 30) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const { rows } = await pool.query(`
    SELECT (created_at / 86400000)::BIGINT as day_bucket, COUNT(*) as cnt
    FROM reports WHERE created_at >= $1 GROUP BY day_bucket ORDER BY day_bucket ASC
  `, [cutoff]);
  return rows.map(r => ({ day_bucket: Number(r.day_bucket), cnt: parseInt(r.cnt, 10) }));
}

async function getTimeSeriesRevenue(days = 30) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const { rows } = await pool.query(`
    SELECT (created_at / 86400000)::BIGINT as day_bucket,
           SUM(CASE WHEN plan_tier = 'starter' THEN 9 ELSE 29 END) as revenue,
           COUNT(*) as cnt
    FROM subscriptions WHERE created_at >= $1 AND status IN ('active','trialing','cancelling')
    GROUP BY day_bucket ORDER BY day_bucket ASC
  `, [cutoff]);
  return rows.map(r => ({ day_bucket: Number(r.day_bucket), revenue: parseInt(r.revenue, 10), cnt: parseInt(r.cnt, 10) }));
}

// ── Support Tickets API ─────────────────────────────────────────────────────

async function generateTicketNumber() {
  const { rows } = await pool.query(`SELECT COUNT(*) as cnt FROM support_tickets`);
  return `SUP-${String(parseInt(rows[0].cnt, 10) + 1).padStart(4, '0')}`;
}

async function createSupportTicket({ id, email, userId, category, subject, description, priority }) {
  const now = Date.now();
  const ticketNumber = await generateTicketNumber();
  const statusHistory = JSON.stringify([{ status: 'new', at: now }]);
  await pool.query(
    `INSERT INTO support_tickets (id, ticket_number, email, user_id, category, subject, description, priority, status, assignee, internal_notes, status_history, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'new', NULL, '[]', $9, $10, $11)`,
    [id, ticketNumber, email || '', userId || null, category || 'other', subject, description, priority || 'medium', statusHistory, now, now]
  );
  return getSupportTicket(id);
}

async function getSupportTicket(id) {
  const { rows } = await pool.query(`SELECT * FROM support_tickets WHERE id = $1`, [id]);
  return rows[0] ? rowToTicket(rows[0]) : null;
}

async function getSupportTicketByNumber(ticketNumber) {
  const { rows } = await pool.query(`SELECT * FROM support_tickets WHERE ticket_number = $1`, [ticketNumber]);
  return rows[0] ? rowToTicket(rows[0]) : null;
}

async function listSupportTickets({ status, limit = 50, offset = 0 } = {}) {
  let query, params;
  if (status) {
    query = `SELECT * FROM support_tickets WHERE status = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`;
    params = [status, limit, offset];
  } else {
    query = `SELECT * FROM support_tickets ORDER BY created_at DESC LIMIT $1 OFFSET $2`;
    params = [limit, offset];
  }
  const { rows } = await pool.query(query, params);
  return rows.map(rowToTicket);
}

async function getSupportTicketsByEmail(email) {
  const { rows } = await pool.query(`SELECT * FROM support_tickets WHERE email = $1 ORDER BY created_at DESC`, [email]);
  return rows.map(rowToTicket);
}

async function updateSupportTicket(id, { status, assignee, internalNote, priority }) {
  const { rows } = await pool.query(`SELECT * FROM support_tickets WHERE id = $1`, [id]);
  const existing = rows[0];
  if (!existing) return null;

  const now = Date.now();
  const notes = JSON.parse(existing.internal_notes || '[]');
  if (internalNote) {
    notes.push({ text: internalNote, at: now });
  }

  const history = JSON.parse(existing.status_history || '[]');
  const newStatus = status || existing.status;
  if (status && status !== existing.status) {
    history.push({ status, at: now });
  }

  await pool.query(
    `UPDATE support_tickets SET status = $1, assignee = $2, internal_notes = $3, status_history = $4, priority = $5, updated_at = $6 WHERE id = $7`,
    [newStatus, assignee !== undefined ? assignee : existing.assignee, JSON.stringify(notes), JSON.stringify(history), priority || existing.priority, now, id]
  );

  return getSupportTicket(id);
}

async function getSupportTicketStats() {
  const [totalRes, byStatusRes, avgRes, catRes] = await Promise.all([
    pool.query(`SELECT COUNT(*) as cnt FROM support_tickets`),
    pool.query(`SELECT status, COUNT(*) as cnt FROM support_tickets GROUP BY status`),
    pool.query(`SELECT AVG(updated_at - created_at) as avg_ms FROM support_tickets WHERE status = 'resolved'`),
    pool.query(`SELECT category, COUNT(*) as cnt FROM support_tickets GROUP BY category`),
  ]);

  const total = parseInt(totalRes.rows[0].cnt, 10);
  const byStatus = {};
  for (const row of byStatusRes.rows) { byStatus[row.status] = parseInt(row.cnt, 10); }
  const avgResponse = parseFloat(avgRes.rows[0].avg_ms) || 0;
  const categories = {};
  for (const row of catRes.rows) { categories[row.category] = parseInt(row.cnt, 10); }

  return {
    total,
    byStatus,
    avgResponseTimeMs: Math.round(avgResponse),
    categories,
    resolutionRate: total > 0 ? Math.round(((byStatus.resolved || 0) / total) * 100) : 0,
  };
}

function rowToTicket(row) {
  return {
    id: row.id,
    ticketNumber: row.ticket_number,
    email: row.email,
    userId: row.user_id,
    category: row.category,
    subject: row.subject,
    description: row.description,
    priority: row.priority,
    status: row.status,
    assignee: row.assignee,
    internalNotes: JSON.parse(row.internal_notes || '[]'),
    statusHistory: JSON.parse(row.status_history || '[]'),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

async function ping() {
  await pool.query('SELECT 1');
}

module.exports = {
  migrate,
  pool,
  ping,
  saveReportMeta,
  getReportMeta,
  getReportsByUser,
  deleteReportMeta,
  pruneOldReports,
  saveWaitlistEmail,
  upsertSubscription,
  getSubscriptionByApiKey,
  getSubscriptionByCustomerId,
  updateSubscriptionStatus,
  incrementAuditCount,
  incrementPdfCount,
  getSubscriptionsForTrialEmails,
  markEmailSent,
  updatePlanTier,
  incrementMonthlyAuditCount,
  getMonthlyAuditCount,
  createUser,
  getUserById,
  getUserByUsername,
  getUserBySessionToken,
  updateUserSession,
  linkUserApiKey,
  getUserByEmail,
  setResetToken,
  getUserByResetToken,
  updatePassword,
  // Tier 3: Monitoring
  createMonitoredSite,
  getMonitoredSite,
  getMonitoredSitesByUser,
  updateMonitoredSite,
  deleteMonitoredSite,
  getDueSites,
  updateSiteNextRun,
  countUserMonitoredSites,
  FREQUENCY_MS,
  // Tier 3: Snapshots
  saveSnapshot,
  getSnapshot,
  getSnapshotsBySite,
  getLatestSnapshot,
  getTrendsBySite,
  // Tier 3: Roadmaps
  saveRoadmap,
  getRoadmap,
  getLatestRoadmapBySite,
  getRoadmapsByUser,
  // Support Tickets
  createSupportTicket,
  getSupportTicket,
  getSupportTicketByNumber,
  listSupportTickets,
  getSupportTicketsByEmail,
  updateSupportTicket,
  getSupportTicketStats,
  // Admin
  countAdmins,
  setAdmin,
  getAdminStats,
  getAllUsers,
  getAllSubscriptions,
  updateSubscriptionFields,
  getTimeSeriesSignups,
  getTimeSeriesAudits,
  getTimeSeriesRevenue,
};
