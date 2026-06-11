import { prisma } from '../lib/prisma';

export type GateReason =
  | 'founding' // grandfathered beta workspace — lifetime free
  | 'trialing' // inside trial window
  | 'active' // paying subscriber
  | 'grace' // PAST_DUE but within graceEndsAt
  | 'cancelled_active' // cancelled but accessUntil > now
  | 'expired' // trial ended, no payment
  | 'suspended' // grace expired or subscription deleted
  | 'no_billing_row' // workspace never created a billing row (open access pre-launch)
  | 'billing_disabled'; // STRIPE_SECRET_KEY missing — billing not configured

export type GateResult = {
  paid: boolean;
  reason: GateReason;
  /** When the current state ends (trial end / grace end / period end). null if not time-bound. */
  expiresAt: Date | null;
  isGrandfathered: boolean;
};

/**
 * Single source of truth for "can this workspace use Aiptima right now?".
 * Consulted by: orchestrator (write-tool gate), ambientGate (channel engagement),
 * progressCheck scheduler (whether to fire cron actions), Home view (banner
 * rendering), dashboard (read-only mode).
 *
 * Default-permissive policy: if billing isn't configured (no STRIPE_SECRET_KEY)
 * OR no WorkspaceBilling row exists yet, return paid=true. This means deploying
 * the billing code without filling env vars / running the backfill does NOT
 * lock anyone out — gating starts only when explicitly configured. Safe rollout.
 *
 * Once a row exists, the precedence is:
 *   1. isGrandfathered=true on installation → founding (paid forever)
 *   2. status === ACTIVE → active
 *   3. status === TRIALING and trialEndsAt > now → trialing
 *   4. status === PAST_DUE and graceEndsAt > now → grace (still paid)
 *   5. status === CANCELED and accessUntil > now → cancelled_active (still paid)
 *   6. Anything else (TRIALING+past trial, PAST_DUE+past grace, UNPAID, CANCELED+past access) → not paid
 */
export async function isWorkspacePaid(args: {
  teamId: string | null;
  enterpriseId: string | null;
}): Promise<GateResult> {
  // Billing isn't configured — every workspace is paid by default.
  if (!process.env.STRIPE_SECRET_KEY) {
    return { paid: true, reason: 'billing_disabled', expiresAt: null, isGrandfathered: false };
  }

  const install = await prisma.slackInstallation.findFirst({
    where: { teamId: args.teamId, enterpriseId: args.enterpriseId },
    include: { billing: true },
  });

  // No install row at all — also default-permissive. This shouldn't normally
  // happen (every running bot comes from an install) but if it does, refusing
  // service is worse than the alternative.
  if (!install) {
    return { paid: true, reason: 'no_billing_row', expiresAt: null, isGrandfathered: false };
  }

  // Grandfathered (founding workspace) — always paid, no checks.
  if (install.isGrandfathered) {
    return { paid: true, reason: 'founding', expiresAt: null, isGrandfathered: true };
  }

  const billing = install.billing;
  if (!billing) {
    // No billing row created yet → safe-default paid (typically means the
    // OAuth callback hasn't fired the trial-start path, e.g. legacy pre-launch
    // installs that aren't grandfathered).
    return { paid: true, reason: 'no_billing_row', expiresAt: null, isGrandfathered: false };
  }

  const now = new Date();

  if (billing.status === 'ACTIVE') {
    return { paid: true, reason: 'active', expiresAt: billing.currentPeriodEnd, isGrandfathered: false };
  }

  if (billing.status === 'TRIALING' && billing.trialEndsAt && billing.trialEndsAt > now) {
    return { paid: true, reason: 'trialing', expiresAt: billing.trialEndsAt, isGrandfathered: false };
  }

  if (billing.status === 'PAST_DUE' && billing.graceEndsAt && billing.graceEndsAt > now) {
    return { paid: true, reason: 'grace', expiresAt: billing.graceEndsAt, isGrandfathered: false };
  }

  if (billing.status === 'CANCELED' && billing.accessUntil && billing.accessUntil > now) {
    return { paid: true, reason: 'cancelled_active', expiresAt: billing.accessUntil, isGrandfathered: false };
  }

  // Trial expired without payment, grace expired, subscription deleted — gated.
  const reason: GateReason =
    billing.status === 'TRIALING' ? 'expired' : 'suspended';
  return { paid: false, reason, expiresAt: null, isGrandfathered: false };
}

/**
 * Convenience: "is this workspace gated right now?". Inverse of isWorkspacePaid
 * for the call sites that just want a boolean (ambient gate, scheduler filter).
 */
export async function isWorkspaceGated(args: {
  teamId: string | null;
  enterpriseId: string | null;
}): Promise<boolean> {
  const result = await isWorkspacePaid(args);
  return !result.paid;
}
