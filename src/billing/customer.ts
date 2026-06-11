import { prisma } from '../lib/prisma';
import { getStripe } from './stripeClient';
import { createLogger } from '../lib/logger';

const log = createLogger('Billing.Customer');

/**
 * Returns the WorkspaceBilling row for the install, creating it lazily if it
 * doesn't exist. Safe to call from any code path that needs to mutate billing
 * state — guarantees a row to operate on.
 *
 * This does NOT create a Stripe Customer. That happens later, on first Upgrade
 * click, so workspaces that never click Upgrade don't pollute Stripe.
 */
export async function getOrCreateBillingRow(installationId: string) {
  const install = await prisma.slackInstallation.findUnique({
    where: { id: installationId },
    include: { billing: true },
  });
  if (!install) {
    throw new Error(`No SlackInstallation found for id=${installationId}`);
  }
  if (install.billing) return install.billing;

  return prisma.workspaceBilling.create({
    data: {
      installationId: install.id,
      teamId: install.teamId,
      enterpriseId: install.enterpriseId,
      status: 'NONE',
    },
  });
}

/**
 * Returns the Stripe Customer id for a workspace, creating it lazily on the
 * first Upgrade click. Uses an idempotency key derived from installationId so
 * frantic double-clicks don't create duplicate Customer objects in Stripe.
 *
 * Metadata.installationId is set so we can recover billing state from Stripe
 * even if our DB row is ever lost (rebuild WorkspaceBilling by listing
 * Customers and reading metadata).
 */
export async function getOrCreateStripeCustomer(args: {
  installationId: string;
  installerEmail?: string | null;
  workspaceName?: string | null;
}): Promise<string> {
  const billing = await getOrCreateBillingRow(args.installationId);
  if (billing.stripeCustomerId) return billing.stripeCustomerId;

  const stripe = getStripe();
  const customer = await stripe.customers.create(
    {
      email: args.installerEmail ?? undefined,
      name: args.workspaceName ?? undefined,
      metadata: {
        installationId: args.installationId,
        teamId: billing.teamId ?? '',
        enterpriseId: billing.enterpriseId ?? '',
      },
    },
    { idempotencyKey: `customer:${args.installationId}` }
  );

  await prisma.workspaceBilling.update({
    where: { id: billing.id },
    data: { stripeCustomerId: customer.id },
  });

  log.info('Stripe customer created', {
    customerId: customer.id,
    installationId: args.installationId,
  });

  return customer.id;
}

/**
 * Start a trial for a freshly installed workspace. Called from the OAuth
 * callback. No-ops if the row is already past NONE (e.g. on reinstall after
 * a subscription was already active).
 *
 * `extendedTrial` is the referral courtesy for new installs by grandfathered
 * users — 90 days instead of 14.
 */
export async function startTrial(args: {
  installationId: string;
  trialDays: number;
}): Promise<void> {
  const billing = await getOrCreateBillingRow(args.installationId);
  if (billing.status !== 'NONE') {
    log.info('Skipping trial start — billing row already past NONE', {
      installationId: args.installationId,
      status: billing.status,
    });
    return;
  }
  const trialEndsAt = new Date(Date.now() + args.trialDays * 24 * 60 * 60 * 1000);
  await prisma.workspaceBilling.update({
    where: { id: billing.id },
    data: {
      status: 'TRIALING',
      trialEndsAt,
      lastTrialReminderStage: null,
    },
  });
  log.info('Trial started', {
    installationId: args.installationId,
    trialEndsAt: trialEndsAt.toISOString(),
    trialDays: args.trialDays,
  });
}

/**
 * Find the WorkspaceBilling row that points to a given Stripe Customer.
 * Used by webhook handlers to route events back to a workspace.
 */
export async function findBillingByStripeCustomer(customerId: string) {
  return prisma.workspaceBilling.findFirst({
    where: { stripeCustomerId: customerId },
    include: { installation: true },
  });
}
