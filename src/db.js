'use strict';

/**
 * SQLite persistence layer for AuditBot.
 *
 * Stores:
 *   - reports: metadata + S3/local storage key for each audit report
 *   - subscriptions: Stripe billing data (replaces in-memory Maps in billing.js)
 *
 * DB file location: $DB_PATH or ./data/auditbot.db
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'auditbot.db');

// Ensure the data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id          TEXT PRIMARY KEY,
    url         TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    audit_json  TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    api_key         TEXT PRIMARY KEY,
    email           TEXT NOT NULL,
    customer_id     TEXT NOT NULL UNIQUE,
    subscription_id TEXT,
    status          TEXT NOT NULL DEFAULT 'incomplete',
    created_at      INTEGER NOT NULL,
    audit_count     INTEGER NOT NULL DEFAULT 0,
    emails_sent     TEXT    NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS waitlist (
    email      TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    email         TEXT,
    api_key       TEXT REFERENCES subscriptions(api_key),
    session_token TEXT UNIQUE,
    created_at    INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at);
  CREATE INDEX IF NOT EXISTS idx_subs_customer   ON subscriptions(customer_id);
  CREATE INDEX IF NOT EXISTS idx_users_username   ON users(username COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_users_session    ON users(session_token);
`);

// Migrate: add columns if they don't exist (safe on first run after upgrade)
try { db.exec(`ALTER TABLE subscriptions ADD COLUMN audit_count  INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE subscriptions ADD COLUMN emails_sent  TEXT    NOT NULL DEFAULT '{}'`); } catch (_) {}
try { db.exec(`ALTER TABLE subscriptions ADD COLUMN pdf_count    INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE subscriptions ADD COLUMN plan_tier    TEXT    NOT NULL DEFAULT 'pro'`); } catch (_) {}
try { db.exec(`ALTER TABLE subscriptions ADD COLUMN monthly_audit_count INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE subscriptions ADD COLUMN monthly_reset_at    INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE reports ADD COLUMN user_id TEXT`); } catch (_) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_reports_user ON reports(user_id)`); } catch (_) {}
try { db.exec(`ALTER TABLE users ADD COLUMN reset_token TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE users ADD COLUMN reset_token_expires INTEGER`); } catch (_) {}
try { db.exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`); } catch (_) {}

// ── Tier 3: Monitoring + Roadmap tables ──────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS monitored_sites (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    url             TEXT NOT NULL,
    frequency       TEXT NOT NULL DEFAULT 'weekly',
    next_run_at     INTEGER NOT NULL,
    last_run_at     INTEGER,
    competitor_urls TEXT NOT NULL DEFAULT '[]',
    notify_on       TEXT NOT NULL DEFAULT '{"score_drop":true,"new_issues":true,"competitor_change":true}',
    enabled         INTEGER NOT NULL DEFAULT 1,
    created_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_snapshots (
    id                TEXT PRIMARY KEY,
    monitored_site_id TEXT NOT NULL,
    report_id         TEXT,
    seo_score         INTEGER NOT NULL DEFAULT 0,
    performance_score INTEGER NOT NULL DEFAULT 0,
    accessibility_score INTEGER NOT NULL DEFAULT 0,
    overall_score     INTEGER NOT NULL DEFAULT 0,
    issues_json       TEXT NOT NULL DEFAULT '[]',
    competitor_scores TEXT NOT NULL DEFAULT '{}',
    created_at        INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS roadmaps (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL,
    monitored_site_id TEXT,
    snapshot_id       TEXT,
    roadmap_json      TEXT NOT NULL DEFAULT '{}',
    roadmap_html      TEXT NOT NULL DEFAULT '',
    vertical          TEXT,
    created_at        INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_snapshots_site_created ON audit_snapshots(monitored_site_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_monitored_user ON monitored_sites(user_id, enabled);
  CREATE INDEX IF NOT EXISTS idx_monitored_next_run ON monitored_sites(next_run_at, enabled);
  CREATE INDEX IF NOT EXISTS idx_roadmaps_user ON roadmaps(user_id);
  CREATE INDEX IF NOT EXISTS idx_roadmaps_site ON roadmaps(monitored_site_id);
`);

// ── Report helpers ─────────────────────────────────────────────────────────────

const stmts = {
  insertReport: db.prepare(
    `INSERT INTO reports (id, url, storage_key, audit_json, created_at, user_id)
     VALUES (@id, @url, @storage_key, @audit_json, @created_at, @user_id)`
  ),
  getReport: db.prepare(`SELECT * FROM reports WHERE id = ?`),
  deleteReport: db.prepare(`DELETE FROM reports WHERE id = ?`),
  pruneReports: db.prepare(`DELETE FROM reports WHERE created_at < ?`),
  getReportsByUser: db.prepare(`SELECT id, url, created_at FROM reports WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`),

  // Waitlist
  insertWaitlist: db.prepare(
    `INSERT OR IGNORE INTO waitlist (email, created_at) VALUES (?, ?)`
  ),

  // Subscriptions
  upsertSubscription: db.prepare(`
    INSERT INTO subscriptions (api_key, email, customer_id, subscription_id, status, created_at)
    VALUES (@api_key, @email, @customer_id, @subscription_id, @status, @created_at)
    ON CONFLICT(customer_id) DO UPDATE SET
      email           = excluded.email,
      subscription_id = COALESCE(excluded.subscription_id, subscriptions.subscription_id),
      status          = excluded.status
  `),
  getSubByApiKey:    db.prepare(`SELECT * FROM subscriptions WHERE api_key = ?`),
  getSubByCustomer:  db.prepare(`SELECT * FROM subscriptions WHERE customer_id = ?`),
  updateSubStatus:   db.prepare(
    `UPDATE subscriptions SET status = @status, subscription_id = COALESCE(@subscription_id, subscription_id)
     WHERE customer_id = @customer_id`
  ),
  incrAuditCount: db.prepare(
    `UPDATE subscriptions SET audit_count = audit_count + 1 WHERE api_key = ?`
  ),
  incrPdfCount: db.prepare(
    `UPDATE subscriptions SET pdf_count = pdf_count + 1 WHERE api_key = ?`
  ),
  getSubsDueTrialEmail: db.prepare(
    `SELECT * FROM subscriptions WHERE status IN ('active', 'trialing', 'incomplete') AND created_at < ?`
  ),
  updateEmailsSent: db.prepare(
    `UPDATE subscriptions SET emails_sent = ? WHERE api_key = ?`
  ),
  updatePlanTier: db.prepare(
    `UPDATE subscriptions SET plan_tier = ? WHERE customer_id = ?`
  ),
  resetMonthlyAudits: db.prepare(
    `UPDATE subscriptions SET monthly_audit_count = 0, monthly_reset_at = ? WHERE api_key = ?`
  ),
  incrMonthlyAuditCount: db.prepare(
    `UPDATE subscriptions SET monthly_audit_count = monthly_audit_count + 1 WHERE api_key = ?`
  ),

  // Users
  insertUser: db.prepare(
    `INSERT INTO users (id, username, password_hash, email, api_key, session_token, created_at)
     VALUES (@id, @username, @password_hash, @email, @api_key, @session_token, @created_at)`
  ),
  getUserById: db.prepare(`SELECT * FROM users WHERE id = ?`),
  getUserByUsername: db.prepare(`SELECT * FROM users WHERE username = ? COLLATE NOCASE`),
  getUserBySessionToken: db.prepare(`SELECT * FROM users WHERE session_token = ?`),
  updateUserSession: db.prepare(`UPDATE users SET session_token = ? WHERE id = ?`),
  linkUserApiKey: db.prepare(`UPDATE users SET api_key = ? WHERE id = ?`),
  getUserByEmail: db.prepare(`SELECT * FROM users WHERE email = ? COLLATE NOCASE`),
  setResetToken: db.prepare(`UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?`),
  getUserByResetToken: db.prepare(`SELECT * FROM users WHERE reset_token = ?`),
  updatePassword: db.prepare(`UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?`),
};

// ── Reports API ────────────────────────────────────────────────────────────────

function saveReportMeta({ id, url, storageKey, audit, userId = null }) {
  stmts.insertReport.run({
    id,
    url,
    storage_key: storageKey,
    audit_json: JSON.stringify(audit),
    created_at: Date.now(),
    user_id: userId,
  });
}

function getReportsByUser(userId) {
  return stmts.getReportsByUser.all(userId).map(row => ({
    id: row.id,
    url: row.url,
    createdAt: row.created_at,
  }));
}

function getReportMeta(id) {
  const row = stmts.getReport.get(id);
  if (!row) return null;
  return {
    id: row.id,
    url: row.url,
    storageKey: row.storage_key,
    audit: JSON.parse(row.audit_json),
    createdAt: row.created_at,
  };
}

function deleteReportMeta(id) {
  stmts.deleteReport.run(id);
}

/** Remove report metadata older than `maxAgeMs` milliseconds. */
function pruneOldReports(maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  stmts.pruneReports.run(cutoff);
}

