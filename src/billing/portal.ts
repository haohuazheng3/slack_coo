import { getStripe } from './stripeClient';
import { prisma } from '../lib/prisma';
import { signBillingToken } from './auth';

/**
 * Create a Stripe Billing Portal session. The owner uses this to update card,
 * cancel, view invoice history, etc. The Portal UI is Stripe-hosted (we don't
 * build it).
 */
export async function createPortalSession(args: {
  installationId: string;
  userId: string;
  teamId: string | null;
  enterpriseId: string | null;
}): Promise<{ url: string }> {
  const billing = await prisma.workspaceBilling.findUnique({
    where: { installationId: args.installationId },
  });
  if (!billing?.stripeCustomerId) {
    throw new Error('No Stripe customer yet — workspace has not started a subscription.');
  }

  const stripe = getStripe();
  const baseUrl = (process.env.BILLING_RETURN_BASE_URL ?? process.env.BASE_URL ?? '').replace(
    /\/$/,
    ''
  );

  const returnToken = signBillingToken({
    userId: args.userId,
    teamId: args.teamId,
    enterpriseId: args.enterpriseId,
    intent: 'view',
    ttlMs: 60 * 60 * 1000,
  });
  const returnUrl = `${baseUrl}/billing?token=${encodeURIComponent(returnToken)}`;

  const minuteBucket = Math.floor(Date.now() / 60000);
  const session = await stripe.billingPortal.sessions.create(
    {
      customer: billing.stripeCustomerId,
      return_url: returnUrl,
      configuration: process.env.STRIPE_PORTAL_CONFIGURATION_ID || undefined,
    },
    { idempotencyKey: `portal:${args.installationId}:${minuteBucket}` }
  );

  return { url: session.url };
}
