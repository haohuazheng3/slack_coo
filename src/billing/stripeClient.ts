// stripe-node v22 uses `export =` so we need import-equals to preserve both
// the constructor value AND the namespace (Stripe.Event, Stripe.Subscription, …).
import Stripe = require('stripe');

/**
 * Singleton Stripe SDK client.
 *
 * Lazy-initialized via getter to keep the rest of the app bootable in dev
 * without STRIPE_SECRET_KEY. If you call getStripe() without the env var
 * configured, it throws — but featureGate / route guards check env presence
 * first and 503 cleanly when billing isn't wired up.
 */
let _stripe: Stripe.Stripe | null = null;

export function getStripe(): Stripe.Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      'STRIPE_SECRET_KEY is not set. Billing routes should 503 before reaching this code.'
    );
  }
  _stripe = new Stripe(key, {
    // Pin to a stable API version so SDK upgrades don't silently shift schema.
    apiVersion: '2024-06-20' as any,
    typescript: true,
    appInfo: {
      name: 'Aiptima',
      version: '1.0.0',
    },
  });
  return _stripe;
}

export function isBillingConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}
