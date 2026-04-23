'use strict';

/**
 * Admin panel routes for OrbioLabs.
 *
 * All routes require session auth + is_admin flag on the user.
 * Mounted at /admin in server.js.
 */

const express = require('express');
const db = require('./db');
const bcrypt = require('bcryptjs');

const router = express.Router();

// ── Admin auth middleware ────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  const sessionToken = req.cookies && req.cookies.session;
  if (!sessionToken) return res.redirect('/signin');
  const user = db.getUserBySessionToken(sessionToken);
  if (!user) return res.redirect('/signin');
  if (!user.is_admin) return res.status(403).send(errorPage('Access Denied', 'You do not have admin privileges.'));
  req.adminUser = user;
  next();
}

router.use(requireAdmin);

// ── Shared styles ────────────────────────────────────────────────────────────

const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root { --brand: #3b82f6; --brand-dark: #2563eb; --bg: #0f172a; --surface: #1e293b; --surface2: #273548; --border: #334155; --text: #f1f5f9; --muted: #94a3b8; --danger: #f87171; --success: #34d399; --warning: #fbbf24; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
  a { color: var(--brand); text-decoration: none; }
  a:hover { text-decoration: underline; }

  .admin-nav { display: flex; align-items: center; gap: 24px; padding: 16px 32px; background: var(--surface); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .admin-nav .logo { font-size: 1.1rem; font-weight: 800; color: var(--text); letter-spacing: -0.5px; }
  .admin-nav .logo span { color: var(--brand); }
  .admin-nav .nav-links { display: flex; gap: 8px; flex-wrap: wrap; }
  .admin-nav .nav-links a { padding: 6px 14px; border-radius: 6px; font-size: 0.85rem; font-weight: 600; color: var(--muted); transition: all 0.15s; }
  .admin-nav .nav-links a:hover, .admin-nav .nav-links a.active { background: var(--brand); color: #fff; text-decoration: none; }
  .admin-nav .user-info { margin-left: auto; font-size: 0.8rem; color: var(--muted); }

  .container { max-width: 1200px; margin: 0 auto; padding: 32px 24px; }
  h1 { font-size: 1.5rem; font-weight: 800; margin-bottom: 24px; }
  h2 { font-size: 1.15rem; font-weight: 700; margin-bottom: 16px; }

  .stats-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px; }
  .stat-card .label { font-size: 0.8rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
  .stat-card .value { font-size: 1.75rem; font-weight: 800; margin-top: 4px; }
  .stat-card .value.money { color: var(--success); }
  .stat-card .sub { font-size: 0.75rem; color: var(--muted); margin-top: 4px; }

  table { width: 100%; border-collapse: collapse; background: var(--surface); border-radius: 10px; overflow: hidden; }
  thead th { background: var(--surface2); padding: 10px 14px; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); text-align: left; font-weight: 700; }
  tbody td { padding: 10px 14px; border-top: 1px solid var(--border); font-size: 0.875rem; vertical-align: middle; }
  tbody tr:hover { background: var(--surface2); }

  .badge { display: inline-block; padding: 2px 10px; border-radius: 99px; font-size: 0.7rem; font-weight: 700; text-transform: uppercase; }
  .badge-active { background: #065f46; color: #34d399; }
  .badge-trialing { background: #1e3a5f; color: #60a5fa; }
  .badge-cancelled { background: #5c1a1a; color: #f87171; }
  .badge-cancelling { background: #5c4b1a; color: #fbbf24; }
  .badge-past_due { background: #5c1a1a; color: #f87171; }
  .badge-starter { background: #1e3a5f; color: #60a5fa; }
  .badge-pro { background: #3b1f6e; color: #a78bfa; }
  .badge-admin { background: #5c1a3a; color: #f472b6; }

  .search-bar { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; align-items: center; }
  .search-bar input, .search-bar select { padding: 8px 14px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text); font-size: 0.875rem; }
  .search-bar input { min-width: 240px; }
  .search-bar input::placeholder { color: var(--muted); }
  .search-bar button, .btn { padding: 8px 18px; border-radius: 8px; border: none; background: var(--brand); color: #fff; font-size: 0.85rem; font-weight: 600; cursor: pointer; }
  .search-bar button:hover, .btn:hover { background: var(--brand-dark); }
  .btn-sm { padding: 4px 12px; font-size: 0.75rem; }
  .btn-danger { background: #dc2626; }
  .btn-danger:hover { background: #b91c1c; }
  .btn-outline { background: transparent; border: 1px solid var(--border); color: var(--text); }
  .btn-outline:hover { background: var(--surface2); }

  .detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
  .detail-grid .field { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 14px; }
  .detail-grid .field .label { font-size: 0.75rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .detail-grid .field .val { font-size: 0.95rem; font-weight: 600; word-break: break-all; }

  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 24px; }

  .chart-container { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 24px; margin-bottom: 24px; }
  .chart-container h3 { font-size: 0.95rem; font-weight: 700; margin-bottom: 16px; }
  .charts-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 20px; margin-bottom: 32px; }

  .flash { padding: 12px 20px; border-radius: 8px; margin-bottom: 20px; font-size: 0.875rem; font-weight: 600; }
  .flash-success { background: #065f46; color: #34d399; }
  .flash-error { background: #5c1a1a; color: #f87171; }

  @media (max-width: 640px) {
    .detail-grid { grid-template-columns: 1fr; }
    .stats-grid { grid-template-columns: 1fr 1fr; }
    .admin-nav { padding: 12px 16px; gap: 12px; }
    .container { padding: 20px 16px; }
  }
`;

function layout(title, activePage, body, user) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} — OrbioLabs Admin</title>
  <style>${CSS}</style>
</head>
<body>
  <nav class="admin-nav">
    <a href="/" style="text-decoration:none"><div class="logo">Orbio<span>Labs</span></div></a>
    <div class="nav-links">
      <a href="/admin" class="${activePage === 'dashboard' ? 'active' : ''}">Dashboard</a>
      <a href="/admin/subscriptions" class="${activePage === 'subscriptions' ? 'active' : ''}">Subscriptions</a>
      <a href="/admin/users" class="${activePage === 'users' ? 'active' : ''}">Users</a>
      <a href="/admin/charts" class="${activePage === 'charts' ? 'active' : ''}">Charts</a>
    </div>
    <div class="user-info">${user ? user.username : 'Admin'} &middot; <a href="/auth/signout">Sign out</a></div>
  </nav>
  <div class="container">${body}</div>
</body>
</html>`;
}

function errorPage(title, message) {
  return `<!DOCTYPE html>
<html><head><title>${title}</title><style>${CSS}</style></head>
<body><div class="container"><h1>${title}</h1><p style="color:var(--muted)">${message}</p><br><a href="/admin">&larr; Back to admin</a></div></body></html>`;
}

function badge(status) {
  return `<span class="badge badge-${status || 'unknown'}">${status || 'N/A'}</span>`;
}

function formatDate(ts) {
  if (!ts) return 'N/A';
  return new Date(ts).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Phase 1: Dashboard ──────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const stats = db.getAdminStats();
  const recentUsers = db.getAllUsers({ limit: 10 });
  const recentSubs = db.getAllSubscriptions({ limit: 10 });

  const body = `
    <h1>Admin Dashboard</h1>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="label">Total Users</div>
        <div class="value">${stats.totalUsers}</div>
      </div>
      <div class="stat-card">
        <div class="label">Active Subscribers</div>
        <div class="value">${stats.totalSubscribers}</div>
        <div class="sub">${stats.starterCount} Starter &middot; ${stats.proCount} Pro &middot; ${stats.trialingCount} Trial</div>
      </div>
      <div class="stat-card">
        <div class="label">Monthly Recurring Revenue</div>
        <div class="value money">$${stats.mrr}</div>
        <div class="sub">$${stats.starterCount * 9} Starter + $${stats.proCount * 29} Pro</div>
      </div>
      <div class="stat-card">
        <div class="label">Total Audits</div>
        <div class="value">${stats.totalAudits}</div>
      </div>
      <div class="stat-card">
        <div class="label">Reports</div>
        <div class="value">${stats.totalReports}</div>
      </div>
      <div class="stat-card">
        <div class="label">Monitored Sites</div>
        <div class="value">${stats.totalMonitoredSites}</div>
      </div>
      <div class="stat-card">
        <div class="label">Waitlist</div>
        <div class="value">${stats.totalWaitlist}</div>
      </div>
    </div>

    <h2>Recent Users</h2>
    <table>
      <thead><tr><th>Username</th><th>Email</th><th>Plan</th><th>Status</th><th>Joined</th></tr></thead>
      <tbody>
        ${recentUsers.map(u => `<tr>
          <td><a href="/admin/users/${encodeURIComponent(u.id)}">${escHtml(u.username)}</a>${u.is_admin ? ' <span class="badge badge-admin">admin</span>' : ''}</td>
          <td>${escHtml(u.email || u.sub_email || '')}</td>
          <td>${u.plan_tier ? badge(u.plan_tier) : '<span style="color:var(--muted)">--</span>'}</td>
          <td>${u.sub_status ? badge(u.sub_status) : '<span style="color:var(--muted)">No sub</span>'}</td>
          <td>${formatDate(u.created_at)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div style="margin-top:12px"><a href="/admin/users">View all users &rarr;</a></div>

    <h2 style="margin-top:32px">Recent Subscriptions</h2>
    <table>
      <thead><tr><th>Email</th><th>Username</th><th>Plan</th><th>Status</th><th>Audits</th><th>Created</th></tr></thead>
      <tbody>
        ${recentSubs.map(s => `<tr>
          <td><a href="/admin/subscriptions/${encodeURIComponent(s.api_key)}">${escHtml(s.email)}</a></td>
          <td>${escHtml(s.username || '')}</td>
          <td>${badge(s.plan_tier)}</td>
          <td>${badge(s.status)}</td>
          <td>${s.audit_count || 0}</td>
          <td>${formatDate(s.created_at)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div style="margin-top:12px"><a href="/admin/subscriptions">View all subscriptions &rarr;</a></div>
  `;
  res.send(layout('Dashboard', 'dashboard', body, req.adminUser));
});

// ── Phase 2: Subscription Management ────────────────────────────────────────

router.get('/subscriptions', (req, res) => {
  const search = req.query.search || '';
  const status = req.query.status || '';
  const planTier = req.query.plan || '';
  const subs = db.getAllSubscriptions({ search: search || undefined, status: status || undefined, planTier: planTier || undefined });

  const body = `
    <h1>Subscriptions</h1>
    <form class="search-bar" method="GET" action="/admin/subscriptions">
      <input type="text" name="search" placeholder="Search by email or username..." value="${escHtml(search)}" />
      <select name="status">
        <option value="">All statuses</option>
        ${['active','trialing','cancelling','cancelled','past_due','incomplete'].map(s =>
          `<option value="${s}" ${status === s ? 'selected' : ''}>${s}</option>`
        ).join('')}
      </select>
      <select name="plan">
        <option value="">All plans</option>
        <option value="starter" ${planTier === 'starter' ? 'selected' : ''}>Starter</option>
        <option value="pro" ${planTier === 'pro' ? 'selected' : ''}>Pro</option>
      </select>
      <button type="submit">Filter</button>
    </form>
    <table>
      <thead><tr><th>Email</th><th>Username</th><th>Plan</th><th>Status</th><th>Audits</th><th>Monthly</th><th>Created</th><th></th></tr></thead>
      <tbody>
        ${subs.length === 0 ? '<tr><td colspan="8" style="text-align:center;color:var(--muted)">No subscriptions found</td></tr>' : ''}
        ${subs.map(s => `<tr>
          <td>${escHtml(s.email)}</td>
          <td>${escHtml(s.username || '')}</td>
          <td>${badge(s.plan_tier)}</td>
          <td>${badge(s.status)}</td>
          <td>${s.audit_count || 0}</td>
          <td>${s.monthly_audit_count || 0}</td>
          <td>${formatDate(s.created_at)}</td>
          <td><a href="/admin/subscriptions/${encodeURIComponent(s.api_key)}" class="btn btn-sm btn-outline">View</a></td>
        </tr>`).join('')}
      </tbody>
    </table>
  `;
  res.send(layout('Subscriptions', 'subscriptions', body, req.adminUser));
});

router.get('/subscriptions/:apiKey', (req, res) => {
  const sub = db.getSubscriptionByApiKey(req.params.apiKey);
  if (!sub) return res.status(404).send(errorPage('Not Found', 'Subscription not found.'));

  const flash = req.query.msg ? `<div class="flash flash-success">${escHtml(req.query.msg)}</div>` : '';

  const body = `
    <h1>Subscription Detail</h1>
    ${flash}
    <div class="detail-grid">
      <div class="field"><div class="label">Email</div><div class="val">${escHtml(sub.email)}</div></div>
      <div class="field"><div class="label">API Key</div><div class="val" style="font-size:0.75rem">${escHtml(sub.apiKey)}</div></div>
      <div class="field"><div class="label">Plan</div><div class="val">${badge(sub.planTier)}</div></div>
      <div class="field"><div class="label">Status</div><div class="val">${badge(sub.status)}</div></div>
      <div class="field"><div class="label">Stripe Customer</div><div class="val">${escHtml(sub.customerId)}</div></div>
      <div class="field"><div class="label">Stripe Subscription</div><div class="val">${escHtml(sub.subscriptionId || 'N/A')}</div></div>
      <div class="field"><div class="label">Total Audits</div><div class="val">${sub.auditCount}</div></div>
      <div class="field"><div class="label">Monthly Audits</div><div class="val">${sub.monthlyAuditCount}</div></div>
      <div class="field"><div class="label">PDF Exports</div><div class="val">${sub.pdfCount}</div></div>
      <div class="field"><div class="label">Created</div><div class="val">${formatDate(sub.createdAt)}</div></div>
    </div>

    <h2>Actions</h2>
    <div class="actions">
      <form method="POST" action="/admin/subscriptions/${encodeURIComponent(sub.apiKey)}/status" style="display:inline">
        <select name="status" style="padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:0.85rem">
          ${['active','trialing','cancelling','cancelled','past_due','incomplete'].map(s =>
            `<option value="${s}" ${sub.status === s ? 'selected' : ''}>${s}</option>`
          ).join('')}
        </select>
        <button type="submit" class="btn btn-sm">Change Status</button>
      </form>

      <form method="POST" action="/admin/subscriptions/${encodeURIComponent(sub.apiKey)}/plan" style="display:inline">
        <select name="plan_tier" style="padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:0.85rem">
          <option value="starter" ${sub.planTier === 'starter' ? 'selected' : ''}>Starter</option>
          <option value="pro" ${sub.planTier === 'pro' ? 'selected' : ''}>Pro</option>
        </select>
        <button type="submit" class="btn btn-sm">Change Plan</button>
      </form>

      <form method="POST" action="/admin/subscriptions/${encodeURIComponent(sub.apiKey)}/reset-audits" style="display:inline">
        <button type="submit" class="btn btn-sm btn-outline">Reset Monthly Audits</button>
      </form>
    </div>

    <a href="/admin/subscriptions">&larr; Back to subscriptions</a>
  `;
  res.send(layout('Subscription Detail', 'subscriptions', body, req.adminUser));
});

router.post('/subscriptions/:apiKey/status', (req, res) => {
  const { status } = req.body;
  if (status) db.updateSubscriptionFields(req.params.apiKey, { status });
  res.redirect(`/admin/subscriptions/${encodeURIComponent(req.params.apiKey)}?msg=Status+updated`);
});

router.post('/subscriptions/:apiKey/plan', (req, res) => {
  const { plan_tier } = req.body;
  if (plan_tier) db.updateSubscriptionFields(req.params.apiKey, { plan_tier });
  res.redirect(`/admin/subscriptions/${encodeURIComponent(req.params.apiKey)}?msg=Plan+updated`);
});

router.post('/subscriptions/:apiKey/reset-audits', (req, res) => {
  db.updateSubscriptionFields(req.params.apiKey, { monthly_audit_count: 0 });
  res.redirect(`/admin/subscriptions/${encodeURIComponent(req.params.apiKey)}?msg=Monthly+audit+count+reset`);
});

// ── Phase 3: User Management ────────────────────────────────────────────────

router.get('/users', (req, res) => {
  const search = req.query.search || '';
  const users = db.getAllUsers({ search: search || undefined });

  const body = `
    <h1>Users</h1>
    <form class="search-bar" method="GET" action="/admin/users">
      <input type="text" name="search" placeholder="Search by username or email..." value="${escHtml(search)}" />
      <button type="submit">Search</button>
    </form>
    <table>
      <thead><tr><th>Username</th><th>Email</th><th>Admin</th><th>Plan</th><th>Status</th><th>Audits</th><th>Joined</th><th></th></tr></thead>
      <tbody>
        ${users.length === 0 ? '<tr><td colspan="8" style="text-align:center;color:var(--muted)">No users found</td></tr>' : ''}
        ${users.map(u => `<tr>
          <td>${escHtml(u.username)}${u.is_admin ? ' <span class="badge badge-admin">admin</span>' : ''}</td>
          <td>${escHtml(u.email || u.sub_email || '')}</td>
          <td>${u.is_admin ? 'Yes' : 'No'}</td>
          <td>${u.plan_tier ? badge(u.plan_tier) : '--'}</td>
          <td>${u.sub_status ? badge(u.sub_status) : '<span style="color:var(--muted)">No sub</span>'}</td>
          <td>${u.total_audits || 0}</td>
          <td>${formatDate(u.created_at)}</td>
          <td><a href="/admin/users/${encodeURIComponent(u.id)}" class="btn btn-sm btn-outline">View</a></td>
        </tr>`).join('')}
      </tbody>
    </table>
  `;
  res.send(layout('Users', 'users', body, req.adminUser));
});

router.get('/users/:id', (req, res) => {
  const user = db.getUserById(req.params.id);
  if (!user) return res.status(404).send(errorPage('Not Found', 'User not found.'));

  const sub = user.api_key ? db.getSubscriptionByApiKey(user.api_key) : null;
  const reports = db.getReportsByUser(user.id);
  const flash = req.query.msg ? `<div class="flash flash-success">${escHtml(req.query.msg)}</div>` : '';

  const body = `
    <h1>User: ${escHtml(user.username)} ${user.is_admin ? '<span class="badge badge-admin">admin</span>' : ''}</h1>
    ${flash}
    <div class="detail-grid">
      <div class="field"><div class="label">User ID</div><div class="val" style="font-size:0.75rem">${escHtml(user.id)}</div></div>
      <div class="field"><div class="label">Username</div><div class="val">${escHtml(user.username)}</div></div>
      <div class="field"><div class="label">Email</div><div class="val">${escHtml(user.email || 'N/A')}</div></div>
      <div class="field"><div class="label">API Key</div><div class="val" style="font-size:0.75rem">${escHtml(user.api_key || 'None')}</div></div>
      <div class="field"><div class="label">Joined</div><div class="val">${formatDate(user.created_at)}</div></div>
      <div class="field"><div class="label">Admin</div><div class="val">${user.is_admin ? 'Yes' : 'No'}</div></div>
      ${sub ? `
        <div class="field"><div class="label">Plan</div><div class="val">${badge(sub.planTier)}</div></div>
        <div class="field"><div class="label">Sub Status</div><div class="val">${badge(sub.status)}</div></div>
      ` : ''}
    </div>

    <h2>Actions</h2>
    <div class="actions">
      <form method="POST" action="/admin/users/${encodeURIComponent(user.id)}/toggle-admin" style="display:inline">
        <button type="submit" class="btn btn-sm ${user.is_admin ? 'btn-danger' : ''}">${user.is_admin ? 'Revoke Admin' : 'Make Admin'}</button>
      </form>
      <form method="POST" action="/admin/users/${encodeURIComponent(user.id)}/reset-password" style="display:inline">
        <input type="password" name="new_password" placeholder="New password" required style="padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:0.85rem;width:180px" />
        <button type="submit" class="btn btn-sm btn-outline">Reset Password</button>
      </form>
    </div>

    ${sub ? `<div style="margin-bottom:24px"><a href="/admin/subscriptions/${encodeURIComponent(user.api_key)}">View subscription &rarr;</a></div>` : ''}

    <h2>Audit Reports (${reports.length})</h2>
    ${reports.length === 0 ? '<p style="color:var(--muted)">No reports yet.</p>' : `
    <table>
      <thead><tr><th>URL</th><th>Date</th><th></th></tr></thead>
      <tbody>
        ${reports.map(r => `<tr>
          <td>${escHtml(r.url)}</td>
          <td>${formatDate(r.createdAt)}</td>
          <td><a href="/report/${encodeURIComponent(r.id)}" target="_blank" class="btn btn-sm btn-outline">View</a></td>
        </tr>`).join('')}
      </tbody>
    </table>`}

    <div style="margin-top:24px"><a href="/admin/users">&larr; Back to users</a></div>
  `;
  res.send(layout('User Detail', 'users', body, req.adminUser));
});

router.post('/users/:id/toggle-admin', (req, res) => {
  const user = db.getUserById(req.params.id);
  if (!user) return res.redirect('/admin/users');
  db.setAdmin(user.id, !user.is_admin);
  res.redirect(`/admin/users/${encodeURIComponent(user.id)}?msg=Admin+status+updated`);
});

router.post('/users/:id/reset-password', async (req, res) => {
  const { new_password } = req.body;
  if (!new_password || new_password.length < 6) {
    return res.redirect(`/admin/users/${encodeURIComponent(req.params.id)}?msg=Password+must+be+at+least+6+characters`);
  }
  const hash = await bcrypt.hash(new_password, 10);
  db.updatePassword(req.params.id, hash);
  res.redirect(`/admin/users/${encodeURIComponent(req.params.id)}?msg=Password+reset+successfully`);
});

// ── Phase 4: Charts & Advanced Metrics ──────────────────────────────────────

router.get('/charts', (req, res) => {
  const days = parseInt(req.query.days, 10) || 30;
  const stats = db.getAdminStats();

  const body = `
    <h1>Charts & Metrics</h1>

    <div class="search-bar" style="margin-bottom:24px">
      <form method="GET" action="/admin/charts" style="display:flex;gap:8px;align-items:center">
        <label style="font-size:0.85rem;color:var(--muted)">Time range:</label>
        <select name="days" style="padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:0.85rem">
          ${[7,14,30,60,90].map(d => `<option value="${d}" ${days === d ? 'selected' : ''}>${d} days</option>`).join('')}
        </select>
        <button type="submit" class="btn btn-sm">Update</button>
      </form>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="label">MRR</div>
        <div class="value money">$${stats.mrr}</div>
      </div>
      <div class="stat-card">
        <div class="label">Subscribers</div>
        <div class="value">${stats.totalSubscribers}</div>
      </div>
      <div class="stat-card">
        <div class="label">Total Users</div>
        <div class="value">${stats.totalUsers}</div>
      </div>
      <div class="stat-card">
        <div class="label">Total Audits</div>
        <div class="value">${stats.totalAudits}</div>
      </div>
    </div>

    <div class="charts-grid">
      <div class="chart-container">
        <h3>User Signups</h3>
        <canvas id="signupsChart" height="220"></canvas>
      </div>
      <div class="chart-container">
        <h3>Audit Reports</h3>
        <canvas id="auditsChart" height="220"></canvas>
      </div>
      <div class="chart-container">
        <h3>Revenue (New Subscriptions)</h3>
        <canvas id="revenueChart" height="220"></canvas>
      </div>
      <div class="chart-container">
        <h3>Plan Distribution</h3>
        <canvas id="planChart" height="220"></canvas>
      </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
    <script>
      fetch('/admin/api/charts?days=${days}')
        .then(r => r.json())
        .then(data => {
          const chartOpts = {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: {
              x: { ticks: { color: '#94a3b8', maxTicksLimit: 10 }, grid: { color: '#334155' } },
              y: { ticks: { color: '#94a3b8' }, grid: { color: '#334155' }, beginAtZero: true }
            }
          };

          new Chart(document.getElementById('signupsChart'), {
            type: 'bar',
            data: { labels: data.signups.labels, datasets: [{ data: data.signups.values, backgroundColor: '#3b82f6', borderRadius: 4 }] },
            options: chartOpts
          });

          new Chart(document.getElementById('auditsChart'), {
            type: 'bar',
            data: { labels: data.audits.labels, datasets: [{ data: data.audits.values, backgroundColor: '#8b5cf6', borderRadius: 4 }] },
            options: chartOpts
          });

          new Chart(document.getElementById('revenueChart'), {
            type: 'line',
            data: { labels: data.revenue.labels, datasets: [{ data: data.revenue.values, borderColor: '#34d399', backgroundColor: 'rgba(52,211,153,0.1)', fill: true, tension: 0.3 }] },
            options: { ...chartOpts, scales: { ...chartOpts.scales, y: { ...chartOpts.scales.y, ticks: { ...chartOpts.scales.y.ticks, callback: v => '$' + v } } } }
          });

          new Chart(document.getElementById('planChart'), {
            type: 'doughnut',
            data: {
              labels: ['Starter', 'Pro', 'Trial'],
              datasets: [{ data: [data.plans.starter, data.plans.pro, data.plans.trialing], backgroundColor: ['#60a5fa', '#a78bfa', '#fbbf24'] }]
            },
            options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { color: '#f1f5f9' } } } }
          });
        });
    </script>
  `;
  res.send(layout('Charts & Metrics', 'charts', body, req.adminUser));
});

// JSON API for chart data
router.get('/api/charts', (req, res) => {
  const days = parseInt(req.query.days, 10) || 30;

  const signupsRaw = db.getTimeSeriesSignups(days);
  const auditsRaw = db.getTimeSeriesAudits(days);
  const revenueRaw = db.getTimeSeriesRevenue(days);
  const stats = db.getAdminStats();

  // Build day-by-day labels from (today - days) to today
  const now = Date.now();
  const dayMs = 86400000;
  const todayBucket = Math.floor(now / dayMs);
  const startBucket = todayBucket - days;

  function fillSeries(raw, valueKey = 'cnt') {
    const map = {};
    for (const row of raw) map[row.day_bucket] = row[valueKey] || 0;
    const labels = [];
    const values = [];
    for (let b = startBucket; b <= todayBucket; b++) {
      const d = new Date(b * dayMs);
      labels.push(`${d.getMonth() + 1}/${d.getDate()}`);
      values.push(map[b] || 0);
    }
    return { labels, values };
  }

  res.json({
    signups: fillSeries(signupsRaw),
    audits: fillSeries(auditsRaw),
    revenue: fillSeries(revenueRaw, 'revenue'),
    plans: { starter: stats.starterCount, pro: stats.proCount, trialing: stats.trialingCount },
  });
});

module.exports = router;
