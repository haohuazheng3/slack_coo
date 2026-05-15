import cron from 'node-cron';
import { FunctionRegistry } from '../orchestrator/functionRegistry';
import { prisma } from '../lib/prisma';
import { getClientForTeam } from '../lib/slackClient';
import { createLogger } from '../lib/logger';
import { shouldNudgeTask } from './cadencePolicy';
import { refreshOwnerHome } from '../slack/taskCardUpdater';
import { conversationStore } from '../orchestrator/conversationStore';

const log = createLogger('ProgressCheck');

const ONE_HOUR_MS = 60 * 60 * 1000;
const NUDGE_CRON = process.env.PROGRESS_NUDGE_CRON || '*/10 * * * *';
const TIMEOUT_CRON = process.env.PROGRESS_TIMEOUT_CRON || '*/5 * * * *';
const CONVERSATION_TTL_CRON = '0 3 * * *';
const CONVERSATION_TTL_MS = 7 * 24 * ONE_HOUR_MS;

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

  cron.schedule(TIMEOUT_CRON, async () => {
    try {
      const now = Date.now();
      const stale = await prisma.task.findMany({
        where: {
          completed: false,
          status: { notIn: ['COMPLETED', 'CANCELLED', 'FAILED', 'PENDING_CLARIFICATION'] },
          progressPingSentAt: { not: null },
          progressAutoFailedAt: null,
        },
        take: 100,
      });

      for (const task of stale) {
        if (!task.progressPingSentAt) continue;
        const elapsed = now - task.progressPingSentAt.getTime();
        if (elapsed < ONE_HOUR_MS) continue;

        if (task.lastProgressAt && task.lastProgressAt.getTime() > task.progressPingSentAt.getTime()) {
          await prisma.task.update({
            where: { id: task.id },
            data: { progressAutoFailedAt: null, progressPingSentAt: null },
          });
          continue;
        }

        try {
          await prisma.task.update({
            where: { id: task.id },
            data: {
              status: 'BLOCKED',
              notCompletedReason: 'No response within 1 hour of progress check.',
              notCompletedReasonAt: new Date(),
              progressAutoFailedAt: new Date(),
              lastProgressSummary: 'No response within 1 hour of progress check (auto-marked).',
              lastProgressAt: new Date(),
            },
          });
          await prisma.progressUpdate.create({
            data: {
              taskId: task.id,
              source: 'auto_timeout',
              summary: 'No response within 1 hour of progress check (auto-marked BLOCKED).',
              statusAtTime: 'BLOCKED',
              progressPercent: task.progressPercent,
            },
          });

          const slackClient = await getClientForTeam(task.teamId, task.enterpriseId);
          if (!slackClient) {
            log.warn('No client for timeout notification', { taskId: task.id });
            continue;
          }

          try {
            const dm = await slackClient.conversations.open({ users: task.assignee });
            const dmChannel = (dm as any).channel?.id || task.assignee;
            await slackClient.chat.postMessage({
              channel: dmChannel,
              text: `⏰ Progress check timed out for *${task.title}* (due ${task.time.toLocaleString()}). I have marked it BLOCKED and notified the owner. Reply here when you have an update.`,
            });
          } catch (err) {
            log.warn('Failed to notify assignee on timeout', { taskId: task.id, error: String(err) });
          }

          const ownerId = task.initiator || task.createdBy;
          if (ownerId) {
            try {
              const dm = await slackClient.conversations.open({ users: ownerId });
              const dmChannel = (dm as any).channel?.id || ownerId;
              await slackClient.chat.postMessage({
                channel: dmChannel,
                text: `⚠️ *${task.title}* — no response from <@${task.assignee}> within 1 hour. Marked BLOCKED.`,
              });
              refreshOwnerHome(slackClient, ownerId).catch(() => undefined);
            } catch (err) {
              log.warn('Failed to notify owner on timeout', { taskId: task.id, error: String(err) });
            }
          }
        } catch (err) {
          log.error('Failed to auto-mark BLOCKED', { taskId: task.id, error: String(err) });
        }
      }
    } catch (err) {
      log.error('Timeout scheduler tick failed', { error: String(err) });
    }
  });

  cron.schedule(CONVERSATION_TTL_CRON, () => {
    const evicted = conversationStore.evictStale(CONVERSATION_TTL_MS);
    if (evicted > 0) log.info('Evicted stale conversations', { count: evicted });
  });

  log.info('Progress scheduler started', {
    nudgeCron: NUDGE_CRON,
    timeoutCron: TIMEOUT_CRON,
  });
}
