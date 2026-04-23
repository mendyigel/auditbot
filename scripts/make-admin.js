#!/usr/bin/env node
'use strict';

/**
 * Promote or demote a user to/from admin.
 *
 * Usage:
 *   node scripts/make-admin.js <username>            # promote
 *   node scripts/make-admin.js <username> --revoke    # demote
 */

const db = require('../src/db');

const username = process.argv[2];
const revoke = process.argv.includes('--revoke');

if (!username) {
  console.error('Usage: node scripts/make-admin.js <username> [--revoke]');
  process.exit(1);
}

const user = db.getUserByUsername(username);
if (!user) {
  console.error(`User "${username}" not found.`);
  process.exit(1);
}

db.setAdmin(user.id, !revoke);
console.log(`${revoke ? 'Revoked' : 'Granted'} admin access for "${username}" (id: ${user.id})`);