// ── Waitlist API ───────────────────────────────────────────────────────────────

/** Store an email in the waitlist. Silently ignores duplicate emails. */
function saveWaitlistEmail(email) {
  stmts.insertWaitlist.run(email, Date.now());
}

// ── Subscriptions API ──────────────────────────────────────────────────────────

function upsertSubscription({ apiKey, email, customerId, subscriptionId = null, status = 'incomplete' }) {
  stmts.upsertSubscription.run({
    api_key: apiKey,
    email,
    customer_id: customerId,
    subscription_id: subscriptionId,
    status,
    created_at: Date.now(),
  });
}

function getSubscriptionByApiKey(apiKey) {
  const row = stmts.getSubByApiKey.get(apiKey);
  if (!row) return null;
  return rowToSub(row);
}

function getSubscriptionByCustomerId(customerId) {
  const row = stmts.getSubByCustomer.get(customerId);
  if (!row) return null;
  return rowToSub(row);
}

function updateSubscriptionStatus({ customerId, status, subscriptionId = null }) {
  stmts.updateSubStatus.run({ customer_id: customerId, status, subscription_id: subscriptionId });
}

function rowToSub(row) {
  return {
    apiKey:            row.api_key,
    email:             row.email,
    customerId:        row.customer_id,
    subscriptionId:    row.subscription_id,
    status:            row.status,
    createdAt:         row.created_at,
    auditCount:        row.audit_count || 0,
    pdfCount:          row.pdf_count || 0,
    emailsSent:        JSON.parse(row.emails_sent || '{}'),
    planTier:          row.plan_tier || 'pro',
    monthlyAuditCount: row.monthly_audit_count || 0,
    monthlyResetAt:    row.monthly_reset_at || 0,
  };
}

