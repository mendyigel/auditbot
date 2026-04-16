'use strict';

const http = require('http');
const PORT = process.env.PORT || 3000;

// Start a diagnostic server first so we can see errors via HTTP
const errors = [];
let serverModule = null;

function tryRequire(name) {
  try {
    const m = require(name);
    console.log(`[ok] ${name}`);
    return m;
  } catch (err) {
    const msg = `[FAIL] ${name}: ${err.message}`;
    console.error(msg);
    errors.push(msg);
    return null;
  }
}

// Test all core dependencies
tryRequire('@sentry/node');
tryRequire('express');
tryRequire('better-sqlite3');
tryRequire('cheerio');
tryRequire('node-fetch');
tryRequire('stripe');
tryRequire('uuid');
tryRequire('pdfmake');

// Try loading the actual server
try {
  serverModule = require('./src/server');
  console.log('[ok] src/server loaded');
} catch (err) {
  const msg = `[FAIL] src/server: ${err.message}\n${err.stack}`;
  console.error(msg);
  errors.push(msg);

  // If server fails to load, start a diagnostic endpoint
  const diag = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'error', errors, nodeVersion: process.version }));
  });
  diag.listen(PORT, '0.0.0.0', () => {
    console.log(`Diagnostic server on port ${PORT}`);
  });
}
