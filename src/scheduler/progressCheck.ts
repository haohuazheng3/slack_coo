import cron from 'node-cron';
import { FunctionRegistry } from '../orchestrator/functionRegistry';
import { prisma } from '../lib/prisma';
import { getClientForTeam } from '../lib/slackClient';
import { createLogger } from '../lib/logger';
import { shouldNudgeTask } from './cadencePolicy';
import { refreshOwnerHome } from '../slack/taskCardUpdater';
import { conversationStore } from '../orchestrator/conversationStore';
import { resolveSilencePolicy } from './reminderPolicy';

const log = createLogger('ProgressCheck');

const ONE_HOUR_MS = 60 * 60 * 1000;
const NUDGE_CRON = process.env.PROGRESS_NUDGE_CRON || '*/10 * * * *';
const SILENCE_CRON = process.env.PROGRESS_SILENCE_CRON || '*/5 * * * *';
const CONVERSATION_TTL_CRON = '0 3 * * *';
const CONVERSATION_TTL_MS = 7 * 24 * ONE_HOUR_MS;

// Re-alert cooldown so we don't spam the owner about the same silence window.
const SILENCE_RE_ALERT_COOLDOWN_MS = Number(
  process.env.SILENCE_RE_ALERT_COOLDOWN_MS ?? `${6 * ONE_HOUR_MS}`
);

