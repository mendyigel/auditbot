'use strict';

/**
 * Support ticket routes for OrbioLabs.
 *
 * Public:
 *   POST /api/support/tickets  — create a new ticket (widget)
 *   GET  /api/support/tickets/:ticketNumber — lookup by ticket number (user)
 *
 * Admin (requires session + is_admin):
 *   GET    /api/support/tickets       — list/filter tickets
 *   PATCH  /api/support/tickets/:id   — update status, assignee, notes
 *   GET    /api/support/tickets/stats  — dashboard metrics
 *
 * Pages:
 *   GET /support                — support widget page (standalone)
 *   GET /support/admin          — admin dashboard (HTML)
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const emailService = require('./email');

const router = express.Router();

// ── Rate limiting (in-memory, per IP) ────────────────────────────────────────

const rateLimitMap = new Map();
const RATE_LIMIT = 5; // max tickets per IP per hour
const RATE_WINDOW_MS = 60 * 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

// Clean up stale rate-limit entries every hour
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_WINDOW_MS) rateLimitMap.delete(ip);
  }
}, RATE_WINDOW_MS);

// ── Admin auth middleware ────────────────────────────────────────────────────

async function requireAdmin(req, res, next) {
  const sessionToken = req.cookies && req.cookies.session;
  if (!sessionToken) return res.status(401).json({ error: 'Authentication required' });
  const user = await db.getUserBySessionToken(sessionToken);
  if (!user) return res.status(401).json({ error: 'Invalid session' });
  if (!user.is_admin) return res.status(403).json({ error: 'Admin access required' });
  req.adminUser = user;
  next();
}

// ── Resolve current user from session (optional) ────────────────────────────

async function resolveUser(req) {
  const sessionToken = req.cookies && req.cookies.session;
  if (!sessionToken) return null;
  return (await db.getUserBySessionToken(sessionToken)) || null;
}

// ── Valid categories ─────────────────────────────────────────────────────────

const VALID_CATEGORIES = ['bug', 'feature', 'account', 'billing', 'other'];
const VALID_PRIORITIES = ['low', 'medium', 'high'];
const VALID_STATUSES = ['new', 'open', 'in_progress', 'resolved', 'closed'];

// ── Public: Create ticket ────────────────────────────────────────────────────

router.post('/api/support/tickets', async (req, res) => {
  // Rate limit
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  // Honeypot — if this hidden field is filled, it's a bot
  if (req.body._website) {
    return res.json({ ok: true, ticketNumber: 'SUP-0000' }); // silent reject
  }

  const { category, subject, description, email, priority } = req.body;

  // Validation
  if (!subject || typeof subject !== 'string' || subject.trim().length < 2) {
    return res.status(400).json({ error: 'Subject is required (min 2 characters)' });
  }
  if (!description || typeof description !== 'string' || description.trim().length < 10) {
    return res.status(400).json({ error: 'Description is required (min 10 characters)' });
  }

  const user = await resolveUser(req);
  const ticketEmail = email || (user && user.email) || '';
  if (!ticketEmail || !ticketEmail.includes('@')) {
    return res.status(400).json({ error: 'Valid email is required' });
  }

  const validCategory = VALID_CATEGORIES.includes(category) ? category : 'other';
  const validPriority = VALID_PRIORITIES.includes(priority) ? priority : 'medium';

  try {
    const ticket = await db.createSupportTicket({
      id: uuidv4(),
      email: ticketEmail.trim().toLowerCase(),
      userId: user ? user.id : null,
      category: validCategory,
      subject: subject.trim(),
      description: description.trim(),
      priority: validPriority,
    });

    // Send confirmation email to user
    emailService.sendSupportConfirmation(ticketEmail, ticket.ticketNumber, ticket.subject).catch(err => {
      console.error('[support] Failed to send confirmation email:', err.message);
    });

    // Send notification to CEO/admin
    emailService.sendSupportNewTicketNotification(ticket).catch(err => {
      console.error('[support] Failed to send admin notification:', err.message);
    });

    console.log(`[support] New ticket ${ticket.ticketNumber}: "${subject}" from ${ticketEmail}`);

    return res.status(201).json({
      ok: true,
      ticketNumber: ticket.ticketNumber,
      message: 'We got it. Expect a reply within 24 hours.',
    });
  } catch (err) {
    console.error('[support] Create ticket error:', err.message);
    return res.status(500).json({ error: 'Failed to create ticket' });
  }
});

// ── Public: Lookup ticket by number ──────────────────────────────────────────

router.get('/api/support/tickets/lookup/:ticketNumber', async (req, res) => {
  const ticket = await db.getSupportTicketByNumber(req.params.ticketNumber);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  // Only return safe public fields
  return res.json({
    ticketNumber: ticket.ticketNumber,
    subject: ticket.subject,
    category: ticket.category,
    status: ticket.status,
    priority: ticket.priority,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  });
});

// ── Admin: Stats ─────────────────────────────────────────────────────────────

router.get('/api/support/tickets/stats', requireAdmin, async (req, res) => {
  const stats = await db.getSupportTicketStats();
  return res.json(stats);
});

// ── Admin: List tickets ──────────────────────────────────────────────────────

router.get('/api/support/tickets', requireAdmin, async (req, res) => {
  const { status, limit = '50', offset = '0' } = req.query;
  const tickets = await db.listSupportTickets({
    status: VALID_STATUSES.includes(status) ? status : undefined,
    limit: Math.min(parseInt(limit, 10) || 50, 100),
    offset: parseInt(offset, 10) || 0,
  });
  return res.json({ tickets });
});

// ── Admin: Get single ticket ─────────────────────────────────────────────────

router.get('/api/support/tickets/:id', requireAdmin, async (req, res) => {
  const ticket = await db.getSupportTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  return res.json(ticket);
});

// ── Admin: Update ticket ─────────────────────────────────────────────────────

router.patch('/api/support/tickets/:id', requireAdmin, async (req, res) => {
  const { status, assignee, internalNote, priority } = req.body;

  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
  }
  if (priority && !VALID_PRIORITIES.includes(priority)) {
    return res.status(400).json({ error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(', ')}` });
  }

  const ticket = await db.updateSupportTicket(req.params.id, { status, assignee, internalNote, priority });
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  // If status changed, email the user
  if (status && ticket.email) {
    emailService.sendSupportStatusUpdate(ticket.email, ticket.ticketNumber, status).catch(err => {
      console.error('[support] Failed to send status update email:', err.message);
    });
  }

  return res.json(ticket);
});

// ── Support widget page ──────────────────────────────────────────────────────

router.get('/support', async (req, res) => {
  const user = await resolveUser(req);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(generateWidgetPage(user));
});

// ── Widget script (embeddable) ───────────────────────────────────────────────

router.get('/support/widget.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(generateWidgetScript());
});

// ── Admin dashboard page ─────────────────────────────────────────────────────

router.get('/support/admin', async (req, res) => {
  const sessionToken = req.cookies && req.cookies.session;
  if (!sessionToken) return res.redirect('/signin');
  const user = await db.getUserBySessionToken(sessionToken);
  if (!user || !user.is_admin) return res.redirect('/signin');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(generateAdminDashboard());
});

// ── Widget page generator ────────────────────────────────────────────────────

function generateWidgetPage(user) {
  const email = user ? (user.email || '') : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Support — OrbioLabs</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root { --brand: #3b82f6; --brand-dark: #2563eb; --bg: #0f172a; --surface: #1e293b; --border: #334155; --text: #f1f5f9; --muted: #94a3b8; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; }
    nav { display: flex; align-items: center; justify-content: space-between; padding: 20px 40px; border-bottom: 1px solid var(--border); }
    .logo { font-size: 1.25rem; font-weight: 800; letter-spacing: -0.5px; color: var(--text); }
    .logo span { color: var(--brand); }
    .container { max-width: 600px; margin: 48px auto; padding: 0 24px; flex: 1; }
    h1 { font-size: 1.75rem; font-weight: 800; margin-bottom: 8px; }
    .subtitle { color: var(--muted); margin-bottom: 32px; }
    .form-group { margin-bottom: 20px; }
    label { display: block; font-size: 0.85rem; font-weight: 600; color: var(--muted); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
    input, select, textarea { width: 100%; padding: 10px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-size: 0.95rem; font-family: inherit; outline: none; transition: border-color 0.15s; }
    input:focus, select:focus, textarea:focus { border-color: var(--brand); }
    textarea { min-height: 120px; resize: vertical; }
    select { cursor: pointer; }
    .honeypot { position: absolute; left: -9999px; }
    .btn { display: inline-block; background: var(--brand); color: #fff; font-weight: 600; font-size: 1rem; padding: 12px 28px; border: none; border-radius: 8px; cursor: pointer; transition: background 0.15s; width: 100%; }
    .btn:hover { background: var(--brand-dark); }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .success-msg { text-align: center; padding: 48px 0; }
    .success-msg .check { font-size: 3rem; margin-bottom: 16px; }
    .success-msg h2 { font-size: 1.5rem; font-weight: 700; margin-bottom: 8px; }
    .success-msg p { color: var(--muted); }
    .success-msg .ticket-num { display: inline-block; background: var(--surface); padding: 8px 16px; border-radius: 6px; font-family: monospace; font-size: 1.1rem; margin-top: 12px; }
    .error-msg { background: #7f1d1d33; border: 1px solid #f87171; color: #f87171; padding: 10px 14px; border-radius: 8px; margin-bottom: 16px; font-size: 0.9rem; display: none; }
    .priority-row { display: flex; gap: 12px; }
    .priority-row label { flex: 1; display: flex; align-items: center; gap: 6px; padding: 8px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; text-transform: none; letter-spacing: 0; font-size: 0.9rem; color: var(--text); }
    .priority-row input[type="radio"] { width: auto; accent-color: var(--brand); }
  </style>
</head>
<body>
  <nav>
    <a href="/" class="logo">Orbio<span>Labs</span></a>
    <a href="/dashboard" style="color:var(--muted);font-size:0.875rem;">Dashboard</a>
  </nav>

  <div class="container">
    <div id="form-view">
      <h1>How can we help?</h1>
      <p class="subtitle">Submit a support request and we'll get back to you within 24 hours.</p>
      <div id="error" class="error-msg"></div>
      <form id="support-form">
        <div class="honeypot"><input type="text" name="_website" tabindex="-1" autocomplete="off"></div>
        <div class="form-group">
          <label for="category">Category</label>
          <select id="category" name="category">
            <option value="bug">Bug report</option>
            <option value="feature">Feature request</option>
            <option value="account">Account issue</option>
            <option value="billing">Billing</option>
            <option value="other" selected>Other</option>
          </select>
        </div>
        <div class="form-group">
          <label for="subject">Subject</label>
          <input type="text" id="subject" name="subject" placeholder="What's going on?" required>
        </div>
        <div class="form-group">
          <label for="description">Description</label>
          <textarea id="description" name="description" placeholder="Tell us more so we can help faster..." required></textarea>
        </div>
        <div class="form-group">
          <label for="email">Email</label>
          <input type="email" id="email" name="email" placeholder="you@example.com" value="${email}" required>
        </div>
        <div class="form-group">
          <label>Priority</label>
          <div class="priority-row">
            <label><input type="radio" name="priority" value="low"> Low</label>
            <label><input type="radio" name="priority" value="medium" checked> Medium</label>
            <label><input type="radio" name="priority" value="high"> High</label>
          </div>
        </div>
        <button type="submit" class="btn" id="submit-btn">Submit Request</button>
      </form>
    </div>
    <div id="success-view" style="display:none;">
      <div class="success-msg">
        <div class="check">&#10003;</div>
        <h2>We got it!</h2>
        <p>Expect a reply within 24 hours.</p>
        <div class="ticket-num" id="ticket-num"></div>
        <p style="margin-top:24px;"><a href="/support" style="color:var(--brand);">Submit another request</a> &middot; <a href="/dashboard" style="color:var(--brand);">Back to Dashboard</a></p>
      </div>
    </div>
  </div>

  <script>
    const form = document.getElementById('support-form');
    const errorEl = document.getElementById('error');
    const submitBtn = document.getElementById('submit-btn');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.style.display = 'none';
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting...';
      const fd = new FormData(form);
      const body = Object.fromEntries(fd.entries());
      try {
        const res = await fetch('/api/support/tickets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Something went wrong');
        document.getElementById('ticket-num').textContent = data.ticketNumber;
        document.getElementById('form-view').style.display = 'none';
        document.getElementById('success-view').style.display = 'block';
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Request';
      }
    });
  </script>
</body>
</html>`;
}

// ── Embeddable widget script ─────────────────────────────────────────────────

function generateWidgetScript() {
  return `(function() {
  if (document.getElementById('orbio-support-widget')) return;

  var APP_URL = window.ORBIO_SUPPORT_URL || '';

  var style = document.createElement('style');
  style.textContent = \`
    #orbio-support-btn { position: fixed; bottom: 24px; right: 24px; z-index: 99999; width: 56px; height: 56px; border-radius: 50%; background: #3b82f6; border: none; cursor: pointer; box-shadow: 0 4px 16px rgba(59,130,246,0.4); display: flex; align-items: center; justify-content: center; transition: transform 0.2s, box-shadow 0.2s; }
    #orbio-support-btn:hover { transform: scale(1.08); box-shadow: 0 6px 24px rgba(59,130,246,0.5); }
    #orbio-support-btn svg { width: 24px; height: 24px; fill: #fff; }
    #orbio-support-panel { position: fixed; bottom: 92px; right: 24px; z-index: 99999; width: 380px; max-height: 520px; background: #1e293b; border: 1px solid #334155; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.4); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #f1f5f9; display: none; flex-direction: column; overflow: hidden; }
    #orbio-support-panel.open { display: flex; }
    .orbio-sp-header { background: #0f172a; padding: 16px 20px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #334155; }
    .orbio-sp-header h3 { font-size: 1rem; font-weight: 700; margin: 0; }
    .orbio-sp-close { background: none; border: none; color: #94a3b8; cursor: pointer; font-size: 1.25rem; padding: 0; line-height: 1; }
    .orbio-sp-body { padding: 20px; overflow-y: auto; flex: 1; }
    .orbio-sp-body .fg { margin-bottom: 14px; }
    .orbio-sp-body label { display: block; font-size: 0.75rem; font-weight: 600; color: #94a3b8; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
    .orbio-sp-body input, .orbio-sp-body select, .orbio-sp-body textarea { width: 100%; padding: 8px 12px; background: #0f172a; border: 1px solid #334155; border-radius: 6px; color: #f1f5f9; font-size: 0.875rem; font-family: inherit; outline: none; }
    .orbio-sp-body input:focus, .orbio-sp-body select:focus, .orbio-sp-body textarea:focus { border-color: #3b82f6; }
    .orbio-sp-body textarea { min-height: 80px; resize: vertical; }
    .orbio-sp-body .hp { position: absolute; left: -9999px; }
    .orbio-sp-submit { width: 100%; padding: 10px; background: #3b82f6; color: #fff; border: none; border-radius: 6px; font-weight: 600; font-size: 0.875rem; cursor: pointer; transition: background 0.15s; }
    .orbio-sp-submit:hover { background: #2563eb; }
    .orbio-sp-submit:disabled { opacity: 0.6; cursor: not-allowed; }
    .orbio-sp-error { background: rgba(248,113,113,0.1); border: 1px solid #f87171; color: #f87171; padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; font-size: 0.8rem; display: none; }
    .orbio-sp-success { text-align: center; padding: 32px 16px; }
    .orbio-sp-success .tick { font-size: 2.5rem; margin-bottom: 12px; color: #34d399; }
    .orbio-sp-success h3 { margin-bottom: 6px; }
    .orbio-sp-success p { color: #94a3b8; font-size: 0.85rem; }
    .orbio-sp-success .tnum { display: inline-block; background: #0f172a; padding: 6px 12px; border-radius: 4px; font-family: monospace; margin-top: 8px; }
    @media (max-width: 480px) {
      #orbio-support-panel { right: 0; bottom: 0; width: 100%; max-height: 90vh; border-radius: 12px 12px 0 0; }
      #orbio-support-btn { bottom: 16px; right: 16px; }
    }
  \`;
  document.head.appendChild(style);

  var btn = document.createElement('button');
  btn.id = 'orbio-support-btn';
  btn.setAttribute('aria-label', 'Open support');
  btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/><path d="M7 9h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2z"/></svg>';
  document.body.appendChild(btn);

  var panel = document.createElement('div');
  panel.id = 'orbio-support-panel';
  panel.innerHTML = \`
    <div class="orbio-sp-header">
      <h3>Support</h3>
      <button class="orbio-sp-close" aria-label="Close">&times;</button>
    </div>
    <div class="orbio-sp-body" id="orbio-sp-form-view">
      <div class="orbio-sp-error" id="orbio-sp-error"></div>
      <form id="orbio-sp-form">
        <div class="hp"><input type="text" name="_website" tabindex="-1" autocomplete="off"></div>
        <div class="fg">
          <label>Category</label>
          <select name="category"><option value="bug">Bug report</option><option value="feature">Feature request</option><option value="account">Account issue</option><option value="billing">Billing</option><option value="other" selected>Other</option></select>
        </div>
        <div class="fg">
          <label>Subject</label>
          <input type="text" name="subject" placeholder="What's going on?" required>
        </div>
        <div class="fg">
          <label>Description</label>
          <textarea name="description" placeholder="Tell us more..." required></textarea>
        </div>
        <div class="fg">
          <label>Email</label>
          <input type="email" name="email" placeholder="you@example.com" required>
        </div>
        <button type="submit" class="orbio-sp-submit" id="orbio-sp-submit">Submit Request</button>
      </form>
    </div>
    <div class="orbio-sp-body orbio-sp-success" id="orbio-sp-success" style="display:none;">
      <div class="tick">&#10003;</div>
      <h3>We got it!</h3>
      <p>Expect a reply within 24 hours.</p>
      <div class="tnum" id="orbio-sp-tnum"></div>
    </div>
  \`;
  document.body.appendChild(panel);

  btn.addEventListener('click', function() {
    panel.classList.toggle('open');
  });

  panel.querySelector('.orbio-sp-close').addEventListener('click', function() {
    panel.classList.remove('open');
  });

  var spForm = document.getElementById('orbio-sp-form');
  var spError = document.getElementById('orbio-sp-error');
  var spSubmit = document.getElementById('orbio-sp-submit');

  spForm.addEventListener('submit', function(e) {
    e.preventDefault();
    spError.style.display = 'none';
    spSubmit.disabled = true;
    spSubmit.textContent = 'Submitting...';
    var fd = new FormData(spForm);
    var body = {};
    fd.forEach(function(v, k) { body[k] = v; });
    fetch(APP_URL + '/api/support/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
      .then(function(result) {
        if (!result.ok) throw new Error(result.data.error || 'Something went wrong');
        document.getElementById('orbio-sp-tnum').textContent = result.data.ticketNumber;
        document.getElementById('orbio-sp-form-view').style.display = 'none';
        document.getElementById('orbio-sp-success').style.display = 'block';
      })
      .catch(function(err) {
        spError.textContent = err.message;
        spError.style.display = 'block';
        spSubmit.disabled = false;
        spSubmit.textContent = 'Submit Request';
      });
  });
})();`;
}

// ── Admin dashboard HTML ─────────────────────────────────────────────────────

function generateAdminDashboard() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Support Admin — OrbioLabs</title>
  <style>
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

    .container { max-width: 1200px; margin: 0 auto; padding: 32px 24px; }
    h1 { font-size: 1.5rem; font-weight: 800; margin-bottom: 24px; }

    .stats-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px; }
    .stat-card .label { font-size: 0.8rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
    .stat-card .value { font-size: 1.75rem; font-weight: 800; margin-top: 4px; }

    .tabs { display: flex; gap: 4px; margin-bottom: 24px; background: var(--surface); padding: 4px; border-radius: 8px; width: fit-content; }
    .tab { padding: 8px 20px; border-radius: 6px; font-size: 0.85rem; font-weight: 600; color: var(--muted); cursor: pointer; border: none; background: none; transition: all 0.15s; }
    .tab:hover { color: var(--text); }
    .tab.active { background: var(--brand); color: #fff; }
    .tab .badge { display: inline-block; background: var(--brand); color: #fff; border-radius: 10px; padding: 1px 8px; font-size: 0.7rem; margin-left: 4px; }
    .tab.active .badge { background: rgba(255,255,255,0.3); }

    table { width: 100%; border-collapse: collapse; background: var(--surface); border-radius: 10px; overflow: hidden; }
    thead th { background: var(--surface2); padding: 10px 14px; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); text-align: left; font-weight: 700; }
    tbody td { padding: 12px 14px; border-top: 1px solid var(--border); font-size: 0.875rem; vertical-align: top; }
    tbody tr:hover { background: var(--surface2); cursor: pointer; }

    .badge-status { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; }
    .badge-status.new { background: #3b82f633; color: #60a5fa; }
    .badge-status.open { background: #f59e0b33; color: #fbbf24; }
    .badge-status.in_progress { background: #8b5cf633; color: #a78bfa; }
    .badge-status.resolved { background: #10b98133; color: #34d399; }
    .badge-status.closed { background: #6b728033; color: #94a3b8; }

    .badge-priority { font-size: 0.75rem; font-weight: 600; }
    .badge-priority.high { color: var(--danger); }
    .badge-priority.medium { color: var(--warning); }
    .badge-priority.low { color: var(--muted); }

    .detail-panel { display: none; position: fixed; top: 0; right: 0; width: 480px; height: 100vh; background: var(--surface); border-left: 1px solid var(--border); box-shadow: -4px 0 16px rgba(0,0,0,0.3); z-index: 1000; overflow-y: auto; }
    .detail-panel.open { display: block; }
    .dp-header { padding: 20px 24px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
    .dp-header h2 { font-size: 1.1rem; font-weight: 700; }
    .dp-close { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 1.5rem; }
    .dp-body { padding: 24px; }
    .dp-field { margin-bottom: 16px; }
    .dp-field .dp-label { font-size: 0.75rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; margin-bottom: 4px; }
    .dp-field .dp-value { font-size: 0.9rem; }
    .dp-field select, .dp-field input, .dp-field textarea { width: 100%; padding: 8px 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-size: 0.875rem; font-family: inherit; }
    .dp-field textarea { min-height: 60px; resize: vertical; }
    .dp-actions { display: flex; gap: 8px; margin-top: 20px; }
    .dp-btn { padding: 8px 20px; border-radius: 6px; font-weight: 600; font-size: 0.85rem; cursor: pointer; border: none; }
    .dp-btn-primary { background: var(--brand); color: #fff; }
    .dp-btn-primary:hover { background: var(--brand-dark); }
    .notes-list { margin-top: 8px; }
    .note-item { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; font-size: 0.85rem; }
    .note-item .note-time { font-size: 0.7rem; color: var(--muted); }
    .overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 999; }
    .overlay.open { display: block; }

    @media (max-width: 640px) { .detail-panel { width: 100%; } }
  </style>
</head>
<body>
  <div class="admin-nav">
    <a href="/" class="logo">Orbio<span>Labs</span></a>
    <div class="nav-links">
      <a href="/admin">Admin</a>
      <a href="/support/admin" class="active">Support</a>
      <a href="/dashboard">Dashboard</a>
    </div>
  </div>

  <div class="container">
    <h1>Support Dashboard</h1>

    <div class="stats-grid" id="stats-grid">
      <div class="stat-card"><div class="label">Total Tickets</div><div class="value" id="stat-total">—</div></div>
      <div class="stat-card"><div class="label">Open</div><div class="value" id="stat-open">—</div></div>
      <div class="stat-card"><div class="label">Avg Response</div><div class="value" id="stat-response">—</div></div>
      <div class="stat-card"><div class="label">Resolution Rate</div><div class="value" id="stat-resolution">—</div></div>
    </div>

    <div class="tabs" id="tabs">
      <button class="tab active" data-status="">All</button>
      <button class="tab" data-status="new">Inbox</button>
      <button class="tab" data-status="open">Open</button>
      <button class="tab" data-status="in_progress">In Progress</button>
      <button class="tab" data-status="resolved">Resolved</button>
      <button class="tab" data-status="closed">Closed</button>
    </div>

    <table>
      <thead>
        <tr>
          <th>Ticket</th>
          <th>Subject</th>
          <th>Category</th>
          <th>Priority</th>
          <th>Status</th>
          <th>Assignee</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody id="tickets-body">
        <tr><td colspan="7" style="text-align:center;padding:32px;color:var(--muted);">Loading...</td></tr>
      </tbody>
    </table>
  </div>

  <div class="overlay" id="overlay"></div>
  <div class="detail-panel" id="detail-panel">
    <div class="dp-header">
      <h2 id="dp-title">Ticket</h2>
      <button class="dp-close" id="dp-close">&times;</button>
    </div>
    <div class="dp-body">
      <div class="dp-field"><div class="dp-label">From</div><div class="dp-value" id="dp-email"></div></div>
      <div class="dp-field"><div class="dp-label">Category</div><div class="dp-value" id="dp-category"></div></div>
      <div class="dp-field"><div class="dp-label">Description</div><div class="dp-value" id="dp-description" style="white-space:pre-wrap;"></div></div>
      <div class="dp-field"><div class="dp-label">Submitted</div><div class="dp-value" id="dp-created"></div></div>
      <hr style="border:none;border-top:1px solid var(--border);margin:20px 0;">
      <div class="dp-field">
        <div class="dp-label">Status</div>
        <select id="dp-status">
          <option value="new">New</option>
          <option value="open">Open</option>
          <option value="in_progress">In Progress</option>
          <option value="resolved">Resolved</option>
          <option value="closed">Closed</option>
        </select>
      </div>
      <div class="dp-field">
        <div class="dp-label">Priority</div>
        <select id="dp-priority">
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </div>
      <div class="dp-field">
        <div class="dp-label">Assignee</div>
        <input id="dp-assignee" type="text" placeholder="Enter assignee name...">
      </div>
      <div class="dp-field">
        <div class="dp-label">Add Internal Note</div>
        <textarea id="dp-note" placeholder="Write an internal note..."></textarea>
      </div>
      <div class="dp-actions">
        <button class="dp-btn dp-btn-primary" id="dp-save">Save Changes</button>
      </div>
      <div class="dp-field" style="margin-top:24px;">
        <div class="dp-label">Internal Notes</div>
        <div class="notes-list" id="dp-notes"></div>
      </div>
    </div>
  </div>

  <script>
    var currentStatus = '';
    var currentTicketId = null;

    // Load stats
    fetch('/api/support/tickets/stats', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(s) {
        document.getElementById('stat-total').textContent = s.total;
        document.getElementById('stat-open').textContent = (s.byStatus.new || 0) + (s.byStatus.open || 0) + (s.byStatus.in_progress || 0);
        var hrs = Math.round(s.avgResponseTimeMs / 3600000);
        document.getElementById('stat-response').textContent = hrs > 0 ? hrs + 'h' : '—';
        document.getElementById('stat-resolution').textContent = s.resolutionRate + '%';
      });

    // Load tickets
    function loadTickets(status) {
      currentStatus = status;
      var url = '/api/support/tickets' + (status ? '?status=' + status : '');
      fetch(url, { credentials: 'include' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var tbody = document.getElementById('tickets-body');
          if (!data.tickets || data.tickets.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--muted);">No tickets found</td></tr>';
            return;
          }
          tbody.innerHTML = data.tickets.map(function(t) {
            var d = new Date(t.createdAt);
            var dateStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
            return '<tr data-id="' + t.id + '">' +
              '<td style="font-family:monospace;font-size:0.8rem;">' + t.ticketNumber + '</td>' +
              '<td>' + escHtml(t.subject) + '</td>' +
              '<td>' + t.category + '</td>' +
              '<td><span class="badge-priority ' + t.priority + '">' + t.priority + '</span></td>' +
              '<td><span class="badge-status ' + t.status + '">' + t.status.replace('_', ' ') + '</span></td>' +
              '<td>' + (t.assignee || '—') + '</td>' +
              '<td style="font-size:0.8rem;color:var(--muted);">' + dateStr + '</td>' +
              '</tr>';
          }).join('');

          tbody.querySelectorAll('tr').forEach(function(tr) {
            tr.addEventListener('click', function() { openDetail(tr.dataset.id, data.tickets); });
          });
        });
    }

    loadTickets('');

    // Tabs
    document.getElementById('tabs').addEventListener('click', function(e) {
      if (!e.target.classList.contains('tab')) return;
      document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
      e.target.classList.add('active');
      loadTickets(e.target.dataset.status);
    });

    // Detail panel
    function openDetail(id, tickets) {
      var t = tickets.find(function(x) { return x.id === id; });
      if (!t) return;
      currentTicketId = id;
      document.getElementById('dp-title').textContent = t.ticketNumber + ': ' + t.subject;
      document.getElementById('dp-email').textContent = t.email;
      document.getElementById('dp-category').textContent = t.category;
      document.getElementById('dp-description').textContent = t.description;
      document.getElementById('dp-created').textContent = new Date(t.createdAt).toLocaleString();
      document.getElementById('dp-status').value = t.status;
      document.getElementById('dp-priority').value = t.priority;
      document.getElementById('dp-assignee').value = t.assignee || '';
      document.getElementById('dp-note').value = '';
      var notesHtml = (t.internalNotes || []).map(function(n) {
        return '<div class="note-item"><div>' + escHtml(n.text) + '</div><div class="note-time">' + new Date(n.at).toLocaleString() + '</div></div>';
      }).reverse().join('');
      document.getElementById('dp-notes').innerHTML = notesHtml || '<div style="color:var(--muted);font-size:0.85rem;">No notes yet</div>';
      document.getElementById('detail-panel').classList.add('open');
      document.getElementById('overlay').classList.add('open');
    }

    function closeDetail() {
      document.getElementById('detail-panel').classList.remove('open');
      document.getElementById('overlay').classList.remove('open');
      currentTicketId = null;
    }
    document.getElementById('dp-close').addEventListener('click', closeDetail);
    document.getElementById('overlay').addEventListener('click', closeDetail);

    // Save
    document.getElementById('dp-save').addEventListener('click', function() {
      if (!currentTicketId) return;
      var body = {
        status: document.getElementById('dp-status').value,
        priority: document.getElementById('dp-priority').value,
        assignee: document.getElementById('dp-assignee').value || null,
      };
      var note = document.getElementById('dp-note').value.trim();
      if (note) body.internalNote = note;
      fetch('/api/support/tickets/' + currentTicketId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      }).then(function(r) { return r.json(); })
        .then(function() {
          closeDetail();
          loadTickets(currentStatus);
        });
    });

    function escHtml(s) {
      var d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }
  </script>
</body>
</html>`;
}

module.exports = router;
