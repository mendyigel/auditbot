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

// ── Report helpers ─────────────────────────────────────────────────────────────

const stmts = {
  insertReport: db.prepare(
    `INSERT INTO reports (id, url, storage_key, audit_json, created_at)
     VALUES (@id, @url, @storage_key, @audit_json, @created_at)`
  ),
  getReport: db.prepare(`SELECT * FROM reports WHERE id = ?`),
  deleteReport: db.prepare(`DELETE FROM reports WHERE id = ?`),
  pruneReports: db.prepare(`DELETE FROM reports WHERE created_at < ?`),

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
  getUserByUsername: db.prepare(`SELECT * FROM users WHERE username = ? COLLATE NOCASE`),
  getUserBySessionToken: db.prepare(`SELECT * FROM users WHERE session_token = ?`),
  updateUserSession: db.prepare(`UPDATE users SET session_token = ? WHERE id = ?`),
  linkUserApiKey: db.prepare(`UPDATE users SET api_key = ? WHERE id = ?`),
};

// ── Reports API ────────────────────────────────────────────────────────────────

function saveReportMeta({ id, url, storageKey, audit }) {
  stmts.insertReport.run({
    id,
    url,
    storage_key: storageKey,
    audit_json: JSON.stringify(audit),
    created_at: Date.now(),
  });
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

/** Cheap liveness check — throws if the DB connection is broken. */
function ping() {
  db.prepare('SELECT 1').get();
}

module.exports = {
  ping,
  saveReportMeta,
  getReportMeta,
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
  getUserByUsername,
  getUserBySessionToken,
  updateUserSession,
  linkUserApiKey,
};
