'use strict';

/**
 * Report storage layer — S3 or local filesystem fallback.
 *
 * S3 is used when all three env vars are set:
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_BUCKET
 *
 * Otherwise reports are stored under ./data/reports/<id>.html
 *
 * Public API:
 *   saveReport(id, html)  → storageKey (opaque string, pass to getReport)
 *   getReport(storageKey) → html string | null
 *   deleteReport(storageKey)
 */

const path = require('path');
const fs = require('fs');

const USE_S3 = !!(
  process.env.AWS_ACCESS_KEY_ID &&
  process.env.AWS_SECRET_ACCESS_KEY &&
  process.env.S3_BUCKET
);

const S3_PREFIX = process.env.S3_KEY_PREFIX || 'reports/';
const LOCAL_DIR = process.env.REPORT_DIR || path.join(__dirname, '..', 'data', 'reports');

if (!USE_S3 && !fs.existsSync(LOCAL_DIR)) {
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
}

// Lazy-load S3 client
let _s3 = null;
function getS3() {
  if (!_s3) {
    const { S3Client } = require('@aws-sdk/client-s3');
    _s3 = new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return _s3;
}

// ── S3 helpers ─────────────────────────────────────────────────────────────────

async function s3Put(key, html) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await getS3().send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
    Body: html,
    ContentType: 'text/html; charset=utf-8',
    CacheControl: 'no-store',
  }));
}

async function s3Get(key) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  try {
    const resp = await getS3().send(new GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
    }));
    // Stream → string
    const chunks = [];
    for await (const chunk of resp.Body) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf-8');
  } catch (err) {
    if (err.name === 'NoSuchKey') return null;
    throw err;
  }
}

async function s3Delete(key) {
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  await getS3().send(new DeleteObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
  }));
}

// ── Local helpers ──────────────────────────────────────────────────────────────

async function localPut(key, html) {
  const filePath = path.join(LOCAL_DIR, key);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, html, 'utf-8');
}

async function localGet(key) {
  const filePath = path.join(LOCAL_DIR, key);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

async function localDelete(key) {
  const filePath = path.join(LOCAL_DIR, key);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Save an HTML report.
 * @param {string} id  Report UUID
 * @param {string} html  Full HTML string
 * @returns {string} storageKey to pass to getReport / deleteReport
 */
async function saveReport(id, html) {
  const key = USE_S3 ? `${S3_PREFIX}${id}.html` : `${id}.html`;
  if (USE_S3) {
    await s3Put(key, html);
  } else {
    await localPut(key, html);
  }
  return key;
}

/**
 * Retrieve a stored HTML report.
 * @param {string} storageKey  Returned by saveReport
 * @returns {string|null}
 */
async function getReport(storageKey) {
  if (USE_S3) return s3Get(storageKey);
  return localGet(storageKey);
}

/**
 * Delete a stored HTML report.
 */
async function deleteReport(storageKey) {
  if (USE_S3) return s3Delete(storageKey);
  return localDelete(storageKey);
}

module.exports = { saveReport, getReport, deleteReport, USE_S3 };
