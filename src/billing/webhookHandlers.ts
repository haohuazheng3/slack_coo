import { PrismaClient, BillingStatus } from '@prisma/client';
import { createLogger } from '../lib/logger';

// Stripe webhook event payloads are typed as `any` at handler boundaries —
// stripe-node v22 changed its type export shape and the Stripe namespace no
// longer bubbles through the default import in a clean way. Since Stripe's
// signature verification already guaranteed the body shape upstream, and we
// narrow each handler's expected fields inline, `any` is the pragmatic call.

const log = createLogger('Billing.Webhook');

/**
 * Per-event-type handlers. Each one is a pure function over (prisma, event).
 *
 * Idempotency is handled OUTSIDE these handlers (the router inserts
 * StripeWebhookEvent with a unique constraint on stripeEventId — duplicate
 * deliveries collapse to no-op). These handlers can assume "first time we're
 * seeing this event" but should still tolerate being called twice in the rare
 * case the unique insert succeeded but the mutation crashed mid-flight.
 *
 * Stripe-status-to-our-BillingStatus mapping mirrors Stripe verbatim so the
 * Stripe Dashboard and our admin UI never disagree.
 */

function mapStripeStatus(s: string): BillingStatus {
  switch (s) {
    case 'trialing':
      return 'TRIALING';
    case 'active':
      return 'ACTIVE';
    case 'past_due':
      return 'PAST_DUE';
    case 'canceled':
      return 'CANCELED';
    case 'unpaid':
      return 'UNPAID';
    case 'incomplete':
      return 'INCOMPLETE';
    case 'incomplete_expired':
      return 'INCOMPLETE_EXPIRED';
    case 'paused':
      return 'PAUSED';
    default:
      return 'NONE';
  }
}

async function findBillingByStripeCustomer(prisma: PrismaClient, customerId: string) {
  return prisma.workspaceBilling.findFirst({ where: { stripeCustomerId: customerId } });
}

/**
 * Resolve the workspace by event metadata first, falling back to the Stripe
 * Customer id lookup. The metadata path matters for checkout.session.completed,
 * which arrives BEFORE we've necessarily linked the Customer in our DB if the
 * Customer was created seconds earlier in the same flow.
 */
async function resolveBilling(
  prisma: PrismaClient,
  customerId: string | null,
  metadata: Record<string, string> | null | undefined
) {
  if (customerId) {
    const byCustomer = await findBillingByStripeCustomer(prisma, customerId);
    if (byCustomer) return byCustomer;
  }
  const installationId = metadata?.installationId;
  if (installationId) {
    const byInstall = await prisma.workspaceBilling.findUnique({
      where: { installationId },
    });
    if (byInstall) return byInstall;
  }
  return null;
}

export async function handleCheckoutCompleted(
  prisma: PrismaClient,
  event: any
): Promise<{ ok: boolean; billingId?: string }> {
  const session = event.data.object as any;
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  const billing = await resolveBilling(prisma, customerId ?? null, session.metadata);
  if (!billing) {
    log.warn('checkout.session.completed: no billing row resolved', { sessionId: session.id });
    return { ok: false };
  }

  // Link the Customer id if we hadn't yet (e.g. legacy DB state).
  await prisma.workspaceBilling.update({
    where: { id: billing.id },
    data: {
      stripeCustomerId: customerId ?? billing.stripeCustomerId,
      stripeSubscriptionId:
        typeof session.subscription === 'string'
          ? session.subscription
          : session.subscription?.id ?? billing.stripeSubscriptionId,
      // Tentative ACTIVE — the subscription.created webhook will correct this if
      // the actual status is different (e.g. INCOMPLETE while a 3DS confirms).
      status: 'ACTIVE',
    },
  });
  log.info('Checkout completed → ACTIVE', { billingId: billing.id });
  return { ok: true, billingId: billing.id };
}

async function handleSubscriptionUpsert(
  prisma: PrismaClient,
  sub: any
): Promise<{ ok: boolean; billingId?: string }> {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const billing = await resolveBilling(prisma, customerId, sub.metadata);
  if (!billing) {
    log.warn('subscription event: no billing row resolved', { subId: sub.id });
    return { ok: false };
  }

  const status = mapStripeStatus(sub.status);
  const currentPeriodEnd = sub.current_period_end
    ? new Date(sub.current_period_end * 1000)
    : null;
  const accessUntil = sub.cancel_at_period_end ? currentPeriodEnd : null;
  const priceId = sub.items?.data?.[0]?.price?.id ?? null;

  // Clear the trial reminder bookkeeping when we transition out of TRIALING —
  // if they later trial again (rare) we want a clean slate.
  const clearTrialReminder = status !== 'TRIALING';
  // Clear the grace dunning bookkeeping on success.
  const clearGraceReminder = status === 'ACTIVE';

  await prisma.workspaceBilling.update({
    where: { id: billing.id },
    data: {
      stripeSubscriptionId: sub.id,
      stripePriceId: priceId,
      status,
      currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      accessUntil,
      ...(clearTrialReminder ? { lastTrialReminderStage: null } : {}),
      ...(clearGraceReminder ? { lastGraceReminderStage: null, graceEndsAt: null } : {}),
    },
  });
  log.info('Subscription upserted', {
    billingId: billing.id,
    status,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
  });
  return { ok: true, billingId: billing.id };
}