/** Increment audit count for a given API key. */
function incrementAuditCount(apiKey) {
  stmts.incrAuditCount.run(apiKey);
}

/** Increment PDF export count for a given API key. */
function incrementPdfCount(apiKey) {
  stmts.incrPdfCount.run(apiKey);
}

/**
 * Return subscriptions created before `beforeMs` that may need trial emails.
 * Caller filters by which emails have already been sent.
 */
function getSubscriptionsForTrialEmails(beforeMs) {
  return stmts.getSubsDueTrialEmail.all(beforeMs).map(rowToSub);
}

/** Mark one or more email keys as sent for a given API key. */
function markEmailSent(apiKey, emailKey) {
  const sub = stmts.getSubByApiKey.get(apiKey);
  if (!sub) return;
  const flags = JSON.parse(sub.emails_sent || '{}');
  flags[emailKey] = Date.now();
  stmts.updateEmailsSent.run(JSON.stringify(flags), apiKey);
}

/** Update the plan tier for a customer. */
function updatePlanTier(customerId, tier) {
  stmts.updatePlanTier.run(tier, customerId);
}

/** Increment monthly audit count, resetting if a new month has started. */
function incrementMonthlyAuditCount(apiKey) {
  const sub = stmts.getSubByApiKey.get(apiKey);
  if (!sub) return;
  const now = Date.now();
  const resetAt = sub.monthly_reset_at || 0;
  // Reset counter if more than 30 days since last reset
  if (now - resetAt > 30 * 24 * 60 * 60 * 1000) {
    stmts.resetMonthlyAudits.run(now, apiKey);
  }
  stmts.incrMonthlyAuditCount.run(apiKey);
}

