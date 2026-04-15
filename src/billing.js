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

// ── In-memory subscription store ──────────────────────────────────────────────
// Shape: Map<apiKey, { email, customerId, subscriptionId, status, createdAt }>
// status: 'active' | 'cancelled' | 'past_due' | 'trialing' | 'incomplete'
//
// This will be replaced with persistent DB storage in MAN-9.
const subscriptions = new Map();

// Secondary index: customerId → apiKey (for webhook lookups)
const customerIndex = new Map();

function generateApiKey() {
  return 'ab_live_' + crypto.randomBytes(24).toString('hex');
}

function getOrCreateApiKeyForCustomer(customerId, email) {
  // If we already have a key for this customer, return it
  const existingKey = customerIndex.get(customerId);
  if (existingKey) return existingKey;

  const apiKey = generateApiKey();
  subscriptions.set(apiKey, {
    email,
    customerId,
    subscriptionId: null,
    status: 'incomplete',
    createdAt: Date.now(),
  });
  customerIndex.set(customerId, apiKey);
  return apiKey;
}

/** Returns the subscription record for a given API key, or null. */
function lookupSubscription(apiKey) {
  return subscriptions.get(apiKey) || null;
}

/** Returns true if the API key has an active (or trialing) subscription. */
function isActive(apiKey) {
  const sub = subscriptions.get(apiKey);
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
      const sub = subscriptions.get(apiKey);
      if (sub) {
        sub.subscriptionId = session.subscription;
        // Status will be confirmed by customer.subscription.updated, but set active now
        sub.status = 'active';
      }
      console.log('[stripe] checkout complete — customer:', customerId, '— apiKey:', apiKey);
      break;
    }

    case 'customer.subscription.updated': {
      const subscription = data.object;
      const customerId = subscription.customer;
      const apiKey = customerIndex.get(customerId);
      if (apiKey) {
        const sub = subscriptions.get(apiKey);
        if (sub) {
          sub.subscriptionId = subscription.id;
          sub.status = subscription.status; // active / past_due / cancelled etc.
        }
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = data.object;
      const customerId = subscription.customer;
      const apiKey = customerIndex.get(customerId);
      if (apiKey) {
        const sub = subscriptions.get(apiKey);
        if (sub) sub.status = 'cancelled';
      }
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = data.object;
      const customerId = invoice.customer;
      const apiKey = customerIndex.get(customerId);
      if (apiKey) {
        const sub = subscriptions.get(apiKey);
        if (sub) sub.status = 'past_due';
      }
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
  // Exposed for MAN-9 (DB persistence): allows seeding from DB on startup
  subscriptions,
  customerIndex,
};