export async function handleSubscriptionCreated(prisma: PrismaClient, event: any) {
  return handleSubscriptionUpsert(prisma, event.data.object as any);
}

export async function handleSubscriptionUpdated(prisma: PrismaClient, event: any) {
  return handleSubscriptionUpsert(prisma, event.data.object as any);
}

export async function handleSubscriptionDeleted(prisma: PrismaClient, event: any) {
  const sub = event.data.object as any;
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const billing = await resolveBilling(prisma, customerId, sub.metadata);
  if (!billing) return { ok: false };
  await prisma.workspaceBilling.update({
    where: { id: billing.id },
    data: {
      status: 'CANCELED',
      cancelAtPeriodEnd: false,
      // Subscription was hard-deleted — no remaining access.
      accessUntil: null,
      graceEndsAt: null,
    },
  });
  log.info('Subscription deleted → CANCELED (no access)', { billingId: billing.id });
  return { ok: true, billingId: billing.id };
}

export async function handleInvoicePaid(prisma: PrismaClient, event: any) {
  const invoice = event.data.object as any;
  const customerId =
    typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null;
  if (!customerId) return { ok: false };
  const billing = await resolveBilling(prisma, customerId, invoice.metadata);
  if (!billing) return { ok: false };
  // invoice.paid arrives after a successful renewal — clear any past_due state.
  await prisma.workspaceBilling.update({
    where: { id: billing.id },
    data: {
      status: 'ACTIVE',
      graceEndsAt: null,
      lastGraceReminderStage: null,
    },
  });
  log.info('Invoice paid → ACTIVE', { billingId: billing.id });
  return { ok: true, billingId: billing.id };
}

export async function handleInvoicePaymentFailed(prisma: PrismaClient, event: any) {
  const invoice = event.data.object as any;
  const customerId =
    typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null;
  if (!customerId) return { ok: false };
  const billing = await resolveBilling(prisma, customerId, invoice.metadata);
  if (!billing) return { ok: false };
  const graceDays = Number(process.env.BILLING_GRACE_DAYS ?? '7');
  const graceEndsAt = new Date(Date.now() + graceDays * 24 * 60 * 60 * 1000);
  await prisma.workspaceBilling.update({
    where: { id: billing.id },
    data: {
      status: 'PAST_DUE',
      graceEndsAt,
      lastGraceReminderStage: null,
    },
  });
  log.info('Invoice payment failed → PAST_DUE (grace until)', {
    billingId: billing.id,
    graceEndsAt: graceEndsAt.toISOString(),
  });
  return { ok: true, billingId: billing.id };
}

/**
 * Dispatcher used by the router. Inserts the StripeWebhookEvent row for
 * idempotency BEFORE running the handler, then updates processedAt/error
 * after. The outer router wraps this in try/catch and returns 500 only on
 * truly unexpected errors — known cases (no billing row resolved, event we
 * don't care about) return 200 so Stripe stops retrying.
 */
export async function dispatchEvent(
  prisma: PrismaClient,
  event: any
): Promise<{ handled: boolean; error?: string }> {
  // Atomic dedupe-insert. If two webhook deliveries race, the second hits the
  // unique constraint and we treat it as a no-op.
  let eventRow;
  try {
    eventRow = await prisma.stripeWebhookEvent.create({
      data: {
        stripeEventId: event.id,
        type: event.type,
        payload: event as any,
      },
    });
  } catch (e: any) {
    if (e?.code === 'P2002') {
      log.info('Duplicate webhook event — already processed', { eventId: event.id });
      return { handled: true };
    }
    throw e;
  }

  let result: { ok: boolean; billingId?: string };
  let error: string | undefined;
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        result = await handleCheckoutCompleted(prisma, event);
        break;
      case 'customer.subscription.created':
        result = await handleSubscriptionCreated(prisma, event);
        break;
      case 'customer.subscription.updated':
        result = await handleSubscriptionUpdated(prisma, event);
        break;
      case 'customer.subscription.deleted':
        result = await handleSubscriptionDeleted(prisma, event);
        break;
      case 'invoice.paid':
        result = await handleInvoicePaid(prisma, event);
        break;
      case 'invoice.payment_failed':
        result = await handleInvoicePaymentFailed(prisma, event);
        break;
      default:
        // We accept-and-ignore events we didn't subscribe to (or future events).
        result = { ok: true };
    }
  } catch (e: any) {
    error = e?.message ?? String(e);
    log.error('Webhook handler threw', { eventId: event.id, type: event.type, error });
  }

  await prisma.stripeWebhookEvent.update({
    where: { id: eventRow.id },
    data: {
      processedAt: new Date(),
      workspaceBillingId: result!.billingId ?? null,
      error: error ?? null,
    },
  });

  return { handled: !error };
}