/** Get current monthly audit count, auto-resetting if needed. */
function getMonthlyAuditCount(apiKey) {
  const sub = stmts.getSubByApiKey.get(apiKey);
  if (!sub) return 0;
  const now = Date.now();
  const resetAt = sub.monthly_reset_at || 0;
  if (now - resetAt > 30 * 24 * 60 * 60 * 1000) {
    stmts.resetMonthlyAudits.run(now, apiKey);
    return 0;
  }
  return sub.monthly_audit_count || 0;
}

// ── Users API ─────────────────────────────────────────────────────────────────

function createUser({ id, username, passwordHash, email = null, apiKey = null, sessionToken = null }) {
  stmts.insertUser.run({
    id,
    username,
    password_hash: passwordHash,
    email: email,
    api_key: apiKey,
    session_token: sessionToken,
    created_at: Date.now(),
  });
}

function getUserById(id) {
  return stmts.getUserById.get(id) || null;
}

function getUserByUsername(username) {
  return stmts.getUserByUsername.get(username) || null;
}

function getUserBySessionToken(token) {
  return stmts.getUserBySessionToken.get(token) || null;
}

function updateUserSession(userId, sessionToken) {
  stmts.updateUserSession.run(sessionToken, userId);
}

function linkUserApiKey(userId, apiKey) {
  stmts.linkUserApiKey.run(apiKey, userId);
}

function getUserByEmail(email) {
  return stmts.getUserByEmail.get(email) || null;
}

function setResetToken(userId, token, expiresAt) {
  stmts.setResetToken.run(token, expiresAt, userId);
}

function getUserByResetToken(token) {
  const user = stmts.getUserByResetToken.get(token);
  if (!user) return null;
  if (user.reset_token_expires && Date.now() > user.reset_token_expires) return null;
  return user;
}

function updatePassword(userId, passwordHash) {
  stmts.updatePassword.run(passwordHash, userId);
}

// ── Monitored Sites API ──────────────────────────────────────────────────────

