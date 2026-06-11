import { getStripe } from './stripeClient';
import { getOrCreateStripeCustomer, getOrCreateBillingRow } from './customer';
import { signBillingToken } from './auth';

/**
 * Create a Stripe Checkout Session for the Upgrade flow.
 *
 * Idempotency key buckets by the minute so a frantic double-click reuses the
 * same Session URL within 60s. Cross-minute clicks create new sessions, which
 * is fine — Stripe abandons unused sessions and only one can complete (the
 * second-completer hits the "subscription already exists" error).
 *
 * The success/cancel URLs carry signed billing tokens so the return pages can
 * re-authenticate the user without a fresh OAuth bounce.
 */
export async function createCheckoutSession(args: {
  installationId: string;
  userId: string;
  teamId: string | null;
  enterpriseId: string | null;
  installerEmail?: string | null;
  workspaceName?: string | null;
}): Promise<{ url: string; sessionId: string }> {
  const stripe = getStripe();
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) {
    throw new Error('STRIPE_PRICE_ID is not configured.');
  }
  const baseUrl = (process.env.BILLING_RETURN_BASE_URL ?? process.env.BASE_URL ?? '').replace(
    /\/$/,
    ''
  );
  if (!baseUrl) {
    throw new Error('BASE_URL (or BILLING_RETURN_BASE_URL) is not configured.');
  }

  await getOrCreateBillingRow(args.installationId);
  const customerId = await getOrCreateStripeCustomer({
    installationId: args.installationId,
    installerEmail: args.installerEmail ?? null,
    workspaceName: args.workspaceName ?? null,
  });

  // Tokens for the return pages — short TTL since they're used immediately
  // after Checkout completes. We sign separate tokens for success vs cancel
  // so a leaked one can't be replayed for the other intent.
  const returnTokenSuccess = signBillingToken({
    userId: args.userId,
    teamId: args.teamId,
    enterpriseId: args.enterpriseId,
    intent: 'view',
    ttlMs: 60 * 60 * 1000, // 1 hour
  });
  const returnTokenCancel = signBillingToken({
    userId: args.userId,
    teamId: args.teamId,
    enterpriseId: args.enterpriseId,
    intent: 'view',
    ttlMs: 60 * 60 * 1000,
  });

  const successUrl = `${baseUrl}/billing/return?token=${encodeURIComponent(
    returnTokenSuccess
  )}&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${baseUrl}/billing/cancel?token=${encodeURIComponent(returnTokenCancel)}`;

  const minuteBucket = Math.floor(Date.now() / 60000);

  const session = await stripe.checkout.sessions.create(
    {
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: args.installationId,
      metadata: {
        installationId: args.installationId,
        teamId: args.teamId ?? '',
        enterpriseId: args.enterpriseId ?? '',
        slackUserId: args.userId,
      },
      subscription_data: {
        metadata: {
          installationId: args.installationId,
          teamId: args.teamId ?? '',
          enterpriseId: args.enterpriseId ?? '',
        },
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
    },
    { idempotencyKey: `checkout:${args.installationId}:${minuteBucket}` }
  );

  if (!session.url) {
    throw new Error('Stripe Checkout did not return a URL.');
  }

  return { url: session.url, sessionId: session.id };
}
