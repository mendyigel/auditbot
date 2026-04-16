'use strict';

/**
 * Stripe billing module for AuditBot
 *
 * Two-tier pricing:
 *   Starter — $9/month  (5 audits/month, 1 site, standard reports)
 *   Pro     — $29/month (unlimited audits, 10 sites, full features)
 *
 * Flow:
 *   1. POST /billing/checkout  → create Stripe Checkout session, redirect to Stripe
 *   2. Stripe redirects to SUCCESS_URL with ?session_id=…
 *   3. Webhook confirms payment → activates API key
 *   4. API key gates POST /audit and GET /audit endpoints
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY         — sk_live_… or sk_test_…
 *   STRIPE_WEBHOOK_SECRET     — whsec_… (from Stripe dashboard → Webhooks)
 *   STRIPE_STARTER_PRICE_ID   — price_… for the $9/month Starter product
 *   STRIPE_PRO_PRICE_ID       — price_… for the $29/month Pro product
 *   STRIPE_PRICE_ID           — (legacy fallback, mapped to Pro)
 *   APP_URL                   — public base URL (e.g. https://auditbot.up.railway.app)
 */

const crypto = require('crypto');
const db = require('./db');
const email = require('./email');

// Lazy-load Stripe to allow server to boot without credentials (dev/test mode)
let _stripe = null;
function getStripe() {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not set');
    }
    _stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  }
  return _stripe;
}

function generateApiKey() {
  return 'ab_live_' + crypto.randomBytes(24).toString('hex');
}

function getOrCreateApiKeyForCustomer(customerId, email) {
  // If we already have a key for this customer, return it
  const existing = db.getSubscriptionByCustomerId(customerId);
  if (existing) return existing.apiKey;

  const apiKey = generateApiKey();
  db.upsertSubscription({ apiKey, email, customerId, status: 'incomplete' });
  return apiKey;
}

/** Returns the subscription record for a given API key, or null. */
function lookupSubscription(apiKey) {
  return db.getSubscriptionByApiKey(apiKey);
}

// ── Plan definitions ──────────────────────────────────────────────────────────
const PLANS = {
  starter: {
    name: 'Starter',
    price: 9,
    monthlyAudits: 5,
    maxSites: 1,
    pdfExport: false,
    scheduledAudits: false,
    whiteLabel: false,
    priorityScanning: false,
  },
  pro: {
    name: 'Pro',
    price: 29,
    monthlyAudits: Infinity,
    maxSites: 10,
    pdfExport: true,
    scheduledAudits: true,
    whiteLabel: true,
    priorityScanning: true,
  },
};

/** Resolve the Stripe price ID for a given tier. */
function getPriceIdForTier(tier) {
  if (tier === 'starter') {
    return process.env.STRIPE_STARTER_PRICE_ID || null;
  }
  // Pro or fallback
  return process.env.STRIPE_PRO_PRICE_ID || process.env.STRIPE_PRICE_ID || null;
}

/** Determine plan tier from a Stripe price ID. */
function getTierFromPriceId(priceId) {
  if (priceId && priceId === process.env.STRIPE_STARTER_PRICE_ID) return 'starter';
  return 'pro';
}

// ── Trial constants ────────────────────────────────────────────────────────────
const TRIAL_DAYS        = 14;
const TRIAL_AUDIT_LIMIT = 10;
const TRIAL_PDF_LIMIT   = 3;

/** Returns true if the API key has an active or trialing subscription. */
function isActive(apiKey) {
  const sub = db.getSubscriptionByApiKey(apiKey);
  return sub && (sub.status === 'active' || sub.status === 'trialing');
}

/** Returns trial usage info for a trialing subscription, or null for paid. */
function getTrialInfo(sub) {
  if (!sub || sub.status !== 'trialing') return null;
  const ageMs    = Date.now() - sub.createdAt;
  const daysLeft = Math.max(0, TRIAL_DAYS - Math.floor(ageMs / (24 * 60 * 60 * 1000)));
  return {
    auditsUsed:  sub.auditCount,
    auditsLimit: TRIAL_AUDIT_LIMIT,
    pdfsUsed:    sub.pdfCount,
    pdfsLimit:   TRIAL_PDF_LIMIT,
    daysLeft,
    expired: daysLeft === 0 && sub.auditCount >= 0, // always false while Stripe trialing
  };
}

// ── Stripe helpers ─────────────────────────────────────────────────────────────

/**
 * Create a Stripe Checkout Session for an immediate paid subscription.
 * @param {string} tier - 'starter' or 'pro' (default: 'pro')
 * Returns { url } — redirect the browser to this URL.
 */