const monitorStmts = {
  insertSite: db.prepare(
    `INSERT INTO monitored_sites (id, user_id, url, frequency, next_run_at, competitor_urls, notify_on, enabled, created_at)
     VALUES (@id, @user_id, @url, @frequency, @next_run_at, @competitor_urls, @notify_on, @enabled, @created_at)`
  ),
  getSite: db.prepare(`SELECT * FROM monitored_sites WHERE id = ?`),
  getSitesByUser: db.prepare(`SELECT * FROM monitored_sites WHERE user_id = ? ORDER BY created_at DESC`),
  getEnabledSitesByUser: db.prepare(`SELECT * FROM monitored_sites WHERE user_id = ? AND enabled = 1 ORDER BY created_at DESC`),
  updateSite: db.prepare(
    `UPDATE monitored_sites SET frequency = @frequency, competitor_urls = @competitor_urls,
     notify_on = @notify_on, enabled = @enabled, next_run_at = @next_run_at WHERE id = @id`
  ),
  deleteSite: db.prepare(`DELETE FROM monitored_sites WHERE id = ?`),
  getDueSites: db.prepare(`SELECT * FROM monitored_sites WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT ?`),
  updateNextRun: db.prepare(`UPDATE monitored_sites SET next_run_at = ?, last_run_at = ? WHERE id = ?`),
  countUserSites: db.prepare(`SELECT COUNT(*) as cnt FROM monitored_sites WHERE user_id = ? AND enabled = 1`),

  // Snapshots
  insertSnapshot: db.prepare(
    `INSERT INTO audit_snapshots (id, monitored_site_id, report_id, seo_score, performance_score, accessibility_score, overall_score, issues_json, competitor_scores, created_at)
     VALUES (@id, @monitored_site_id, @report_id, @seo_score, @performance_score, @accessibility_score, @overall_score, @issues_json, @competitor_scores, @created_at)`
  ),
  getSnapshot: db.prepare(`SELECT * FROM audit_snapshots WHERE id = ?`),
  getSnapshotsBySite: db.prepare(
    `SELECT * FROM audit_snapshots WHERE monitored_site_id = ? ORDER BY created_at DESC LIMIT ?`
  ),
  getLatestSnapshot: db.prepare(
    `SELECT * FROM audit_snapshots WHERE monitored_site_id = ? ORDER BY created_at DESC LIMIT 1`
  ),
  getTrendsBySite: db.prepare(
    `SELECT seo_score, performance_score, accessibility_score, overall_score, created_at
     FROM audit_snapshots WHERE monitored_site_id = ? ORDER BY created_at ASC`
  ),

  // Roadmaps
  insertRoadmap: db.prepare(
    `INSERT INTO roadmaps (id, user_id, monitored_site_id, snapshot_id, roadmap_json, roadmap_html, vertical, created_at)
     VALUES (@id, @user_id, @monitored_site_id, @snapshot_id, @roadmap_json, @roadmap_html, @vertical, @created_at)`
  ),
  getRoadmap: db.prepare(`SELECT * FROM roadmaps WHERE id = ?`),
  getLatestRoadmapBySite: db.prepare(
    `SELECT * FROM roadmaps WHERE monitored_site_id = ? ORDER BY created_at DESC LIMIT 1`
  ),
  getRoadmapsByUser: db.prepare(`SELECT * FROM roadmaps WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`),
};

const FREQUENCY_MS = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  biweekly: 14 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

function createMonitoredSite({ id, userId, url, frequency = 'weekly', competitorUrls = [], notifyOn = null }) {
  const now = Date.now();
  monitorStmts.insertSite.run({
    id,
    user_id: userId,
    url,
    frequency,
    next_run_at: now, // run immediately on first check
    competitor_urls: JSON.stringify(competitorUrls.slice(0, 3)),
    notify_on: JSON.stringify(notifyOn || { score_drop: true, new_issues: true, competitor_change: true }),
    enabled: 1,
    created_at: now,
  });
}

function getMonitoredSite(id) {
  const row = monitorStmts.getSite.get(id);
  return row ? rowToMonitoredSite(row) : null;
}

function getMonitoredSitesByUser(userId) {
  return monitorStmts.getSitesByUser.all(userId).map(rowToMonitoredSite);
}

function updateMonitoredSite(id, { frequency, competitorUrls, notifyOn, enabled }) {
  const existing = monitorStmts.getSite.get(id);
  if (!existing) return null;
  const freq = frequency || existing.frequency;
  const nextRun = frequency && frequency !== existing.frequency
    ? Date.now() + (FREQUENCY_MS[freq] || FREQUENCY_MS.weekly)
    : existing.next_run_at;
  monitorStmts.updateSite.run({
    id,
    frequency: freq,
    competitor_urls: competitorUrls !== undefined ? JSON.stringify((competitorUrls || []).slice(0, 3)) : existing.competitor_urls,
    notify_on: notifyOn !== undefined ? JSON.stringify(notifyOn) : existing.notify_on,
    enabled: enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
    next_run_at: nextRun,
  });
  return getMonitoredSite(id);
}

function deleteMonitoredSite(id) {
  monitorStmts.deleteSite.run(id);
}

function getDueSites(limit = 10) {
  return monitorStmts.getDueSites.all(Date.now(), limit).map(rowToMonitoredSite);
}

function updateSiteNextRun(id, frequency) {
  const intervalMs = FREQUENCY_MS[frequency] || FREQUENCY_MS.weekly;
  const now = Date.now();
  monitorStmts.updateNextRun.run(now + intervalMs, now, id);
}

function countUserMonitoredSites(userId) {
  return monitorStmts.countUserSites.get(userId).cnt;
}

