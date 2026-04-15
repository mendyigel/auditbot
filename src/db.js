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

  CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at);
  CREATE INDEX IF NOT EXISTS idx_subs_customer   ON subscriptions(customer_id);
`);

// Migrate: add columns if they don't exist (safe on first run after upgrade)
try { db.exec(`ALTER TABLE subscriptions ADD COLUMN audit_count  INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE subscriptions ADD COLUMN emails_sent  TEXT    NOT NULL DEFAULT '{}'`); } catch (_) {}
try { db.exec(`ALTER TABLE subscriptions ADD COLUMN pdf_count    INTEGER NOT NULL DEFAULT 0`); } catch (_) {}

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
    ON CONFLICT(api_key) DO UPDATE SET
      email           = excluded.email,
      customer_id     = excluded.customer_id,
      subscription_id = excluded.subscription_id,
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
    apiKey:         row.api_key,
    email:          row.email,
    customerId:     row.customer_id,
    subscriptionId: row.subscription_id,
    status:         row.status,
    createdAt:      row.created_at,
    auditCount:     row.audit_count || 0,
    pdfCount:       row.pdf_count || 0,
    emailsSent:     JSON.parse(row.emails_sent || '{}'),
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
};
