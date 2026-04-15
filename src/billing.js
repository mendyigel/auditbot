'use strict';

/**
 * Stripe billing module for AuditBot
 *
 * Subscription plan: $29/month
 * Flow:
 *   1. POST /billing/checkout  → create Stripe Checkout session, redirect to Stripe
 *   2. Stripe redirects to SUCCESS_URL with ?session_id=…
 *   3. Webhook confirms payment → activates API key
 *   4. API key gates POST /audit and GET /audit endpoints
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY         — sk_live_… or sk_test_…
 *   STRIPE_WEBHOOK_SECRET     — whsec_… (from Stripe dashboard → Webhooks)
 *   STRIPE_PRICE_ID           — price_… for the $29/month product
 *   APP_URL                   — public base URL (e.g. https://auditbot.up.railway.app)
 */

const crypto = require('crypto');
const db = require('./db');

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

/** Returns true if the API key has an active (or trialing) subscription. */
function isActive(apiKey) {
  const sub = db.getSubscriptionByApiKey(apiKey);
  return sub && (sub.status === 'active' || sub.status === 'trialing');
}

// ── Stripe helpers ─────────────────────────────────────────────────────────────

/**
 * Create a Stripe Checkout Session.
 * Returns { url } — redirect the browser to this URL.
 */
async function createCheckoutSession({ email, successUrl, cancelUrl }) {
  const stripe = getStripe();
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) throw new Error('STRIPE_PRICE_ID is not set');

  const params = {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: true,
    billing_address_collection: 'auto',
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
      const email = session.customer_details?.email || session.customer_email || '';
      const apiKey = getOrCreateApiKeyForCustomer(customerId, email);
      db.updateSubscriptionStatus({
        customerId,
        status: 'active',
        subscriptionId: session.subscription,
      });
      console.log('[stripe] checkout complete — customer:', customerId, '— apiKey:', apiKey);
      break;
    }

    case 'customer.subscription.updated': {
      const subscription = data.object;
      db.updateSubscriptionStatus({
        customerId: subscription.customer,
        status: subscription.status,
        subscriptionId: subscription.id,
      });
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = data.object;
      db.updateSubscriptionStatus({
        customerId: subscription.customer,
        status: 'cancelled',
        subscriptionId: subscription.id,
      });
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
  createCheckoutSession,
  handleWebhook,
  createPortalSession,
};