function rowToMonitoredSite(row) {
  return {
    id: row.id,
    userId: row.user_id,
    url: row.url,
    frequency: row.frequency,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    competitorUrls: JSON.parse(row.competitor_urls || '[]'),
    notifyOn: JSON.parse(row.notify_on || '{}'),
    enabled: !!row.enabled,
    createdAt: row.created_at,
  };
}

// ── Audit Snapshots API ──────────────────────────────────────────────────────

function saveSnapshot({ id, monitoredSiteId, reportId, seoScore, performanceScore, accessibilityScore, overallScore, issues, competitorScores }) {
  monitorStmts.insertSnapshot.run({
    id,
    monitored_site_id: monitoredSiteId,
    report_id: reportId || null,
    seo_score: seoScore,
    performance_score: performanceScore,
    accessibility_score: accessibilityScore,
    overall_score: overallScore,
    issues_json: JSON.stringify(issues || []),
    competitor_scores: JSON.stringify(competitorScores || {}),
    created_at: Date.now(),
  });
}

function getSnapshot(id) {
  const row = monitorStmts.getSnapshot.get(id);
  return row ? rowToSnapshot(row) : null;
}

function getSnapshotsBySite(siteId, limit = 20) {
  return monitorStmts.getSnapshotsBySite.all(siteId, limit).map(rowToSnapshot);
}

function getLatestSnapshot(siteId) {
  const row = monitorStmts.getLatestSnapshot.get(siteId);
  return row ? rowToSnapshot(row) : null;
}

