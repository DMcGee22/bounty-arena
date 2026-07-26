'use strict';

// Payments layer.
//
// Default mode is SANDBOX: deposits credit instantly, withdrawals debit
// instantly, no real money moves anywhere. This is the only mode you should
// run until you have gaming counsel, licensing, KYC/AML and a processor
// agreement in place (see README.md — Stripe prohibits wagering products
// without explicit pre-approval).
//
// If STRIPE_SECRET_KEY is set, deposits go through Stripe Checkout (use test
// keys!) and are credited by the webhook. Withdrawals would require Stripe
// Connect payouts + KYC and are intentionally left as sandbox-only.

const config = require('./config');
const wallet = require('./wallet');

let stripe = null;
if (config.STRIPE_SECRET_KEY) {
  try {
    stripe = require('stripe')(config.STRIPE_SECRET_KEY);
  } catch {
    console.warn('[payments] STRIPE_SECRET_KEY set but `stripe` package not installed; falling back to sandbox mode');
  }
}

function mode() {
  return stripe ? 'stripe-test' : 'sandbox';
}

function validateAmount(cents, min, max) {
  if (!Number.isInteger(cents) || cents < min || cents > max) {
    const err = new Error(`amount must be between ${min} and ${max} cents`);
    err.code = 'BAD_AMOUNT';
    throw err;
  }
}

// Returns { balance } in sandbox mode, or { checkoutUrl } in stripe mode.
async function startDeposit(user, cents, origin) {
  validateAmount(cents, config.MIN_DEPOSIT_CENTS, config.MAX_DEPOSIT_CENTS);
  if (!stripe) {
    const balance = wallet.deposit(user.id, cents, 'sandbox deposit');
    return { balance };
  }
  const base = config.PUBLIC_URL || origin;
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: { name: 'Bounty Arena balance top-up' },
        unit_amount: cents,
      },
      quantity: 1,
    }],
    metadata: { user_id: String(user.id) },
    success_url: `${base}/?deposit=success`,
    cancel_url: `${base}/?deposit=cancelled`,
  });
  return { checkoutUrl: session.url };
}

// Stripe webhook: credits the wallet once payment is confirmed.
function handleWebhook(rawBody, signature) {
  if (!stripe || !config.STRIPE_WEBHOOK_SECRET) throw new Error('webhook not configured');
  const event = stripe.webhooks.constructEvent(rawBody, signature, config.STRIPE_WEBHOOK_SECRET);
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = parseInt(session.metadata?.user_id, 10);
    if (userId && session.amount_total > 0) {
      wallet.deposit(userId, session.amount_total, `stripe ${session.id}`);
      return { credited: userId, cents: session.amount_total };
    }
  }
  return { ignored: event.type };
}

// Withdrawals are always simulated. Real payouts need Stripe Connect + KYC.
function withdraw(user, cents) {
  validateAmount(cents, config.MIN_WITHDRAW_CENTS, Number.MAX_SAFE_INTEGER);
  const balance = wallet.withdraw(user.id, cents, 'simulated payout');
  return { balance };
}

module.exports = { mode, startDeposit, handleWebhook, withdraw };