export function startProgressCheckScheduler(_registry: FunctionRegistry) {
  cron.schedule(NUDGE_CRON, async () => {
    try {
      const candidates = await prisma.task.findMany({
        where: {
          completed: false,
          status: { notIn: ['COMPLETED', 'CANCELLED', 'PENDING_CLARIFICATION'] },
        },
        take: 200,
      });

      for (const task of candidates) {
        const decision = shouldNudgeTask(task);
        if (!decision.shouldNudge) continue;

        const slackClient = await getClientForTeam(task.teamId, task.enterpriseId);
        if (!slackClient) {
          log.warn('No client for task team', { taskId: task.id, teamId: task.teamId });
          continue;
        }

        const { nudgeProgressFunction } = await import('../functions/nudgeProgress');
        const fn = nudgeProgressFunction();
        try {
          await fn.handler(
            { taskId: task.id, reason: decision.reason },
            {
              prisma,
              slack: {
                client: slackClient,
                channelId: task.channelId,
                userId: task.assignee,
                rawText: '',
                threadTs: undefined,
                teamId: task.teamId,
                enterpriseId: task.enterpriseId,
                send: async () => {

                },
              },
            }
          );
          log.info('Nudged via scheduler', { taskId: task.id, reason: decision.reason });
        } catch (err) {
          log.error('Failed to nudge', { taskId: task.id, error: String(err) });
        }
      }
    } catch (err) {
      log.error('Nudge scheduler tick failed', { error: String(err) });
    }
  });

  // Silence surfacing — per product brief §2.5 (the sharpest mechanism in the product).
  //
  // RED LINE #1: facts only, never judgment.
  //   - We do NOT change task status to BLOCKED / FAILED on silence.
  //   - We do NOT write any owner-facing characterization of the employee.
  //   - We surface ONE fact-only message to the owner ("X hours since last reply, deadline is Y,
  //     last known status was Z") and hand the decision back ("want me to nudge, or will you?").
  //
  // RED LINE #5: silence reporting is a scalpel, not a hammer. We apply a per-priority
  // threshold (see reminderPolicy) and a cooldown (SILENCE_RE_ALERT_COOLDOWN_MS) so the
  // owner is not drowned in "no reply" pings.
  cron.schedule(SILENCE_CRON, async () => {
    try {
      const now = Date.now();
      const candidates = await prisma.task.findMany({
        where: {
          completed: false,
          status: { notIn: ['COMPLETED', 'CANCELLED', 'PENDING_CLARIFICATION'] },
          progressPingSentAt: { not: null },
        },
        take: 200,
      });

      for (const task of candidates) {
        if (!task.progressPingSentAt) continue;

        // If the employee already replied since we last pinged, clear the timer and move on.
        if (
          task.lastProgressAt &&
          task.lastProgressAt.getTime() > task.progressPingSentAt.getTime()
        ) {
          await prisma.task.update({
            where: { id: task.id },
            data: { progressPingSentAt: null, lastSilenceAlertAt: null },
          });
          continue;
        }

        const silenceMs = now - task.progressPingSentAt.getTime();
        const policy = resolveSilencePolicy(task.priority);
        if (silenceMs < policy.surfaceAfterMs) continue;

        // Cooldown: don't re-alert on the same silence window.
        if (
          task.lastSilenceAlertAt &&
          now - task.lastSilenceAlertAt.getTime() < SILENCE_RE_ALERT_COOLDOWN_MS
        ) {
          continue;
        }

        const slackClient = await getClientForTeam(task.teamId, task.enterpriseId);
        if (!slackClient) {
          log.warn('No client for silence alert', { taskId: task.id });
          continue;
        }

        const ownerId = task.initiator || task.createdBy;
        if (!ownerId) continue;

        try {
          const dm = await slackClient.conversations.open({ users: ownerId });
          const dmChannel = (dm as any).channel?.id || ownerId;

          const hoursSilent = Math.floor(silenceMs / ONE_HOUR_MS);
          const silentText =
            hoursSilent >= 24
              ? `${Math.floor(hoursSilent / 24)} day(s)`
              : hoursSilent >= 1
                ? `${hoursSilent} hour(s)`
                : `${Math.floor(silenceMs / (60 * 1000))} min`;

          const dueDelta = task.time.getTime() - now;
          const dueText =
            dueDelta > 0
              ? `due in ${Math.max(1, Math.floor(dueDelta / ONE_HOUR_MS))}h (${task.time.toLocaleString()})`
              : `was due ${task.time.toLocaleString()}`;

          const lastSync = task.lastProgressSummary
            ? `"${task.lastProgressSummary}"`
            : `no prior status on record`;

          // Pure facts. No "concerning", no "slow", no judgment.
          await slackClient.chat.postMessage({
            channel: dmChannel,
            text: `Heads up on "${task.title}" — ${silentText} since I last heard from <@${task.assignee}>.`,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: [
                    `⏳ *${task.title}*`,
                    `• Assignee: <@${task.assignee}>`,
                    `• Deadline: ${dueText}`,
                    `• Silent for: ${silentText} (since my last check-in)`,
                    `• Last known status: ${lastSync}`,
                    ``,
                    `I don't have new info. Want me to nudge them, or would you rather reach out yourself?`,
                  ].join('\n'),
                },
              },
              {
                type: 'actions',
                elements: [
                  {
                    type: 'button',
                    text: { type: 'plain_text', text: 'Nudge them for me' },
                    style: 'primary',
                    action_id: 'silence_nudge_assignee',
                    value: task.id,
                  },
                  {
                    type: 'button',
                    text: { type: 'plain_text', text: `I'll handle it` },
                    action_id: 'silence_owner_handles',
                    value: task.id,
                  },
                ],
              },
            ],
          });

          await prisma.task.update({
            where: { id: task.id },
            data: { lastSilenceAlertAt: new Date() },
          });

          // Audit trail — store the fact we surfaced silence, not an interpretation of it.
          await prisma.progressUpdate.create({
            data: {
              taskId: task.id,
              source: 'system',
              summary: `Surfaced silence to owner: ${silentText} since last check-in.`,
              statusAtTime: task.status,
              progressPercent: task.progressPercent,
            },
          });

          refreshOwnerHome(slackClient, ownerId).catch(() => undefined);

          log.info('Silence surfaced to owner', { taskId: task.id, silenceMs });
        } catch (err) {
          log.error('Failed to surface silence', { taskId: task.id, error: String(err) });
        }
      }
    } catch (err) {
      log.error('Silence scheduler tick failed', { error: String(err) });
    }
  });

  cron.schedule(CONVERSATION_TTL_CRON, () => {
    const evicted = conversationStore.evictStale(CONVERSATION_TTL_MS);
    if (evicted > 0) log.info('Evicted stale conversations', { count: evicted });
  });

  log.info('Progress scheduler started', {
    nudgeCron: NUDGE_CRON,
    silenceCron: SILENCE_CRON,
  });
}