function getTrendsBySite(siteId) {
  return monitorStmts.getTrendsBySite.all(siteId).map(row => ({
    seoScore: row.seo_score,
    performanceScore: row.performance_score,
    accessibilityScore: row.accessibility_score,
    overallScore: row.overall_score,
    createdAt: row.created_at,
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
    createdAt: row.created_at,
  };
}

// ── Roadmaps API ─────────────────────────────────────────────────────────────

function saveRoadmap({ id, userId, monitoredSiteId, snapshotId, roadmapJson, roadmapHtml, vertical }) {
  monitorStmts.insertRoadmap.run({
    id,
    user_id: userId,
    monitored_site_id: monitoredSiteId || null,
    snapshot_id: snapshotId || null,
    roadmap_json: JSON.stringify(roadmapJson || {}),
    roadmap_html: roadmapHtml || '',
    vertical: vertical || null,
    created_at: Date.now(),
  });
}

function getRoadmap(id) {
  const row = monitorStmts.getRoadmap.get(id);
  return row ? rowToRoadmap(row) : null;
}

function getLatestRoadmapBySite(siteId) {
  const row = monitorStmts.getLatestRoadmapBySite.get(siteId);
  return row ? rowToRoadmap(row) : null;
}

function getRoadmapsByUser(userId) {
  return monitorStmts.getRoadmapsByUser.all(userId).map(rowToRoadmap);
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
    createdAt: row.created_at,
  };
}

// ── Admin helpers ───────────────────────────────────────────────────────────

function countAdmins() {
  return db.prepare(`SELECT COUNT(*) as cnt FROM users WHERE is_admin = 1`).get().cnt;
}

function setAdmin(userId, isAdmin) {
  db.prepare(`UPDATE users SET is_admin = ? WHERE id = ?`).run(isAdmin ? 1 : 0, userId);
}

function getAdminStats() {
  const totalUsers = db.prepare(`SELECT COUNT(*) as cnt FROM users`).get().cnt;
  const totalSubscribers = db.prepare(`SELECT COUNT(*) as cnt FROM subscriptions WHERE status IN ('active','trialing','cancelling')`).get().cnt;
  const totalAudits = db.prepare(`SELECT COALESCE(SUM(audit_count),0) as cnt FROM subscriptions`).get().cnt;
  const totalWaitlist = db.prepare(`SELECT COUNT(*) as cnt FROM waitlist`).get().cnt;
  const totalMonitoredSites = db.prepare(`SELECT COUNT(*) as cnt FROM monitored_sites WHERE enabled = 1`).get().cnt;
  const totalReports = db.prepare(`SELECT COUNT(*) as cnt FROM reports`).get().cnt;

  // MRR calculation
  const starterCount = db.prepare(`SELECT COUNT(*) as cnt FROM subscriptions WHERE status IN ('active','cancelling') AND plan_tier = 'starter'`).get().cnt;
  const proCount = db.prepare(`SELECT COUNT(*) as cnt FROM subscriptions WHERE status IN ('active','cancelling') AND plan_tier = 'pro'`).get().cnt;
  const trialingCount = db.prepare(`SELECT COUNT(*) as cnt FROM subscriptions WHERE status = 'trialing'`).get().cnt;
  const mrr = (starterCount * 9) + (proCount * 29);

  return { totalUsers, totalSubscribers, totalAudits, totalWaitlist, totalMonitoredSites, totalReports, starterCount, proCount, trialingCount, mrr };
}

function getAllUsers({ search, limit = 50, offset = 0 } = {}) {
  let query = `SELECT u.*, s.status as sub_status, s.plan_tier, s.audit_count as total_audits, s.email as sub_email
               FROM users u LEFT JOIN subscriptions s ON u.api_key = s.api_key`;
  const params = [];
  if (search) {
    query += ` WHERE u.username LIKE ? OR u.email LIKE ? OR COALESCE(s.email, '') LIKE ?`;
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  query += ` ORDER BY u.created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  return db.prepare(query).all(...params);
}

function getAllSubscriptions({ search, status, planTier, limit = 50, offset = 0 } = {}) {
  let query = `SELECT s.*, u.username FROM subscriptions s LEFT JOIN users u ON u.api_key = s.api_key`;
  const conditions = [];
  const params = [];
  if (search) {
    conditions.push(`(s.email LIKE ? OR COALESCE(u.username, '') LIKE ?)`);
    const like = `%${search}%`;
    params.push(like, like);
  }
  if (status) {
    conditions.push(`s.status = ?`);
    params.push(status);
  }
  if (planTier) {
    conditions.push(`s.plan_tier = ?`);
    params.push(planTier);
  }
  if (conditions.length) query += ` WHERE ` + conditions.join(' AND ');
  query += ` ORDER BY s.created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  return db.prepare(query).all(...params);
}

function updateSubscriptionFields(apiKey, fields) {
  const allowed = ['status', 'plan_tier', 'audit_count', 'monthly_audit_count'];
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) { sets.push(`${k} = ?`); params.push(v); }
  }
  if (!sets.length) return;
  params.push(apiKey);
  db.prepare(`UPDATE subscriptions SET ${sets.join(', ')} WHERE api_key = ?`).run(...params);
}

function getTimeSeriesSignups(days = 30) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return db.prepare(`
    SELECT CAST(created_at / 86400000 AS INTEGER) as day_bucket, COUNT(*) as cnt
    FROM users WHERE created_at >= ? GROUP BY day_bucket ORDER BY day_bucket ASC
  `).all(cutoff);
}

function getTimeSeriesAudits(days = 30) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return db.prepare(`
    SELECT CAST(created_at / 86400000 AS INTEGER) as day_bucket, COUNT(*) as cnt
    FROM reports WHERE created_at >= ? GROUP BY day_bucket ORDER BY day_bucket ASC
  `).all(cutoff);
}

function getTimeSeriesRevenue(days = 30) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return db.prepare(`
    SELECT CAST(created_at / 86400000 AS INTEGER) as day_bucket,
           SUM(CASE WHEN plan_tier = 'starter' THEN 9 ELSE 29 END) as revenue,
           COUNT(*) as cnt
    FROM subscriptions WHERE created_at >= ? AND status IN ('active','trialing','cancelling')
    GROUP BY day_bucket ORDER BY day_bucket ASC
  `).all(cutoff);
}

/** Cheap liveness check — throws if the DB connection is broken. */
function ping() {
  db.prepare('SELECT 1').get();
}

module.exports = {
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
