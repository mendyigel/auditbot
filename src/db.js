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
    created_at      INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at);
  CREATE INDEX IF NOT EXISTS idx_subs_customer   ON subscriptions(customer_id);
`);

// ── Report helpers ─────────────────────────────────────────────────────────────

const stmts = {
  insertReport: db.prepare(
    `INSERT INTO reports (id, url, storage_key, audit_json, created_at)
     VALUES (@id, @url, @storage_key, @audit_json, @created_at)`
  ),
  getReport: db.prepare(`SELECT * FROM reports WHERE id = ?`),
  deleteReport: db.prepare(`DELETE FROM reports WHERE id = ?`),
  pruneReports: db.prepare(`DELETE FROM reports WHERE created_at < ?`),

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
  };
}

module.exports = {
  saveReportMeta,
  getReportMeta,
  deleteReportMeta,
  pruneOldReports,
  upsertSubscription,
  getSubscriptionByApiKey,
  getSubscriptionByCustomerId,
  updateSubscriptionStatus,
};