async function createCheckoutSession({ email, successUrl, cancelUrl, tier = 'pro' }) {
  const stripe = getStripe();
  const priceId = getPriceIdForTier(tier);
  if (!priceId) throw new Error(`Stripe price ID not set for tier: ${tier}`);

  const params = {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: true,
    billing_address_collection: 'auto',
    subscription_data: {
      metadata: { plan_tier: tier },
    },
  };
  if (email) params.customer_email = email;

  const session = await stripe.checkout.sessions.create(params);
  return { sessionId: session.id, url: session.url };
}

/**
 * Create a Stripe Checkout Session with a 14-day free trial.
 * Collects a payment method but does NOT charge until trial ends.
 * @param {string} tier - 'starter' or 'pro' (default: 'pro')
 * Returns { url, sessionId }.
 */
async function createTrialCheckoutSession({ email, successUrl, cancelUrl, tier = 'pro' }) {
  const stripe = getStripe();
  const priceId = getPriceIdForTier(tier);
  if (!priceId) throw new Error(`Stripe price ID not set for tier: ${tier}`);

  const params = {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: true,
    billing_address_collection: 'auto',
    subscription_data: {
      trial_period_days: TRIAL_DAYS,
      metadata: { source: 'free_trial', plan_tier: tier },
    },
    payment_method_collection: 'always',
  };
  if (email) params.customer_email = email;

  const session = await stripe.checkout.sessions.create(params);
  return { sessionId: session.id, url: session.url };
}

/**
 * Handle a Stripe webhook event.
 * Returns { handled: true } or throws on verification failure.
 */
async function handleWebhook(rawBody, signature) {
  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    throw new Error('Webhook signature verification failed: ' + err.message);
  }

  const { type, data } = event;
  console.log('[stripe webhook]', type);

  switch (type) {
    case 'checkout.session.completed': {
      const session = data.object;
      if (session.mode !== 'subscription') break;
      const customerId = session.customer;
      const customerEmail = session.customer_details?.email || session.customer_email || '';
      const apiKey = getOrCreateApiKeyForCustomer(customerId, customerEmail);
      db.updateSubscriptionStatus({
        customerId,
        status: 'active',
        subscriptionId: session.subscription,
      });
      // Determine plan tier from subscription metadata or price ID
      let tier = 'pro';
      try {
        const stripeSub = await getStripe().subscriptions.retrieve(session.subscription);
        tier = stripeSub.metadata?.plan_tier || getTierFromPriceId(stripeSub.items?.data?.[0]?.price?.id) || 'pro';
      } catch (_) {}
      db.updatePlanTier(customerId, tier);
      console.log('[stripe] checkout complete — customer:', customerId, '— tier:', tier, '— apiKey:', apiKey);
      if (customerEmail) {
        Promise.all([
          email.sendWelcome(customerEmail, { apiKey }),
          email.sendPaymentReceipt(customerEmail),
        ]).catch((err) => console.error('[email] checkout emails failed:', err.message));
      }
      break;
    }

    case 'customer.subscription.updated': {
      const subscription = data.object;
      db.updateSubscriptionStatus({
        customerId: subscription.customer,
        status: subscription.status,
        subscriptionId: subscription.id,
      });
      // Sync plan tier on upgrade/downgrade
      const updatedTier = subscription.metadata?.plan_tier || getTierFromPriceId(subscription.items?.data?.[0]?.price?.id) || 'pro';
      db.updatePlanTier(subscription.customer, updatedTier);
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = data.object;
      db.updateSubscriptionStatus({
        customerId: subscription.customer,
        status: 'cancelled',
        subscriptionId: subscription.id,
      });
      const cancelledSub = db.getSubscriptionByCustomerId(subscription.customer);
      if (cancelledSub?.email) {
        email.sendCancellation(cancelledSub.email)
          .catch((err) => console.error('[email] cancellation email failed:', err.message));
      }
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = data.object;
      db.updateSubscriptionStatus({
        customerId: invoice.customer,
        status: 'past_due',
      });
      break;
    }

    default:
      // Unhandled event type — ignore
      break;
  }

  return { handled: true };
}

/**
 * Create a Stripe Customer Portal session so the customer can manage their subscription.
 */
async function createPortalSession({ customerId, returnUrl }) {
  const stripe = getStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return { url: session.url };
}

module.exports = {
  lookupSubscription,
  isActive,
  getTrialInfo,
  TRIAL_AUDIT_LIMIT,
  TRIAL_PDF_LIMIT,
  TRIAL_DAYS,
  PLANS,
  createCheckoutSession,
  createTrialCheckoutSession,
  handleWebhook,
  createPortalSession,
};
