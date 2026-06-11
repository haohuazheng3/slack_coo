import cron from 'node-cron';
import { WebClient } from '@slack/web-api';
import { prisma } from '../lib/prisma';
import { sendBillingDM, recordReminderSent, recordGraceReminderSent } from './notifier';
import { createLogger } from '../lib/logger';

const log = createLogger('Billing.Scheduler');

const BILLING_CRON = process.env.BILLING_SCHEDULER_CRON || '15 * * * *'; // hourly at :15

/**
 * Billing scheduler — runs hourly. Two responsibilities:
 *
 *   1. TRIAL STAGE PROGRESSION
 *      - TRIALING and trialEndsAt - now <= 3d, not yet EXPIRING_SOON sent → DM T-3d, mark stage.
 *      - TRIALING and trialEndsAt - now <= 1d, not yet FINAL_DAY sent → DM T-1d, mark stage.
 *      - TRIALING and trialEndsAt < now → flip status to UNPAID (we reuse the
 *        UNPAID-suspended gate path so feature-gating logic stays one switch);
 *        DM trial_expired; mark EXPIRED.
 *
 *   2. GRACE DUNNING + SUSPENSION
 *      - PAST_DUE and graceEndsAt < now → flip to UNPAID; DM suspended.
 *      - PAST_DUE and grace day 1 hit, not yet D1 sent → DM grace_d1.
 *      - PAST_DUE and grace day 4 hit → DM grace_d4.
 *      - PAST_DUE and grace day 7 (last day) hit → DM grace_d7.
 *
 * Resilient to being called twice in the same window: every action is guarded
 * by the lastTrialReminderStage / lastGraceReminderStage bookkeeping.
 */
export function startBillingScheduler(client: WebClient): void {
  if (!cron.validate(BILLING_CRON)) {
    log.warn(`Invalid BILLING_SCHEDULER_CRON: ${BILLING_CRON}, defaulting to "15 * * * *"`);
  }

  cron.schedule(cron.validate(BILLING_CRON) ? BILLING_CRON : '15 * * * *', () => {
    runBillingTick(client).catch((err) => {
      log.error('Billing tick failed', { error: err?.message ?? String(err) });
    });
  });

  log.info(`Billing scheduler started (cron: ${BILLING_CRON})`);
}

async function runBillingTick(client: WebClient): Promise<void> {
  const now = new Date();

  await advanceTrials(client, now);
  await advanceGrace(client, now);
}

async function advanceTrials(client: WebClient, now: Date): Promise<void> {
  const trialing = await prisma.workspaceBilling.findMany({
    where: { status: 'TRIALING' },
  });

  for (const billing of trialing) {
    if (!billing.trialEndsAt) continue;

    const msUntilEnd = billing.trialEndsAt.getTime() - now.getTime();
    const daysLeft = Math.ceil(msUntilEnd / 86400000);

    try {
      if (msUntilEnd < 0) {
        // Trial ended — flip to UNPAID-like state. We use the UNPAID enum so
        // featureGate's "not paid" branch fires (TRIALING+past-trial would
        // confuse it).
        await prisma.workspaceBilling.update({
          where: { id: billing.id },
          data: { status: 'UNPAID', lastTrialReminderStage: 'EXPIRED' },
        });
        if (billing.lastTrialReminderStage !== 'EXPIRED') {
          await sendBillingDM(client, { installationId: billing.installationId, kind: 'trial_expired' });
        }
        log.info('Trial expired → UNPAID', { installationId: billing.installationId });
      } else if (daysLeft <= 1 && billing.lastTrialReminderStage !== 'FINAL_DAY' && billing.lastTrialReminderStage !== 'EXPIRED') {
        await sendBillingDM(client, { installationId: billing.installationId, kind: 'trial_t1' });
        await recordReminderSent({ installationId: billing.installationId, stage: 'FINAL_DAY' });
      } else if (daysLeft <= 3 && !billing.lastTrialReminderStage) {
        await sendBillingDM(client, { installationId: billing.installationId, kind: 'trial_t3' });
        await recordReminderSent({ installationId: billing.installationId, stage: 'EXPIRING_SOON' });
      }
    } catch (err: any) {
      log.warn('advanceTrials per-row failed', {
        installationId: billing.installationId,
        error: err?.message ?? String(err),
      });
    }
  }
}

async function advanceGrace(client: WebClient, now: Date): Promise<void> {
  const pastDue = await prisma.workspaceBilling.findMany({
    where: { status: 'PAST_DUE' },
  });

  for (const billing of pastDue) {
    if (!billing.graceEndsAt) continue;

    const msUntilEnd = billing.graceEndsAt.getTime() - now.getTime();
    const daysLeft = Math.ceil(msUntilEnd / 86400000);
    const totalGraceDays = Number(process.env.BILLING_GRACE_DAYS ?? '7');
    const daysIntoGrace = totalGraceDays - daysLeft;

    try {
      if (msUntilEnd < 0) {
        await prisma.workspaceBilling.update({
          where: { id: billing.id },
          data: { status: 'UNPAID' },
        });
        await sendBillingDM(client, { installationId: billing.installationId, kind: 'suspended' });
        log.info('Grace expired → UNPAID', { installationId: billing.installationId });
      } else if (daysIntoGrace >= 7 && billing.lastGraceReminderStage !== 'D7') {
        await sendBillingDM(client, { installationId: billing.installationId, kind: 'grace_d7' });
        await recordGraceReminderSent({ installationId: billing.installationId, stage: 'D7' });
      } else if (daysIntoGrace >= 4 && billing.lastGraceReminderStage !== 'D4' && billing.lastGraceReminderStage !== 'D7') {
        await sendBillingDM(client, { installationId: billing.installationId, kind: 'grace_d4' });
        await recordGraceReminderSent({ installationId: billing.installationId, stage: 'D4' });
      } else if (daysIntoGrace >= 1 && !billing.lastGraceReminderStage) {
        await sendBillingDM(client, { installationId: billing.installationId, kind: 'grace_d1' });
        await recordGraceReminderSent({ installationId: billing.installationId, stage: 'D1' });
      }
    } catch (err: any) {
      log.warn('advanceGrace per-row failed', {
        installationId: billing.installationId,
        error: err?.message ?? String(err),
      });
    }
  }
}
